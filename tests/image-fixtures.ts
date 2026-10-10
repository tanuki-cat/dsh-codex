import { store, json } from './helpers.ts'
export const KEY = 'llm-pi-ai/openai-codex'
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64')
export const imageResponse = () => json({ data: [{ b64_json: PNG.toString('base64') }], output_format: 'png' })
export const signal = () => new AbortController().signal
export const deferred = () => Promise.withResolvers()
export function fixture(payload = {}) {
  const credentials = store([[KEY, { kind: 'grant', payload: { type: 'oauth', access: 'secret-access', refresh: 'secret-refresh', accountId: 'secret-account', expires: Date.now() + 86400_000, ...payload } }]])
  const saved = [], listeners = new Set()
  const ctx = { credentials, authorization: {},
    on(_event, callback) { listeners.add(callback); return () => listeners.delete(callback) },
    attachments: {
      imageLimits: { mediaTypes: ['image/png', 'image/jpeg', 'image/webp'], maxImageBytes: 1024, maxMessageImageBytes: 1024, maxImagesPerMessage: 1, maxImagePixels: 100, maxImageDimension: 100 },
      async saveImage(input) { saved.push(input); return { attachmentId: 'a'.repeat(64), mediaType: input.mediaType, width: 1, height: 1, bytes: input.data.length, name: input.name } },
    },
  }
  return { ctx, saved, listeners, async notify() { await Promise.all([...listeners].map(fn => fn(KEY))) },
    async update(patch) { await credentials.modifyRecord(KEY, current => ({ ...current, payload: { ...current.payload, ...patch } })); await this.notify() },
  }
}
export const rejectsReason = reason => error => { if (error.reason !== reason) throw error; return true }
