/**
 * Drive the official openai-codex sign-in that llm-pi-ai registers.
 *
 * DSH mounts pi-ai's provider logins on the authorization seam, but no surface
 * calls them: the Models page sign-in slot belongs to the DeepSeek account and
 * the provider-card slot has no registrant. This module supplies that caller,
 * so the official route can be signed into without a standalone script.
 *
 * It owns no protocol code. The credential is pi-ai's own format, written by
 * pi-ai's own store through the harness credential seam, which is also what
 * makes the running adapter observe the commit.
 * @module dsh-llm-chatgpt/codex
 */
import { credentialKey } from '@deepseek-ai/dsh-credentials'

/** Credential record the llm-pi-ai adapter reads for one pi-ai provider id. */
export const CODEX_PROVIDER = 'openai-codex'
export const CODEX_KEY = credentialKey('llm-pi-ai', CODEX_PROVIDER)
/** Settings namespace the pi-ai adapter family declares its providers under. */
export const CODEX_SETTINGS_NS = 'llm-pi-ai'

/**
 * The account facts worth showing, read from the stored grant.
 *
 * The access token is a JWT whose claims carry the plan and profile; nothing
 * here is secret, and the token itself never leaves this function.
 * @param record - the stored credential record, or undefined.
 * @returns display facts, or undefined when nothing is stored.
 */
export function readCodexAccount(record) {
  const payload = record?.kind === 'grant' ? record.payload : undefined
  if (payload === undefined || typeof payload.access !== 'string') return undefined
  const parts = payload.access.split('.')
  const claims = parts.length === 3 ? decode(parts[1]) : undefined
  const auth = claims?.['https://api.openai.com/auth']
  const profile = claims?.['https://api.openai.com/profile']
  return {
    accountId: typeof payload.accountId === 'string' ? payload.accountId : auth?.chatgpt_account_id,
    name: typeof profile?.name === 'string' ? profile.name : undefined,
    email: typeof profile?.email === 'string' ? profile.email : undefined,
    plan: typeof auth?.chatgpt_plan_type === 'string' ? auth.chatgpt_plan_type : undefined,
    expires: typeof payload.expires === 'number' ? payload.expires : undefined,
  }
}

/** Decode one base64url JWT segment, or undefined when it is not JSON. */
function decode(segment) {
  try { return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) } catch { return undefined }
}

/**
 * Whether the flow this module drives is the one registered for the key.
 *
 * Absent llm-pi-ai (a composition that does not mount it) there is nothing to
 * sign into, so the caller reports that instead of failing at request time.
 * @param ctx - the plugin context carrying `ctx.authorization`.
 * @returns the entry, or undefined when no flow claims the key.
 */
export function codexFlow(ctx) {
  return ctx.authorization.describe(CODEX_KEY)
}

/**
 * Run one sign-in attempt and report how it ended.
 *
 * `notice` receives pi-ai's authorization URL and progress messages; `prompt` answers
 * pi-ai's method choice. The browser callback races the manual-code prompt, so
 * the prompt stays pending and lets the callback win — the same shape the
 * standalone script uses.
 * @param ctx - the plugin context.
 * @param options - notice sink and the attempt's lifetime.
 * @returns the outcome status.
 */
export async function beginCodexLogin(ctx, { notify, signal }) {
  const flow = codexFlow(ctx)
  if (flow === undefined) {
    throw new Error('llm-pi-ai does not offer an openai-codex sign-in in this composition.')
  }
  const method = flow.methods.find(entry => entry.id === 'oauth') ?? flow.methods[0]
  if (method === undefined) throw new Error('The openai-codex flow offers no sign-in method.')
  const outcome = await ctx.authorization.begin({
    key: CODEX_KEY,
    method: method.id,
    signal,
    interaction: {
      notify,
      async prompt(request) {
        // pi-ai first asks which login method to use; the browser path is the
        // one this surface offers. The later manual-code prompt is left pending
        // so the loopback callback decides the attempt.
        if (request.kind === 'select') return request.options[0].id
        return new Promise((_resolve, reject) => {
          const abort = () => reject(new Error('sign-in prompt withdrawn'))
          request.signal?.addEventListener('abort', abort, { once: true })
          signal?.addEventListener('abort', abort, { once: true })
        })
      },
    },
  })
  return outcome.status
}

/** Remove the stored sign-in, which the adapter treats as signed out. */
export async function forgetCodexLogin(ctx) {
  await ctx.authorization.cancel(CODEX_KEY)
  await ctx.credentials.deleteRecord(CODEX_KEY)
}
