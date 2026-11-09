/**
 * token-saver config: reads `.opencode/token-saver.jsonc`.
 *
 * Rules:
 * - The file supports JSONC (line comments "//" and block C-style).
 * - If missing, it's created with defaults. Never throws error for that.
 * - If file exists but is invalid, a warning is logged and defaults are
 *   used without overwriting the user's file.
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

/** Content used to create the file the first time. */
export const DEFAULT_CONFIG_JSONC = `// token-saver: reduces token consumption of this project.
// The plugin lives in .opencode/plugin/token-saver/ and loads alone; this file
// was created automatically the first time it ran.
{
  // Trims spaces/tabs at end of line and collapses 3+ consecutive blank lines
  // to one before applying write/edit. Does not touch indentation.
  "trimWhitespace": true,

  // Runs corresponding formatter after each write/edit: the model
  // writes and formatter leaves indentation clean so the model doesn't
  // have to regenerate the whole block over a misplaced indent.
  "formatOnEdit": true,

  // Blocks read of already read files in this session without changes,
  // returning a short message instead of all the content again.
  "dedupeReads": true,

  // Basenames never worth re-reading in same session (agent guides).
  "alwaysProtectedFiles": ["AGENTS.md", "CLAUDE.md", "SKILL.md"],

  // Formatter by file extension; "$FILE" is replaced by real path.
  // Remove an entry to not format that file type.
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
 * `.opencode/` directory containing this plugin: config lives there,
 * independently of the session directory that loaded it.
 */
export function configDirectory(): string {
  // `../..` from this module file (.opencode/plugin/token-saver/).
  return resolve(fileURLToPath(new URL("../../", import.meta.url)))
}

/** Config path: `<.opencode>/token-saver.jsonc`. */
export function configPath(): string {
  return resolve(configDirectory(), "token-saver.jsonc")
}

/** Removes comments and trailing commas leaving parseable JSON. */
export function stripJsoncComments(source: string): string {
  const out: string[] = []
  let i = 0
  let quote: '"' | "'" | undefined // JSON only uses '"', but I tolerate both.

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

    // Line comment: skip to end of line.
    if (c === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i++
      continue
    }
    // Block comment: skip to closing.
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

/** Normalizes formatter key to ".ext" lowercase form. */
function normalizeExtKey(key: string): string {
  const trimmed = key.trim().toLowerCase()
  return trimmed.startsWith(".") ? trimmed : `.${trimmed}`
}

/** Tolerant merge: each invalid field falls back to default. */
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
        console.warn(`[token-saver] invalid formatter in config for "${key}"; ignored.`)
      }
    }
  }

  return config
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && (error as { code?: unknown }).code === "ENOENT"
}

/** Fresh defaults (copy so mutating formatters doesn't overwrite base). */
function freshDefaults(): TokenSaverConfig {
  return {
    ...DEFAULT_CONFIG,
    formatters: { ...DEFAULT_CONFIG.formatters },
  }
}

async function createDefaultConfigFile(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, DEFAULT_CONFIG_JSONC, "utf8")
  console.log(`[token-saver] no existed "${path}"; created with defaults.`)
}

/**
 * Loads config from given path. If missing, creates default file once.
 * If corrupt, warns and continues with defaults (never crashes server).
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
          `[token-saver] could not create default config at "${path}": ` +
            `${createError instanceof Error ? createError.message : String(createError)}; using defaults.`,
        )
      }
      return freshDefaults()
    }
    console.warn(`[token-saver] could not read "${path}"; using defaults.`)
    return freshDefaults()
  }

  try {
    return normalizeConfig(parseJsonc(raw))
  } catch (error) {
    console.warn(
      `[token-saver] "${path}" is invalid JSONC ` +
        `(${error instanceof Error ? error.message : String(error)}); using defaults without overwriting.`,
    )
    return freshDefaults()
  }
}
