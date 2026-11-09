/**
 * Smoke tests de runtime para token-saver (corre con: bun tests/tests.ts).
 * No forma parte del plugin: solo verifica comportamientos clave.
 */
import { trimWriteContent, trimEditString } from "../src/whitespace.ts"
import { loadConfig, stripJsoncComments, parseJsonc, DEFAULT_CONFIG, type TokenSaverConfig } from "../src/config.ts"
import { statFile, recordRead, assertFreshRead, redundantReadMessage, isProtectedFile } from "../src/dedupe-read.ts"
import { formatFile } from "../src/format.ts"
import openCodePlugin from "../src/index.ts"
import { writeFile, mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { stat } from "node:fs/promises"

let failures = 0
function check(label: string, ok: boolean | (() => boolean)): void {
  const result = typeof ok === "function" ? ok() : ok
  if (result) {
    console.log(`ok   ${label}`)
  } else {
    failures++
    console.log(`FAIL ${label}`)
  }
}

function eq<T>(actual: T, expected: T): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected)
}

function throwsWithMessage(call: () => unknown, needle: string): boolean {
  try {
    call()
    return false
  } catch (error) {
    return error instanceof Error && error.message.includes(needle)
  }
}

async function probeStat(filePath: string): Promise<{ mtimeMs: number; size: number }> {
  const stats = await stat(filePath)
  return { mtimeMs: stats.mtimeMs, size: stats.size }
}

/* ── whitespace ─────────────────────────────────────────────── */

check("trimWriteContent: trailing + blanks + salto final", () =>
  eq(trimWriteContent("a  \t\n\n\n\nb   "), "a\n\nb\n"),
)
check("trimWriteContent: agrega un solo \\n al final", () => eq(trimWriteContent("hola"), "hola\n"))
check("trimWriteContent: no duplica el \\n final", () => eq(trimWriteContent("hola\n"), "hola\n"))
check("trimWriteContent: colapsa la serie final", () => eq(trimWriteContent("hola\n\n\n"), "hola\n"))
check("trimWriteContent: vacío queda vacío", () => eq(trimWriteContent(""), ""))
check("trimWriteContent: no toca la indentación inicial", () =>
  eq(trimWriteContent("if (x) {\n  y  \n    z   \n}"), "if (x) {\n  y\n    z\n}\n"),
)
check("trimEditString: sin salto forzado al final", () => eq(trimEditString("x  \n\n\n\n\ny"), "x\n\ny"))
check("trimEditString: vacío queda vacío", () => eq(trimEditString(""), ""))

/* ── config / jsonc ─────────────────────────────────────────── */

check("stripJsoncComments + parse: línea, bloque, trailing comma, string con '//'", () =>
  eq(
    parseJsonc<{ x: number; y: number[]; z: string }>(
      stripJsoncComments(`// hola
      { "x": 1, /* bloque */ "y": [1, 2,], "z": "// no sacar" }`),
    ),
    { x: 1, y: [1, 2], z: "// no sacar" },
  ),
)

const scratchDir = await mkdtemp(join(tmpdir(), "tokensaver-"))
const created = await loadConfig(join(scratchDir, "token-saver.jsonc"))
check("loadConfig: crea el archivo default a la primera", () => eq(created, DEFAULT_CONFIG))
const reloaded = await loadConfig(join(scratchDir, "token-saver.jsonc"))
check("loadConfig: releer el config creado parseea igual", () => eq(reloaded, DEFAULT_CONFIG))

await writeFile(join(scratchDir, "broken.jsonc"), "{ trimWhitespace: true,, }", "utf8")
const broken = await loadConfig(join(scratchDir, "broken.jsonc"))
check("loadConfig: JSONC inválido → defaults sin explotar", () => eq(broken, DEFAULT_CONFIG))

/* ── dedupe-read ────────────────────────────────────────────── */

const fileA = join(scratchDir, "nota.md")
await writeFile(fileA, "contenido\n", "utf8")
const infoA = await statFile(fileA)
check("statFile: resuelve mtime/size", () => infoA !== undefined && infoA.size > 0)
const missingInfo = await statFile(join(scratchDir, "nope.md"))
check("statFile: archivo inexistente → undefined", () => missingInfo === undefined)

const probeConfig: TokenSaverConfig = { ...DEFAULT_CONFIG, alwaysProtectedFiles: ["AGENTS.md"] }

recordRead("s1", fileA, infoA)
check("assertFreshRead: mismo mtime → bloquea con el mensaje", () =>
  throwsWithMessage(() => assertFreshRead(probeConfig, "s1", fileA, infoA!), redundantReadMessage(fileA)),
)

await writeFile(fileA, "contenido nuevo\n", "utf8")
const freshInfo = await probeStat(fileA)
check("assertFreshRead: mtime cambiado → pasa", () => {
  assertFreshRead(probeConfig, "s1", fileA, freshInfo)
  return true
})
check("assertFreshRead: otra sesión con el dato viejo → pasa", () => {
  assertFreshRead(probeConfig, "s2", fileA, infoA!)
  return true
})

