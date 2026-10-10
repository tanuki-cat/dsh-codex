import { openSync, readSync, closeSync, fstatSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const CODEX_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const MAX_BYTES = 4096
const CONFIG_URL = new URL('../config/codex.json', import.meta.url)

export class CodexVersionConfigError extends Error {
  readonly reason = 'version-config-invalid' as const
  constructor(path: string) {
    super('Invalid Codex version configuration at ' + path + '. Restore a valid codexClientVersion in config/codex.json and restart DSH.')
    this.name = 'CodexVersionConfigError'
  }
}
export type CodexVersionConfig = { version: string } | { error: CodexVersionConfigError }

/** Capture configuration failures without disabling modules that also use host authentication. */
export function loadCodexVersionConfig(url: URL = CONFIG_URL): CodexVersionConfig {
  try {
    const fd = openSync(url, 'r')
    let bytes: Buffer, size = 0
    try {
      if (!fstatSync(fd).isFile()) throw new Error('Not a regular file')
      bytes = Buffer.alloc(MAX_BYTES + 1)
      while (size < bytes.length) {
        const count = readSync(fd, bytes, size, bytes.length - size, null)
        if (!count) break
        size += count
      }
    } finally { closeSync(fd) }
    if (size > MAX_BYTES) throw new Error('Too large')
    const value: unknown = JSON.parse(bytes.subarray(0, size).toString('utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid object')
    const record = value as Record<string, unknown>
    if (Object.keys(record).length !== 1 || typeof record.codexClientVersion !== 'string'
      || record.codexClientVersion.length > 64 || !CODEX_VERSION_PATTERN.test(record.codexClientVersion)) throw new Error('Invalid version')
    return { version: record.codexClientVersion }
  } catch {
    return { error: new CodexVersionConfigError(fileURLToPath(url)) }
  }
}

const configuration = loadCodexVersionConfig()
export function getCodexClientVersion(config: CodexVersionConfig = configuration): string {
  if ('error' in config) throw config.error
  return config.version
}
