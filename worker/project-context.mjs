// Ported from the built-in explainer's project-context.ts.
import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import { EXPLAIN_MODES } from '../src/explain-modes.mjs'

const INSTRUCTIONS_MAX_CHARS = 128_000
const IMPORT_DEPTH_MAX = 8

/**
 * The request for one menu action: its instructions, then where the code is and the code itself.
 * @param {import('../src/protocol').ExplainSelection} selection
 * @param {import('../src/explain-modes.mjs').ExplainMode} mode
 */
export function formatExplanationRequest(selection, mode) {
  const lines =
    selection.startLine === selection.endLine
      ? `line ${selection.startLine}`
      : `lines ${selection.startLine}–${selection.endLine}`
  return [
    EXPLAIN_MODES[mode].prompt,
    selection.relativePath
      ? `Selected code: ${selection.relativePath}, ${lines}.`
      : `Selected code: ${lines} of an editor file whose path is unknown (new or unsaved); search the project if you need its context.`,
    selection.trimmed
      ? 'The selection was cut to fit; ask for the rest with read_project_file.'
      : '',
    `Exact selection (${selection.languageId}):\n${selection.text}`,
    `Surrounding editor snapshot, from line ${selection.surroundingStartLine}:\n${selection.surrounding}`
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** A workspace-relative path, or null when it would leave the workspace. */
function insideWorkspace(path) {
  const normalized = posix.normalize(path.replace(/\\/g, '/')).replace(/^\.\//, '')
  return normalized === '.' ||
    normalized.startsWith('../') ||
    normalized === '..' ||
    posix.isAbsolute(normalized)
    ? null
    : normalized
}

/**
 * The instruction files that apply to `relativePath`, root first: the provider's own file
 * (`CLAUDE.md`, or `AGENTS.override.md` / `AGENTS.md` for Codex), the other name at the root as a
 * fallback, and Claude's `@imports` inside the workspace.
 * @param {(path: string) => Promise<string | null>} read the file's text, or null when missing
 */
export async function loadExplainerContext(read, provider, relativePath) {
  const documents = new Map()
  const load = async (path, depth = 0) => {
    const inside = insideWorkspace(path)
    if (!inside || depth > IMPORT_DEPTH_MAX) {
      return false
    }
    if (documents.has(inside)) {
      return true
    }
    const content = await read(inside)
    if (content === null) {
      return false
    }
    if (content.length > INSTRUCTIONS_MAX_CHARS) {
      throw new Error(`Project instructions are too large: ${inside}`)
    }
    documents.set(inside, content)
    if (provider === 'claude') {
      for (const match of content.matchAll(/(?:^|\s)@([^\s`]+\.md)\b/gm)) {
        await load(posix.join(posix.dirname(inside), match[1]), depth + 1)
      }
    }
    return true
  }
  const preferred = provider === 'claude' ? 'CLAUDE.md' : 'AGENTS.md'
  const other = provider === 'claude' ? 'AGENTS.md' : 'CLAUDE.md'
  const loadDirectory = async (directory, fallback) => {
    if (provider === 'codex' && (await load(posix.join(directory, 'AGENTS.override.md')))) {
      return
    }
    if (!(await load(posix.join(directory, preferred))) && fallback) {
      await load(posix.join(directory, other))
    }
  }
  await loadDirectory('', true)
  const parts = posix
    .dirname(relativePath.replace(/\\/g, '/'))
    .split('/')
    .filter((part) => part && part !== '.')
  let current = ''
  for (const part of parts) {
    current = posix.join(current, part)
    await loadDirectory(current, false)
  }
  return [...documents].map(([path, content]) => ({
    path,
    content,
    hash: createHash('sha256').update(content).digest('hex')
  }))
}

/**
 * The prompt for one turn: instruction files that are new or changed since the last turn, then
 * the question. Ported unchanged in behaviour.
 */
export function prepareExplainerPrompt(documents, previous, text) {
  const hashes = Object.fromEntries(documents.map((doc) => [doc.path, doc.hash]))
  const changed = documents.filter((doc) => previous.hashes[doc.path] !== doc.hash)
  const removed = Object.keys(previous.hashes).filter((path) => !(path in hashes))
  const prompt = [
    previous.initialized
      ? ''
      : 'Initialize this dedicated project explanation conversation. Retain the following project context for subsequent questions.',
    changed.map((doc) => `Project instructions: ${doc.path}\n${doc.content}`).join('\n\n'),
    removed.length ? `These instruction files no longer apply: ${removed.join(', ')}.` : '',
    text
  ]
    .filter(Boolean)
    .join('\n\n')
  return { prompt, hashes, files: documents.map((doc) => doc.path) }
}
