// Read-only access to one project folder, ported from the built-in explainer's project-reader.ts.
// Every path is resolved with realpath and refused when it leaves the project.
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fingerprintText, normalizeText } from '../src/text-fingerprint.mjs'

const SKIP_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  '.venv',
  '.cache',
  'dist',
  'build',
  '.orca'
])
const READ_MAX_BYTES = 1024 * 1024
const SEARCH_MAX_BYTES = 256 * 1024
const LIST_LIMIT = 3000
const LOCATE_FILE_LIMIT = 20000
const SEARCH_LIMIT = 40

// Secrets stay on this computer: the agent sends what it reads to its model provider.
const SECRET_FILE =
  /(^|\/)(\.env(\..*)?|[^/]*\.(env|pem|key|p12|pfx)|\.npmrc|kubeconfig|id_(rsa|ed25519|ecdsa))$/i

const toPosix = (path) => path.split(sep).join('/')

export function isSecretFile(relativePath) {
  return SECRET_FILE.test(relativePath.replace(/\\/g, '/'))
}

/** The real path of `path` inside `root`, or a refusal. */
export async function projectFile(root, path) {
  const canonicalRoot = await realpath(root)
  const canonicalPath = await realpath(resolve(canonicalRoot, path))
  const child = relative(canonicalRoot, canonicalPath)
  if (child.startsWith('..') || isAbsolute(child)) {
    throw new Error('The requested path is outside this project.')
  }
  return canonicalPath
}

/** A text file's contents, or null when it is missing; refuses secrets, binaries and large files. */
export async function readProjectText(root, path) {
  if (isSecretFile(path)) {
    throw new Error('Secret and key files are not shared with the agent.')
  }
  let fullPath
  try {
    fullPath = await projectFile(root, path)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null
    }
    throw error
  }
  if ((await stat(fullPath)).size > READ_MAX_BYTES) {
    throw new Error('This file is too large. Explain a selection from the editor instead.')
  }
  const text = await readFile(fullPath, 'utf8')
  if (text.includes('\0')) {
    throw new Error('Binary files cannot be read as code.')
  }
  return text
}

export async function readProjectFile(root, path, startLine = 1, endLine = startLine + 199) {
  if (
    !Number.isSafeInteger(startLine) ||
    !Number.isSafeInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine
  ) {
    throw new Error('Provide a valid line range.')
  }
  const text = await readProjectText(root, path)
  if (text === null) {
    throw new Error(`No file at ${path}.`)
  }
  const lines = text.split(/\r?\n/)
  const last = Math.min(endLine, startLine + 399, lines.length)
  const body = lines
    .slice(startLine - 1, last)
    .map((line, index) => `${startLine + index}: ${line}`)
    .join('\n')
    .slice(0, 32000)
  const more = last < lines.length ? `\n[${lines.length} lines in total]` : ''
  return { text: body + more, summary: `read ${path}:${startLine}-${last}` }
}

/**
 * Files under `root`, relative and `/`-separated, skipping dependency folders and symlinks.
 * An aborted `signal` stops the walk.
 */
async function walkProject(root, limit, visit, signal) {
  let count = 0
  const walk = async (directory) => {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (count >= limit || signal?.aborted) {
        return
      }
      const fullPath = join(directory, entry.name)
      if (entry.isDirectory() && !SKIP_DIRECTORIES.has(entry.name)) {
        await walk(fullPath)
      } else if (entry.isFile()) {
        count += 1
        await visit(fullPath, toPosix(relative(root, fullPath)))
      }
    }
  }
  await walk(root)
}

export async function listProjectFiles(root) {
  const files = []
  await walkProject(root, LIST_LIMIT, (_fullPath, relativePath) => {
    files.push(relativePath)
  })
  return { text: files.sort().join('\n'), summary: `listed ${files.length} files` }
}

export async function searchProjectCode(root, query) {
  if (typeof query !== 'string' || !query.trim()) {
    throw new Error('Provide text to search for.')
  }
  const matches = []
  await walkProject(root, LIST_LIMIT, async (fullPath, relativePath) => {
    if (matches.length >= SEARCH_LIMIT || isSecretFile(relativePath)) {
      return
    }
    try {
      if ((await stat(fullPath)).size > SEARCH_MAX_BYTES) {
        return
      }
      const text = await readFile(fullPath, 'utf8')
      if (text.includes('\0')) {
        return
      }
      const lines = text.split(/\r?\n/)
      for (let index = 0; index < lines.length && matches.length < SEARCH_LIMIT; index++) {
        if (lines[index].includes(query)) {
          matches.push(`${relativePath}:${index + 1}: ${lines[index].slice(0, 500)}`)
        }
      }
    } catch {
      // Files may disappear while the project is being edited.
    }
  })
  return {
    text: matches.join('\n') || 'No matches in the scanned project files.',
    summary: `searched "${query}" (${matches.length} matches)`
  }
}

/** Whether the file's text is the editor's (BOM and CRLF ignored). */
async function hasText(fullPath, fingerprint) {
  try {
    // A CRLF file is longer on disk by up to one byte a line, plus a 3-byte BOM.
    const size = (await stat(fullPath)).size
    if (size < fingerprint.length || size > fingerprint.length * 4 + fingerprint.lines + 3) {
      return false
    }
    const text = normalizeText(await readFile(fullPath, 'utf8'))
    return text.length === fingerprint.length && fingerprintText(text).hash === fingerprint.hash
  } catch {
    // Unreadable files cannot be the one open in the editor.
    return false
  }
}

/**
 * The files under `root` whose text is the editor's, at most 5. Orca gives a plugin editor no
 * path, so this is how the plugin learns which file it shows. An aborted `signal` stops it;
 * `extensions` (lowercase, with the dot), when given, are the only file types checked.
 */
export async function locateFile(root, fingerprint, signal, extensions) {
  const found = []
  await walkProject(
    root,
    LOCATE_FILE_LIMIT,
    async (fullPath, relativePath) => {
      if (extensions && !extensions.has(extname(relativePath).toLowerCase())) {
        return
      }
      if (found.length < 5 && (await hasText(fullPath, fingerprint))) {
        found.push(relativePath)
      }
    },
    signal
  )
  return found
}

/** Whether `relativePath`, inside `root`, still has the editor's text. */
export async function fileHasText(root, relativePath, fingerprint) {
  try {
    return await hasText(await projectFile(root, relativePath), fingerprint)
  } catch {
    return false
  }
}
