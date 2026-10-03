/**
 * Doubles shared by the plugin's tests.
 *
 * Only what the surviving modules actually touch: a credential store with the
 * harness record protocol, and an HTTP response builder. The protocol fixtures
 * the removed wire implementation needed are gone with it.
 */

/**
 * An in-memory credential store with the harness record semantics.
 *
 * modifyRecord returns the committed snapshot, propagates a mutation's own
 * rejection, and serializes writers so a test can rely on ordering.
 */
export function store(entries = []) {
  const values = new Map(entries)
  let tail = Promise.resolve()
  return {
    values,
    async readRecord(key) { return structuredClone(values.get(key)) },
    async listRecords() { return [...values.keys()].map(key => ({ key })) },
    modifyRecord(key, mutate) {
      const task = tail.then(async () => {
        const next = await mutate(structuredClone(values.get(key)))
        if (next !== undefined) values.set(key, structuredClone(next))
        return structuredClone(values.get(key))
      })
      tail = task.catch(() => {})
      return task
    },
    deleteRecord(key) {
      const task = tail.then(() => { values.delete(key) })
      tail = task.catch(() => {})
      return task
    },
  }
}

/** A JSON response with the content type every fetch double is read through. */
export const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
