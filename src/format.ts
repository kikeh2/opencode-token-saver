/**
 * Feature 2: formateo real post-write/edit.
 *
 * El punto es no gastar tokens alineando indentación: el modelo escribe su
 * mejor bloque y un formatter externo (prettier, black, gofmt...) deja el
 * archivo prolijo sin que el modelo tenga que regenerar nada por una sangría
 * mal puesta.
 *
 * Reglas:
 * - El comando se busca por extensión en config.formatters; sin entrada, no
 *   se hace nada (cero costo).
 * - "$FILE" se reemplaza por la ruta real del archivo.
 * - Se corre con el Bun Shell ($) interpolando cada token como argumento
 *   seguro: la interpolación de strings va escapada de fábrica, y un array
 *   interpolado se expande como argumentos separados sin riesgo de inyección.
 * - Uso .nothrow().quiet() para que un fallo (formatter no instalado, exit
 *   code != 0...) solo genere un warning y NUNCA rompa el flujo del tool.
 */
import { $ } from "bun"
import { dirname, extname } from "node:path"
import type { TokenSaverConfig } from "./config"

const FILE_PLACEHOLDER = "$FILE"

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Últimas líneas de stderr, para el warning (sin inundar el log). */
function stderrTail(buffer: Buffer): string {
  return buffer
    .toString()
    .trim()
    .split("\n")
    .slice(-2)
    .join(" / ")
}

/** Binarios de formatter permitidos. Cualquier otro binario en el config
 *  se ignora con un warning: evita ejecución arbitraria vía token-saver.jsonc. */
const ALLOWED_FORMATTER_BINS = new Set(["prettier", "black", "gofmt", "bunx"])

/** Paquetes permitidos cuando el binario es un wrapper (bunx/npx). El primer
 *  argumento después del binario debe estar aquí, de lo contrario se rechaza
 *  el comando: evita ejecutar cualquier paquete de npm vía el config. */
const ALLOWED_FORMATTER_PACKAGES = new Set(["prettier"])

/**
 * Corre el formatter configurado para la extensión del archivo editado.
 * Nunca lanza: cualquier falla termina en un console.warn.
 */
export async function formatFile(filePath: string, config: TokenSaverConfig): Promise<void> {
  const ext = extname(filePath).toLowerCase()
  const command = config.formatters[ext]
  if (command === undefined || command.length === 0) return

  const filled = command.map((part) => (part === FILE_PLACEHOLDER ? filePath : part))
  if (!filled.includes(filePath)) {
    // Si el usuario no puso "$FILE" en el comando, un archivo adicional va
    // de último argumento: así un mínimo comando del tipo ["gofmt", "-w"] funciona.
    filled.push(filePath)
  }
  const [bin, ...args] = filled
  if (bin === undefined) return

  // Allowlist de binarios: solo ejecutamos comandos que ya conocemos.
  if (!ALLOWED_FORMATTER_BINS.has(bin)) {
    console.warn(
      `[token-saver] formatter "${bin}" no está en la allowlist de binarios permitidos ` +
        `(${Array.from(ALLOWED_FORMATTER_BINS).join(", ")}). ` +
        `Ignorando el comando configurado para "${ext}" en .opencode/token-saver.jsonc.`,
    )
    return
  }

  // Si el binario es un wrapper de paquetes (bunx/npx), el paquete que
  // ejecuta también tiene que estar en su propia allowlist, para evitar
  // que el config dispare cualquier paquete de npm.
  if ((bin === "bunx" || bin === "npx") && args.length > 0) {
    const pkg = args[0]
    if (pkg === undefined || !ALLOWED_FORMATTER_PACKAGES.has(pkg)) {
      console.warn(
        `[token-saver] el paquete "${pkg ?? "(desconocido)"}" de "${bin}" no está en la allowlist de paquetes permitidos ` +
          `(${Array.from(ALLOWED_FORMATTER_PACKAGES).join(", ")}). ` +
          `Ignorando el comando configurado para "${ext}" en .opencode/token-saver.jsonc.`,
      )
      return
    }
  }

  // Capturamos el mtime antes de correr el formatter para detectar si el
  // archivo fue modificado aunque el comando salga con error (posible corrupción).
  const { stat } = await import("node:fs/promises")
  let mtimeBefore: number | undefined
  try {
    const statsBefore = await stat(filePath)
    mtimeBefore = statsBefore.mtimeMs
  } catch {
    // Si el archivo no existe aún, no hay nada que comparar.
  }

  try {
    const proc = await $`${bin} ${args}`
      .nothrow()
      .quiet()
      // Cwd en la carpeta del archivo: los formatters descubren su config
      // (.prettierrc, pyproject.toml...) hacia arriba, igual que haría el usuario.
      .cwd(dirname(filePath))

    if (proc.exitCode !== 0) {
      const tail = stderrTail(proc.stderr)
      let note = ""
      if (mtimeBefore !== undefined) {
        try {
          const statsAfter = await stat(filePath)
          if (statsAfter.mtimeMs !== mtimeBefore) {
            note = " ADVERTENCIA: el archivo fue modificado aunque el formatter salió con error; puede estar corrupto."
          }
        } catch {
          // No se pudo re-stat; seguimos sin nota adicional.
        }
      }
      console.warn(
        `[token-saver] formatter "${bin}" salió con código ${proc.exitCode} para "${ext}"` +
          `${tail === "" ? "" : `: ${tail}`}${note}. Sigo sin formatear; revisá el comando en .opencode/token-saver.jsonc.`,
      )
      return
    }

    console.log(`[token-saver] formatter "${bin}" ok en "${filePath}".`)
  } catch (error) {
    console.warn(
      `[token-saver] no pude correr el formatter "${bin}" para "${ext}": ` +
        `${errorMessage(error)}. Sigo sin romper el flujo.`,
    )
  }
}
