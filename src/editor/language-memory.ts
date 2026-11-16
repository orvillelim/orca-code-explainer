// Each file's language, remembered by its text in the plugin's storage. Orca names no path, so
// otherwise the editor stays uncolored until the worker has found the file; this way a file opened
// before is highlighted on the first paint.

const KEY = 'languageByText'
/** Files remembered; the oldest are dropped first. */
const KEPT = 400
/** How long the first paint may wait for the answer. */
const WAIT_MS = 150

type Memory = Record<string, string>

async function load(): Promise<Memory> {
  const saved = await globalThis.orca.storage.get(KEY)
  return saved && typeof saved === 'object' && !Array.isArray(saved) ? (saved as Memory) : {}
}

/** The language last seen for this text, or null when unknown or slow to answer. */
export function rememberedLanguage(hash: string): Promise<string | null> {
  return Promise.race([
    load()
      .then((memory) => (typeof memory[hash] === 'string' ? memory[hash] : null))
      .catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), WAIT_MS))
  ])
}

export async function rememberLanguage(hash: string, languageId: string): Promise<void> {
  const memory = await load()
  if (memory[hash] === languageId) {
    return
  }
  // Why delete first: a key set again moves to the end, so the newest survive the cap.
  delete memory[hash]
  memory[hash] = languageId
  const keys = Object.keys(memory)
  for (const key of keys.slice(0, Math.max(0, keys.length - KEPT))) {
    delete memory[key]
  }
  await globalThis.orca.storage.set(KEY, memory)
}
