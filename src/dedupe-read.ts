/**
 * Feature 3: deduplication of repeated reads in same session.
 *
 * Goal: if LLM already read file and it didn't change, re-reading costs
 * tokens and adds nothing. By blocking re-read with throw, OpenCode gives
 * model the short error message as tool result, instead of paying for
 * whole file again.
 *
 * Cache lives at module level: lasts as long as server process has
 * loaded plugin (≈ session life). Key includes sessionID
 * to not block legitimate reads from another session sharing process.
 */
import { stat } from "node:fs/promises"
import { basename } from "node:path"
import type { TokenSaverConfig } from "./config"

export interface ReadCacheEntry {
  /** File statistical signature (mtime:size). Not content hash:
   *  calculating it would require reading whole file, exactly what we avoid. */
  hash: string
  mtimeMs: number
}

/** Data from stat(): fast, without reading content. */
export interface FileInfo {
  mtimeMs: number
  size: number
}

const cache = new Map<string, ReadCacheEntry>()

function sessionKey(sessionID: string, filePath: string): string {
  return `${sessionID}::${filePath}`
}

export function statHash(info: FileInfo): string {
  return `${info.mtimeMs}:${info.size}`
}

/** stat() tolerant: if file doesn't exist yet returns undefined. */
export async function statFile(filePath: string): Promise<FileInfo | undefined> {
  try {
    const stats = await stat(filePath)
    return { mtimeMs: stats.mtimeMs, size: stats.size }
  } catch {
    return undefined
  }
}

/**
 * After successful read: saves or updates file entry with
 * its new mtime. If no valid stat, nothing is registered.
 */
export function recordRead(sessionID: string, filePath: string, info: FileInfo | undefined): void {
  if (info === undefined) return
  cache.set(sessionKey(sessionID, filePath), {
    hash: statHash(info),
    mtimeMs: info.mtimeMs,
  })
}

/** Basename comparison, exactly as in config. */
export function isProtectedFile(protectedNames: string[], filePath: string): boolean {
  return protectedNames.includes(basename(filePath))
}

/** Exact message LLM receives when read tool is blocked. */
export function redundantReadMessage(filePath: string): string {
  return (
    `[token-saver] "${filePath}" was already read in this session and did not change. ` +
    `Use content you already have in context, no need to re-read it.`
  )
}

/**
 * Decides if read is worth it. Throws if:
 * - file was already read in this session and mtime/size didn't change, OR
 * - it's a protected file (by basename) already read once here.
 * If no previous record, never blocks: first read always passes.
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
