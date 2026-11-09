/**
 * Feature 2: real formatting post-write/edit.
 *
 * The point is not wasting tokens aligning indentation: the model writes its
 * best block and an external formatter (prettier, black, gofmt...) leaves the
 * file clean without the model having to regenerate anything over a misplaced
 * indentation.
 *
 * Rules:
 * - Command is searched by extension in config.formatters; without entry, not
 *   done (zero cost).
 * - "$FILE" is replaced by real file path.
 * - Runs with Bun Shell ($) interpolating each token as argument
 *   safe: string interpolation is escaped by default, and an array
 *   interpolated expands as separated arguments without injection risk.
 * - Use .nothrow().quiet() so a failure (formatter not installed, exit
 *   code != 0...) only generates a warning and NEVER breaks tool flow.
 *
 * Runs configured formatter for edited file extension.
 * Never throws: any failure ends in console.warn.
 */
import { $ } from "bun"
import { dirname, extname } from "node:path"
import type { TokenSaverConfig } from "./config"

const FILE_PLACEHOLDER = "$FILE"

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Last lines of stderr, for warning (without flooding log). */
function stderrTail(buffer: Buffer): string {
  return buffer
    .toString()
    .trim()
    .split("\n")
    .slice(-2)
    .join(" / ")
}

/** Runs formatter configured for edited file extension.
 * Never throws: any failure ends in console.warn. */
export async function formatFile(filePath: string, config: TokenSaverConfig): Promise<void> {
  const ext = extname(filePath).toLowerCase()
  const command = config.formatters[ext]
  if (command === undefined || command.length === 0) return

  const filled = command.map((part) => (part === FILE_PLACEHOLDER ? filePath : part))
  if (!filled.includes(filePath)) {
    // If user didn't put "$FILE" in command, file goes as last argument:
    // so a minimal command like ["gofmt", "-w"] works.
    filled.push(filePath)
  }
  const [bin, ...args] = filled
  if (bin === undefined) return

  // Allowlisted formatter binaries. Any other binary in config
  // is ignored with warning: avoids arbitrary execution via token-saver.jsonc.
  const ALLOWED_FORMATTER_BINS = new Set(["prettier", "black", "gofmt", "bunx"])

  if (!ALLOWED_FORMATTER_BINS.has(bin)) {
    console.warn(
      `[token-saver] formatter "${bin}" not in allowlisted binaries ` +
        `(${Array.from(ALLOWED_FORMATTER_BINS).join(", ")}). ` +
        `Ignoring command configured for "${ext}" in .opencode/token-saver.jsonc.`,
    )
    return
  }

  // If binary is a package wrapper (bunx/npx), the package it runs must
  // also be in its own allowlist, to avoid config triggering any npm package.
  const ALLOWED_FORMATTER_PACKAGES = new Set(["prettier"])
  if ((bin === "bunx" || bin === "npx") && args.length > 0) {
    const pkg = args[0]
    if (pkg === undefined || !ALLOWED_FORMATTER_PACKAGES.has(pkg)) {
      console.warn(
        `[token-saver] package "${pkg ?? "(unknown)"}" of "${bin}" not in allowlisted ` +
          `packages (${Array.from(ALLOWED_FORMATTER_PACKAGES).join(", ")}). ` +
          `Ignoring command configured for "${ext}" in .opencode/token-saver.jsonc.`,
      )
      return
    }
  }

  // Capture mtime before running formatter to detect if file was modified
  // although command exits with error (possible corruption).
  const { stat } = await import("node:fs/promises")
  let mtimeBefore: number | undefined
  try {
    const statsBefore = await stat(filePath)
    mtimeBefore = statsBefore.mtimeMs
  } catch {
    // If file doesn't exist yet, nothing to compare.
  }

  try {
    const proc = await $`${bin} ${args}`
      .nothrow()
      .quiet()
      // Cwd in file folder: formatters discover their config
      // (.prettierrc, pyproject.toml...) upward, like the user would.
      .cwd(dirname(filePath))

    if (proc.exitCode !== 0) {
      const tail = stderrTail(proc.stderr)
      let note = ""
      if (mtimeBefore !== undefined) {
        try {
          const statsAfter = await stat(filePath)
          if (statsAfter.mtimeMs !== mtimeBefore) {
            note = " WARNING: file was modified although formatter exited with error; may be corrupt."
          }
        } catch {
          // Could not re-stat; continue without additional note.
        }
      }
      console.warn(
        `[token-saver] formatter "${bin}" exited with code ${proc.exitCode} for "${ext}"` +
          `${tail === "" ? "" : `: ${tail}`}${note}. Ignoring formatting; check command in .opencode/token-saver.jsonc.`,
      )
      return
    }

    console.log(`[token-saver] formatter "${bin}" ok in "${filePath}".`)
  } catch (error) {
    console.warn(
      `[token-saver] could not run formatter "${bin}" for "${ext}": ` +
        `${errorMessage(error)}. Continuing without breaking flow.`,
    )
  }
}
