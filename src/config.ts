/**
 * Config de token-saver: lee `.opencode/token-saver.jsonc`.
 *
 * Reglas:
 * - El archivo admite JSONC (comentarios de línea "//" y de bloque C-style).
 * - Si falta el archivo, se crea con los defaults. Nunca tira error por eso.
 * - Si el archivo existe pero es inválido, se loguea un warning y se usan los
 *   defaults sin sobreescribir el archivo del usuario.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export interface TokenSaverConfig {
  trimWhitespace: boolean
  formatOnEdit: boolean
  dedupeReads: boolean
  alwaysProtectedFiles: string[]
  formatters: Record<string, string[]>
}

export const DEFAULT_CONFIG: TokenSaverConfig = {
  trimWhitespace: true,
  formatOnEdit: true,
  dedupeReads: true,
  alwaysProtectedFiles: ["AGENTS.md", "CLAUDE.md", "SKILL.md"],
  formatters: {
    ".ts": ["bunx", "prettier", "--write", "$FILE"],
    ".tsx": ["bunx", "prettier", "--write", "$FILE"],
    ".js": ["bunx", "prettier", "--write", "$FILE"],
    ".py": ["black", "$FILE"],
    ".go": ["gofmt", "-w", "$FILE"],
  },
}

/** Contenido con el que se crea el archivo la primera vez. */
export const DEFAULT_CONFIG_JSONC = `// token-saver: reduce el consumo de tokens de este proyecto.
// El plugin vive en .opencode/plugin/token-saver/ y se carga solo; este archivo
// se creó automáticamente la primera vez que corrió.
{
  // Recorta espacios/tabs al final de línea y colapsa 3+ líneas vacías seguidas
  // a una sola antes de aplicar write/edit. No toca la indentación.
  "trimWhitespace": true,

  // Corre el formatter correspondiente después de cada write/edit: el modelo
  // escribe y el formatter deja la indentación prolija sin que el modelo tenga
  // que regenerar el bloque entero por una sangría mal puesta.
  "formatOnEdit": true,

  // Bloquea el read de archivos ya leídos en esta sesión y sin cambios,
  // devolviendo un mensaje corto en lugar de todo el contenido de nuevo.
  "dedupeReads": true,

  // Basenames que nunca conviene releer en la misma sesión (guías del agente).
  "alwaysProtectedFiles": ["AGENTS.md", "CLAUDE.md", "SKILL.md"],

  // Formatter por extensión de archivo; "$FILE" se reemplaza por la ruta real.
  // Quitá una entrada para no formatear ese tipo de archivo.
  "formatters": {
    ".ts": ["bunx", "prettier", "--write", "$FILE"],
    ".tsx": ["bunx", "prettier", "--write", "$FILE"],
    ".js": ["bunx", "prettier", "--write", "$FILE"],
    ".py": ["black", "$FILE"],
    ".go": ["gofmt", "-w", "$FILE"]
  }
}
`

/**
 * Directorio `.opencode/` que contiene este plugin: el config vive ahí,
 * independientemente del directorio de la sesión que lo cargó.
 */
export function configDirectory(): string {
  // `../..` desde el archivo de este módulo (.opencode/plugin/token-saver/).
  return resolve(fileURLToPath(new URL("../../", import.meta.url)))
}

/** Ruta del config: `<.opencode>/token-saver.jsonc`. */
export function configPath(): string {
  return resolve(configDirectory(), "token-saver.jsonc")
}

/** Quita comentarios y trailing commas dejando JSON parseble. */
export function stripJsoncComments(source: string): string {
  const out: string[] = []
  let i = 0
  let quote: '"' | "'" | undefined // JSON solo usa '"', pero tolero ambos.

  while (i < source.length) {
    const c = source[i]
    if (c === undefined) break
    const next = i + 1 < source.length ? source[i + 1] : undefined

    if (quote !== undefined) {
      out.push(c)
      if (c === "\\" && next !== undefined) {
        out.push(next)
        i += 2
        continue
      }
      if (c === quote) quote = undefined
      i++
      continue
    }

    if (c === '"' || c === "'") {
      quote = c
      out.push(c)
      i++
      continue
    }

    // Comentario de línea: saltar hasta el fin de la línea.
    if (c === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i++
      continue
    }
    // Comentario de bloque: saltar hasta el cierre.
    if (c === "/" && next === "*") {
      i += 2
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i++
      i += 2
      continue
    }

    out.push(c)
    i++
  }

  return out.join("").replace(/,(\s*[}\]])/g, "$1")
}

export function parseJsonc<T = unknown>(source: string): T {
  return JSON.parse(stripJsoncComments(source)) as T
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

/** Normaliza la key de un formatter a forma ".ext" minúscula. */
function normalizeExtKey(key: string): string {
  const trimmed = key.trim().toLowerCase()
  return trimmed.startsWith(".") ? trimmed : `.${trimmed}`
}

/** Merge tolerante: cada campo inválido cae a su valor default. */
export function normalizeConfig(value: unknown): TokenSaverConfig {
  const raw = isRecord(value) ? value : {}
  const config = freshDefaults()

  if (typeof raw.trimWhitespace === "boolean") config.trimWhitespace = raw.trimWhitespace
  if (typeof raw.formatOnEdit === "boolean") config.formatOnEdit = raw.formatOnEdit
  if (typeof raw.dedupeReads === "boolean") config.dedupeReads = raw.dedupeReads
  if (isStringArray(raw.alwaysProtectedFiles)) config.alwaysProtectedFiles = raw.alwaysProtectedFiles

  if (isRecord(raw.formatters)) {
    for (const [key, command] of Object.entries(raw.formatters)) {
      if (isStringArray(command) && command.length > 0) {
        config.formatters[normalizeExtKey(key)] = command
      } else {
        console.warn(`[token-saver] formatter inválido en el config para "${key}"; lo ignoré.`)
      }
    }
  }

  return config
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && (error as { code?: unknown }).code === "ENOENT"
}

/** Defaults frescos (copia, para que mutar el formatters no pise el BASE). */
function freshDefaults(): TokenSaverConfig {
  return {
    ...DEFAULT_CONFIG,
    formatters: { ...DEFAULT_CONFIG.formatters },
  }
}

async function createDefaultConfigFile(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, DEFAULT_CONFIG_JSONC, "utf8")
  console.log(`[token-saver] no existía "${path}"; lo creé con los defaults.`)
}

/**
 * Carga el config del path dado. Si falta, crea el archivo default una vez.
 * Si está corrupto, avisa y sigue con los defaults (nunca explota el server).
 */
export async function loadConfig(path: string = configPath()): Promise<TokenSaverConfig> {
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch (error) {
    if (isMissingFile(error)) {
      try {
        await createDefaultConfigFile(path)
      } catch (createError) {
        console.warn(
          `[token-saver] no pude crear el config default en "${path}": ` +
            `${createError instanceof Error ? createError.message : String(createError)}; uso defaults.`,
        )
      }
      return freshDefaults()
    }
    console.warn(`[token-saver] no pude leer "${path}"; uso defaults.`)
    return freshDefaults()
  }

  try {
    return normalizeConfig(parseJsonc(raw))
  } catch (error) {
    console.warn(
      `[token-saver] "${path}" es JSONC inválido ` +
        `(${error instanceof Error ? error.message : String(error)}); uso defaults sin pisarlo.`,
    )
    return freshDefaults()
  }
}
