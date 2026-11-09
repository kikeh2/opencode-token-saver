/**
 * token-saver: plugin de OpenCode para gastar menos tokens.
 *
 * API usada (v2, paquete @opencode/plugin):
 * - `ctx.tool.hook("execute.before")` → equivale al hook v1 "tool.execute.before":
 *   corre ANTES de que el tool se ejecute y recibe el evento con `event.input`.
 * - `ctx.tool.hook("execute.after")` → equivale a "tool.execute.after":
 *   corre DESPUÉS, con `event.status` en "completed" o "error".
 *
 * Los tres features son independientes y cada uno se apaga desde el config
 * (.opencode/token-saver.jsonc). Solo atiende los tools "edit", "write" y
 * "read"; cualquier otro tool pasa de largo y sigue su curso normal.
 */
import { Plugin } from "@opencode/plugin"
import { isAbsolute, resolve, relative } from "node:path"
import { configPath, loadConfig, type TokenSaverConfig } from "./config"
import { trimEditString, trimWriteContent } from "./whitespace"
import { formatFile } from "./format"
import { assertFreshRead, recordRead, statFile } from "./dedupe-read"

/** Args crudos de cualquier tool: objeto con claves libres. */
type ToolArgs = Record<string, unknown>

/** Narrow de `event.input` (unknown) a args de tool, sin `any`. */
function asArgs(value: unknown): ToolArgs | undefined {
  return typeof value === "object" && value !== null ? (value as ToolArgs) : undefined
}

/** Lee un campo string no vacío de los args del tool. */
function getStringArg(args: ToolArgs | undefined, field: string): string | undefined {
  const value = args?.[field]
  return typeof value === "string" && value.trim() !== "" ? value : undefined
}

export default Plugin.define({
  id: "token-saver",
  async setup(ctx) {
    const config = await loadConfig(configPath())

    const projectDir = ctx.location.directory
    /**
     * Resuelve la ruta del tool y verifica que quede dentro del directorio del
     * proyecto. Devuelve null si el path escaparía (path traversal o symlink
     * hacia fuera), para no hacer stat/cache de archivos ajenos.
     */
    const canonicalPath = (filePath: string): string | null => {
      const resolved = isAbsolute(filePath) ? filePath : resolve(projectDir, filePath)
      const rel = relative(projectDir, resolved)
      if (rel === null || rel.startsWith("..") || rel.startsWith("/")) return null
      return resolved
    }

    if (config.trimWhitespace) {
      // FEATURE 1 — trim de whitespace antes de write/edit.
      // Por qué: el modelo malgasta tokens escribiendo trailing spaces o
      // montañas de líneas en blanco. Recortar acá es bytes del archivo,
      // no de la respuesta del modelo.
      await ctx.tool.hook("execute.before", (event) => {
        if (event.tool !== "write" && event.tool !== "edit") return
        const args = asArgs(event.input)
        if (args === undefined) return

        // write: el contenido es el archivo entero, así que además cierro
        // garantizando exactamente un salto final.
        if (event.tool === "write" && typeof args.content === "string") {
          const trimmed = trimWriteContent(args.content)
          if (trimmed !== args.content) {
            // "input" del evento es mutable: editar acá cambia lo que el
            // tool real va a escribir. Los demás campos van sin copiar.
            event.input = { ...args, content: trimmed }
            const saved = args.content.length - trimmed.length
            console.log(
              `[token-saver] write: recorté ${saved} chars de whitespace${typeof args.filePath === "string" ? ` en "${args.filePath}"` : ""}.`,
            )
          }
        }

        // edit: solo newString. El oldString NO se toca: tiene que matchear
        // el archivo real letra por letra, y cualquier cambio lo haría
        // fallar el edit al no encontrar el texto.
        if (event.tool === "edit" && typeof args.newString === "string") {
          const trimmed = trimEditString(args.newString)
          if (trimmed !== args.newString) {
            event.input = { ...args, newString: trimmed }
          }
        }
      })
    }

    if (config.formatOnEdit) {
      // FEATURE 2 — formatter real después de write/edit.
      // Por qué: acá se decide la indentación final. El modelo escribe lo
      // mejor que puede y el formatter hace la prolijidad, sin que el LLM
      // tenga que regenerar el bloque entero por una sangría mal puesta.
      await ctx.tool.hook("execute.after", async (event) => {
        if (event.status !== "completed") return
        if (event.tool !== "write" && event.tool !== "edit") return
        const filePath = getStringArg(asArgs(event.input), "filePath")
        if (filePath === undefined) return
        const resolved = canonicalPath(filePath)
        if (resolved === null) return
        await formatFile(resolved, config)
      })
    }

    if (config.dedupeReads) {
      // FEATURE 3a — antes de un read: bloquear relecturas inútiles.
      // Por qué: un read repetido vuelve a meter el archivo entero en el
      // contexto. Con stat() (mtime + size, rapidísimo, sin leer contenido)
      // me doy cuenta de si ya lo tenemos vivo para tirar el throw corto.
      await ctx.tool.hook("execute.before", async (event) => {
        if (event.tool !== "read") return
        const filePath = getStringArg(asArgs(event.input), "filePath")
        if (filePath === undefined) return
        const resolved = canonicalPath(filePath)
        if (resolved === null) return

        const info = await statFile(resolved)
        if (info === undefined) return // no existe: el read va a fallar por derecho propio
        assertFreshRead(config, event.sessionID, resolved, info)
      })

      // FEATURE 3b — después de un read exitoso: registrar mtime nuevo.
      await ctx.tool.hook("execute.after", async (event) => {
        if (event.status !== "completed" || event.tool !== "read") return
        const filePath = getStringArg(asArgs(event.input), "filePath")
        if (filePath === undefined) return
        const resolved = canonicalPath(filePath)
        if (resolved === null) return
        const info = await statFile(resolved)
        recordRead(event.sessionID, resolved, info)
      })
    }

    // Las registrations viven mientras el plugin esté cargado; no hace falta
    // dispose ahora. Si el plugin se descarga, OpenCode las libera solo.
  },
})
