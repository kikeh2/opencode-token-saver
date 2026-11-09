/**
 * Feature 3: deduplicación de reads repetidos en la misma sesión.
 *
 * El objetivo: si el LLM ya leyó un archivo y este no cambió, releerlo cuesta
 * tokens y no aporta nada. Al bloquear el re-read con un throw, OpenCode le
 * devuelve al modelo el mensaje cortito del error como resultado del tool,
 * en lugar de pagar por todo el archivo otra vez.
 *
 * La cache vive al nivel del módulo: dura lo que el proceso del server tenga
 * cargado el plugin (≈ la vida de la sesión). La key incluye el sessionID
 * para no bloquear lecturas legítimas de otra sesión que comparte el proceso.
 */
import { stat } from "node:fs/promises"
import { basename } from "node:path"
import type { TokenSaverConfig } from "./config"

export interface ReadCacheEntry {
  /** Firma estadística del archivo (mtime:size). No es hash de contenido: */
  /** calcularlo requeriría leer el archivo completo, justo lo que evitamos. */
  hash: string
  mtimeMs: number
}

/** Datos que salen de un stat(): rápidos, sin leer contenido. */
export interface FileInfo {
  mtimeMs: number
  size: number
}

const cache = new Map<string, ReadCacheEntry>()

/** Tope de entradas en el cache de lecturas. Evita crecimiento ilimitado
 *  de memoria en sesiones largas o procesos del server compartidos. */
const MAX_CACHE_ENTRIES = 1000

function sessionKey(sessionID: string, filePath: string): string {
  return `${sessionID}::${filePath}`
}

export function statHash(info: FileInfo): string {
  return `${info.mtimeMs}:${info.size}`
}

/** stat() tolerante: si el archivo no existe todavía devuelve undefined. */
export async function statFile(filePath: string): Promise<FileInfo | undefined> {
  try {
    const stats = await stat(filePath)
    return { mtimeMs: stats.mtimeMs, size: stats.size }
  } catch {
    return undefined
  }
}

/**
 * Después de un read exitoso: guarda o actualiza la entrada del archivo con
 * su mtime nuevo. Si no hubo stat válido, no se registra nada.
 */
export function recordRead(sessionID: string, filePath: string, info: FileInfo | undefined): void {
  if (info === undefined) return
  cache.set(sessionKey(sessionID, filePath), {
    hash: statHash(info),
    mtimeMs: info.mtimeMs,
  })
  // Limpieza FIFO: si se supera el tope, elimina la entrada más antigua.
  if (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
}

/** Comparación por basename, sí o sí igual que en el config. */
export function isProtectedFile(protectedNames: string[], filePath: string): boolean {
  return protectedNames.includes(basename(filePath))
}

/** Mensaje exacto que recibe el LLM cuando el tool read se bloquea. */
export function redundantReadMessage(filePath: string): string {
  return (
    `[token-saver] "${filePath}" ya fue leído en esta sesión y no cambió. ` +
    `Usá el contenido que ya tenés en el contexto, no hace falta releerlo.`
  )
}

/**
 * Decide si el read vale la pena. Lanza si:
 * - el archivo ya fue leído en esta sesión y su mtime/size no cambiaron, O
 * - es un archivo protegido (por basename) que ya se leyó una vez acá.
 * Si no hay registro previo, nunca bloquea: el primer read siempre pasa.
 */
export function assertFreshRead(
  config: TokenSaverConfig,
  sessionID: string,
  filePath: string,
  info: FileInfo,
): void {
  const entry = cache.get(sessionKey(sessionID, filePath))
  if (entry === undefined) return

  const protectedName = isProtectedFile(config.alwaysProtectedFiles, filePath)
  const unchanged = entry.mtimeMs === info.mtimeMs && entry.hash === statHash(info)

  if (protectedName || unchanged) {
    throw new Error(redundantReadMessage(filePath))
  }
}
