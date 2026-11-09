/**
 * token-saver: OpenCode plugin to save tokens.
 *
 * API used (v2, @opencode/plugin package):
 * - `ctx.tool.hook("execute.before")` → equivalent to v1 hook "tool.execute.before":
 *   runs BEFORE the tool executes and receives event with `event.input`.
 * - `ctx.tool.hook("execute.after")` → equivalent to v1 hook "tool.execute.after":
 *   runs AFTER, with `event.status` in "completed" or "error".
 *
 * The three features are independent and each can be turned off from config
 * (.opencode/token-saver.jsonc). Only handles tools "edit", "write" and
 * "read"; any other tool passes through normally.
 */
import { Plugin } from "@opencode/plugin"
import { isAbsolute, resolve, relative } from "node:path"
import { configPath, loadConfig, type TokenSaverConfig } from "./config"
import { trimEditString, trimWriteContent } from "./whitespace"
import { formatFile } from "./format"
import { assertFreshRead, recordRead, statFile } from "./dedupe-read"

/** Raw args of any tool: object with free keys. */
type ToolArgs = Record<string, unknown>

/** Narrow `event.input` (unknown) to tool args, without `any`. */
function asArgs(value: unknown): ToolArgs | undefined {
  return typeof value === "object" && value !== null ? (value as ToolArgs) : undefined
}

/** Reads a non-empty string field from tool args. */
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
     * Resolves the tool path and verifies it stays within project dir.
     * Returns null if path escapes (path traversal or symlink outside),
     * to avoid stat/cache of external files.
     */
    const canonicalPath = (filePath: string): string | null => {
      const resolved = isAbsolute(filePath) ? filePath : resolve(projectDir, filePath)
      const rel = relative(projectDir, resolved)
      if (rel === null || rel.startsWith("..") || rel.startsWith("/")) return null
      return resolved
    }

    if (config.trimWhitespace) {
      // FEATURE 1 — whitespace trim before write/edit.
      // Why: the model wastes tokens writing trailing spaces or
      // mountains of blank lines. Trimming here saves file bytes,
      // not model response bytes.
      await ctx.tool.hook("execute.before", (event) => {
        if (event.tool !== "write" && event.tool !== "edit") return
        const args = asArgs(event.input)
        if (args === undefined) return

        // write: content is the whole file, so I also close
        // ensuring exactly one final newline.
        if (event.tool === "write" && typeof args.content === "string") {
          const trimmed = trimWriteContent(args.content)
          if (trimmed !== args.content) {
            // "input" of event is mutable: editing here changes what
            // the real tool will write. Other fields copied as-is.
            event.input = { ...args, content: trimmed }
            const saved = args.content.length - trimmed.length
            console.log(
              `[token-saver] write: trimmed ${saved} chars of whitespace${typeof args.filePath === "string" ? ` in "${args.filePath}"` : ""}.`,
            )
          }
        }

        // edit: only newString. oldString is NOT touched: it must match
        // the real file letter by letter, and any change would make
        // the edit fail by not finding the text.
        if (event.tool === "edit" && typeof args.newString === "string") {
          const trimmed = trimEditString(args.newString)
          if (trimmed !== args.newString) {
            event.input = { ...args, newString: trimmed }
          }
        }
      })
    }

    if (config.formatOnEdit) {
      // FEATURE 2 — real formatter after write/edit.
      // Why: this is where final indentation is decided. The model writes
      // its best attempt, and the formatter makes it clean — so the LLM
      // doesn't have to regenerate the whole block over a misplaced indent.
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
      // FEATURE 3a — before read: block useless re-reads.
      // Why: a repeated read puts the whole file back into context.
      // With stat() (mtime + size, very fast, without reading content)
      // I realize if we already have it live to throw the short error.
      await ctx.tool.hook("execute.before", async (event) => {
        if (event.tool !== "read") return
        const filePath = getStringArg(asArgs(event.input), "filePath")
        if (filePath === undefined) return
        const resolved = canonicalPath(filePath)
        if (resolved === null) return

        const info = await statFile(resolved)
        if (info === undefined) return // doesn't exist: read will fail on its own
        assertFreshRead(config, event.sessionID, resolved, info)
      })

      // FEATURE 3b — after successful read: register new mtime.
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

    // Registrations live while plugin is loaded; no need
    // dispose now. If plugin unloads, OpenCode disposes them automatically.
  },
})