const protectedPath = join(scratchDir, "AGENTS.md")
await writeFile(protectedPath, "guía\n", "utf8")
const protectedInfo = await statFile(protectedPath)
check("isProtectedFile: matchea por basename", () => isProtectedFile(["AGENTS.md"], protectedPath))
check("assertFreshRead: protegido, primera vez → pasa", () => {
  assertFreshRead(probeConfig, "s3", protectedPath, protectedInfo!)
  return true
})
recordRead("s3", protectedPath, protectedInfo)
check("assertFreshRead: protegido ya leído → bloquea aunque cambie", () =>
  throwsWithMessage(
    () => assertFreshRead(probeConfig, "s3", protectedPath, { mtimeMs: protectedInfo!.mtimeMs + 1, size: 999 }),
    redundantReadMessage(protectedPath),
  ),
)

/* ── format: fallas toleradas ───────────────────────────────── */

const fmtConfig: TokenSaverConfig = {
  ...DEFAULT_CONFIG,
  formatters: {
    ".txt": ["echo", "FORMATTED"], // sin $FILE → append, exit 0
    ".fail": ["/bin/false"], // exit 1 → warning
    ".boom": ["esta-binario-no-existe-xyz"], // no spawnea → warning
  },
}
const txtFile = join(scratchDir, "bum.txt")
await writeFile(txtFile, "x\n", "utf8")
await formatFile(txtFile, fmtConfig)
check("formatFile: formatter ok (echo) no revienta", () => true)

const failA = join(scratchDir, "x.fail")
const failB = join(scratchDir, "x.boom")
await formatFile(failA, fmtConfig)
await formatFile(failB, fmtConfig)
check("formatFile: exit 1 y binario faltante → warning, sin throw", () => true)

/* ── integración con index.ts (hooks con ctx mockeado) ──────── */

type HookCb = (event: Record<string, unknown>) => Promise<void> | void
const registered: Array<{ name: string; cb: HookCb }> = []
const fakeCtx = {
  location: { directory: scratchDir },
  tool: {
    hook: async (name: string, cb: HookCb) => {
      registered.push({ name, cb })
      return { dispose: async () => {} }
    },
  },
}
await (openCodePlugin as unknown as { setup: (ctx: unknown) => Promise<unknown> }).setup(fakeCtx)
check("setup: registró los 4 hooks de tool", () => registered.length === 4)

const before = registered.filter((reg) => reg.name === "execute.before")
const after = registered.filter((reg) => reg.name === "execute.after")
check("setup: 2 before + 2 after", () => before.length === 2 && after.length === 2)

const [trimBefore, readBefore] = [before[0]!, before[1]!]
const [formatAfter, recordAfter] = [after[0]!, after[1]!]

const evWrite = {
  tool: "write",
  status: "completed",
  input: {
    filePath: join(scratchDir, "pong.txt"),
    content: "línea 1  \n\n\n\n\nlínea 2   ",
  },
}
await trimBefore.cb(evWrite)
check("hook write: mutó content in-place", () =>
  eq((evWrite.input as { content: string }).content, "línea 1\n\nlínea 2\n"),
)
await formatAfter.cb(evWrite)

const evEdit = {
  tool: "edit",
  status: "completed",
  input: {
    filePath: join(scratchDir, "pong.txt"),
    oldString: "ORIGINAL  ",
    newString: "NUEVO  \n\n\n\n\nBORDE",
  },
}
await trimBefore.cb(evEdit)
check("hook edit: solo newString se ajusta", () => {
  const input = evEdit.input as { oldString: string; newString: string }
  return eq(input.newString, "NUEVO\n\nBORDE") && eq(input.oldString, "ORIGINAL  ")
})

/* read: 1ª vez pasa y registra; 2ª vez lanza el mensaje exacto */
const readTarget = join(scratchDir, "codigo.ts")
await writeFile(readTarget, "const x = 1\n", "utf8")
await recordAfter.cb({ tool: "read", status: "completed", input: { filePath: readTarget } })

let blockedMessage = ""
try {
  await readBefore.cb({ tool: "read", input: { filePath: readTarget } })
} catch (error) {
  blockedMessage = error instanceof Error ? error.message : String(error)
}
check("hook read: 1ª vez pasa, 2ª vez lanza el mensaje exacto", () =>
  blockedMessage === redundantReadMessage(readTarget),
)

/* protegido por basename, usando el config default del plugin */
const evProt = { tool: "read", status: "completed", input: { filePath: protectedPath } }
await recordAfter.cb(evProt)
let protectedBlocked = ""
try {
  await readBefore.cb({ tool: "read", input: { filePath: protectedPath } })
} catch (error) {
  protectedBlocked = error instanceof Error ? error.message : String(error)
}
check(
  "hook read: protegido bloquea el 2º intento (basename)",
  () => protectedBlocked === redundantReadMessage(protectedPath),
)

/* tools ajenos: no se molestan */
let otherError = ""
try {
  await readBefore.cb({ tool: "bash", input: { command: "ls" } })
  await trimBefore.cb({ tool: "bash", input: { command: "ls" } })
} catch (error) {
  otherError = error instanceof Error ? error.message : String(error)
}
check("hooks: ignoran tools que no son read/edit/write", () => otherError === "")

console.log(failures === 0 ? "\nTODO OK" : `\n${failures} FAILS`)
process.exit(failures === 0 ? 0 : 1)
