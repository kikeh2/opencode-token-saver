/**
 * Trim seguro de whitespace sobre el contenido que el modelo escribe.
 *
 * Qué hace:
 * - Quita espacios/tabs al final de cada línea.
 * - Colapsa 3+ líneas vacías consecutivas a 1 sola.
 * - Para write (archivo entero): asegura que termine en un solo "\n".
 *
 * Qué NO hace a propósito:
 * - No toca nunca la indentación al inicio de línea: es semántica del código,
 *   no sobrante. El formatter real (format.ts) arregla eso si hay problema.
 */

/** "[ \t]" justo antes de un salto → nada; y trailing real al fin del texto. */
const TRAILING_BEFORE_BREAK = /[ \t]+(?=\n)/g
const TRAILING_AT_EOF = /[ \t]+$/

/**
 * 4+ saltos consecutivos equivalen a 3+ líneas vacías seguidas, y quedan
 * reducidos a 2 saltos = 1 única línea vacía entre contenido.
 */
const BLANK_LINES = /\n{4,}/g

/** Quita espacios/tabs al final de cada línea, sin tocar el inicio. */
export function trimTrailingPerLine(content: string): string {
  return content.replace(TRAILING_BEFORE_BREAK, "").replace(TRAILING_AT_EOF, "")
}

/** 3+ líneas vacías consecutivas → 1 sola. */
export function collapseBlankLines(content: string): string {
  return content.replace(BLANK_LINES, "\n\n")
}

/**
 * Contenido completo de un write: trim + collapse + cerrar en un único "\n".
 * El archivo vacío se queda vacío (el usuario puede querer vaciar un archivo).
 */
export function trimWriteContent(content: string): string {
  if (content === "") return content
  const trimmed = collapseBlankLines(trimTrailingPerLine(content))
  if (trimmed === "") return ""
  return `${trimmed.replace(/\n+$/, "")}\n`
}

/**
 * Texto de un "newString" de edit: trim + collapse, pero SIN forzar salto
 * final: es un fragmento que va en medio del archivo, no un archivo entero.
 * El "oldString" no se procesa nunca acá: tiene que matchear el archivo
 * real letra por letra y cualquier cambio lo haría fallar el edit.
 */
export function trimEditString(value: string): string {
  if (value === "") return value
  return collapseBlankLines(trimTrailingPerLine(value))
}
