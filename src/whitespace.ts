/**
 * Trim safe whitespace on content the model writes.
 *
 * What it does:
 * - Trims spaces/tabs at end of each line.
 * - Collapses 3+ consecutive blank lines to 1.
 * - For write (whole file): ensures it ends with a single "\n".
 *
 * What it does NOT do on purpose:
 * - Never touches indentation at start of line: it's code semantics,
 *   not surplus. The real formatter (format.ts) fixes that if there's a problem.
 */

/** "[ \t]" right before a jump → nothing; and real trailing at end of text. */
const TRAILING_BEFORE_BREAK = /[ \t]+(?=\n)/g
const TRAILING_AT_EOF = /[ \t]+$/

/**
 * 4+ consecutive jumps equal 3+ consecutive blank lines, and remain
 * reduced to 2 jumps = 1 single blank line between content.
 */
const BLANK_LINES = /\n{4,}/g

/** Trims spaces/tabs at end of each line, without touching the start. */
export function trimTrailingPerLine(content: string): string {
  return content.replace(TRAILING_BEFORE_BREAK, "").replace(TRAILING_AT_EOF, "")
}

/** 3+ consecutive blank lines → 1. */
export function collapseBlankLines(content: string): string {
  return content.replace(BLANK_LINES, "\n\n")
}

/**
 * Complete content of a write: trim + collapse + close with single "\n".
 * Empty file stays empty (user may want to empty a file).
 */
export function trimWriteContent(content: string): string {
  if (content === "") return content
  const trimmed = collapseBlankLines(trimTrailingPerLine(content))
  if (trimmed === "") return ""
  return `${trimmed.replace(/\n+$/, "")}\n`
}

/**
 * Text of an "newString" of edit: trim + collapse, but WITHOUT forcing
 * newline final: it's a fragment that goes in middle of file, not whole file.
 * The "oldString" is never processed here: it must match file letter by
 * letter and any change would make edit fail.
 */
export function trimEditString(value: string): string {
  if (value === "") return value
  return collapseBlankLines(trimTrailingPerLine(value))
}
