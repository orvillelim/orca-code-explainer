// Code Explainer worker: one conversation per workspace, explained by the Claude Code or Codex CLI,
// whose only tools read that project folder (read-only, inside the folder, secrets excluded).
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { agentDirectory, agentOptions, runAgentTurn } from './agent-cli.mjs'
import {
  formatExplanationRequest,
  loadExplainerContext,
  prepareExplainerPrompt
} from './project-context.mjs'
import { fileHasText, locateFile, projectFile, readProjectText } from './project-reader.mjs'
import { createWorkspaceMcp } from './workspace-mcp.mjs'
import { EXPLAIN_MODES, isExplainMode } from '../src/explain-modes.mjs'

/** How long a lookup may keep searching other workspaces after the focused one. */
const LOCATE_BUDGET_MS = 5000
/** The file types the plugin's editors open: only these can be the file shown in one. */
const EDITOR_EXTENSIONS = new Set(
  JSON.parse(
    readFileSync(new URL('../orca-plugin.json', import.meta.url), 'utf8')
  ).contributes.customEditors.flatMap((editor) =>
    editor.extensions.map((extension) => extension.toLowerCase())
  )
)
/** Where each text was last found, so a reopened file needs no search. */
const LOCATIONS_KEY = 'locations'
const LOCATIONS_KEPT = 400

/**
 * The rows that could be the focused workspace. Orca 1.4.256 (host API 1.5) names it only by
 * display name and branch, which several can share (every checkout of `main`); newer hosts also
 * give its id.
 */
function focusCandidates(workspaces, context) {
  if (!context) {
    return []
  }
  const byId = context.workspaceId && workspaces.find((row) => row.id === context.workspaceId)
  return byId
    ? [byId]
    : workspaces.filter(
        (row) => row.name === context.displayName && (row.branch ?? '') === (context.branch ?? '')
      )
}

/** Searches `workspaces` at once; the first to find the text wins and stops the others. */
async function firstMatch(workspaces, fingerprint) {
  if (workspaces.length === 0) {
    return null
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), LOCATE_BUDGET_MS)
  try {
    return await new Promise((resolve) => {
      let pending = workspaces.length
      for (const workspace of workspaces) {
        locateFile(workspace.path, fingerprint, controller.signal, EDITOR_EXTENSIONS)
          .then((paths) => {
            if (paths.length > 0 && !controller.signal.aborted) {
              controller.abort()
              resolve({ workspace, paths })
            }
          })
          .catch(() => undefined)
          .finally(() => {
            pending -= 1
            if (pending === 0) {
              resolve(null)
            }
          })
      }
    })
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}

const POST_INTERVAL_MS = 150
const TURNS_KEPT = 30
const TURN_TEXT_MAX = 48_000
const TOOLS_KEPT = 40
const PROVIDERS = new Set(['claude', 'codex'])

/** Live agent runs and the MCP server, so `deactivate` can end them. */
const live = { runs: new Set(), mcp: null }

function hostError(code, message) {
  return Object.assign(new Error(message), { code })
}

export default function activate(orca) {
  const mcp = createWorkspaceMcp()
  live.mcp = mcp
  /** @type {Map<string, any>} */
  const conversations = new Map()
  const storageKey = (workspaceId) =>
    `conversation:${createHash('sha256').update(workspaceId).digest('hex').slice(0, 32)}`

  async function savedLocations() {
    const saved = await orca.storage.get(LOCATIONS_KEY).catch(() => null)
    return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {}
  }

  // Keyed `<workspace id>-<text hash>`: the same file in two worktrees is two entries, and a
  // workspace's entries share its prefix. The hash is base 36, so the last `-` starts it.
  const locationKey = (workspaceId, hash) => `${workspaceId}-${hash}`
  const keyWorkspace = (key) => key.slice(0, Math.max(0, key.lastIndexOf('-')))

  /** Where this text was found before in `workspaces`: workspace id → `{ relativePath, alsoMatches }`. */
  async function rememberedPlaces(workspaces, hash) {
    const locations = await savedLocations()
    const places = new Map()
    for (const workspace of workspaces) {
      const place = locations[locationKey(workspace.id, hash)]
      if (typeof place?.relativePath === 'string') {
        places.set(workspace.id, {
          relativePath: place.relativePath,
          alsoMatches: Array.isArray(place.alsoMatches) ? place.alsoMatches : []
        })
      }
    }
    return places
  }

  /** Drops the locations of workspaces Orca no longer lists. */
  async function forgetRemovedWorkspaces() {
    const { workspaces, truncated } = await orca.host.call('workspace.list', {})
    // A cut-off list would drop the workspaces past its end.
    if (truncated) {
      return
    }
    const listed = new Set(workspaces.map((workspace) => workspace.id))
    const locations = await savedLocations()
    const stale = Object.keys(locations).filter((key) => !listed.has(keyWorkspace(key)))
    if (stale.length === 0) {
      return
    }
    for (const key of stale) {
      delete locations[key]
    }
    await orca.storage.set(LOCATIONS_KEY, locations)
  }
  // Why compare with the list: the event names the workspace by Orca's internal worktree id, not
  // the id `workspace.list` gives and the keys use. Orca sends no event for folder workspaces;
  // theirs age out under the cap.
  orca.events?.on('workspace.removed', () =>
    forgetRemovedWorkspaces().catch((error) =>
      orca.log(`could not forget a removed workspace's files: ${error.message}`)
    )
  )

  async function remember(workspaceId, hash, place) {
    const locations = await savedLocations()
    const key = locationKey(workspaceId, hash)
    // Why delete first: a key set again moves to the end, so the newest survive the cap.
    delete locations[key]
    locations[key] = place
    const keys = Object.keys(locations)
    for (const key of keys.slice(0, Math.max(0, keys.length - LOCATIONS_KEPT))) {
      delete locations[key]
    }
    await orca.storage
      .set(LOCATIONS_KEY, locations)
      .catch((error) => orca.log(`could not remember where a file is: ${error.message}`))
  }

  async function defaultProvider() {
    const provider = await orca.settings.get('provider').catch(() => null)
    return PROVIDERS.has(provider) ? provider : 'claude'
  }

  async function conversation(workspaceId) {
    let current = conversations.get(workspaceId)
    if (!current) {
      const saved = await orca.storage.get(storageKey(workspaceId)).catch(() => null)
      current = {
        workspaceId,
        provider: PROVIDERS.has(saved?.provider) ? saved.provider : await defaultProvider(),
        agentSessionId: typeof saved?.agentSessionId === 'string' ? saved.agentSessionId : null,
        started: saved?.started === true,
        hashes: saved?.hashes && typeof saved.hashes === 'object' ? saved.hashes : {},
        instructionFiles: Array.isArray(saved?.instructionFiles) ? saved.instructionFiles : [],
        turns: Array.isArray(saved?.turns) ? saved.turns : [],
        error: null,
        run: null,
        // Bumped by reset, so a turn from before it cannot write into the new conversation.
        generation: 0,
        postTimer: null
      }
      conversations.set(workspaceId, current)
    }
    return current
  }

  function snapshot(current) {
    return {
      workspaceId: current.workspaceId,
      provider: current.provider,
      busy: current.run !== null,
      error: current.error,
      instructionFiles: current.instructionFiles,
      turns: current.turns.slice(-TURNS_KEPT).map((turn) => ({
        ...turn,
        text:
          turn.text.length > TURN_TEXT_MAX
            ? `${turn.text.slice(0, TURN_TEXT_MAX)}\n\n…`
            : turn.text,
        tools: turn.tools.slice(-TOOLS_KEPT)
      }))
    }
  }

  function post(current, now = false) {
    const send = () => {
      current.postTimer = null
      orca.panels.post('conversation', snapshot(current))
    }
    if (now) {
      clearTimeout(current.postTimer)
      send()
    } else if (!current.postTimer) {
      current.postTimer = setTimeout(send, POST_INTERVAL_MS)
    }
  }

  async function save(current) {
    await orca.storage
      .set(storageKey(current.workspaceId), {
        provider: current.provider,
        agentSessionId: current.agentSessionId,
        started: current.started,
        hashes: current.hashes,
        instructionFiles: current.instructionFiles,
        turns: snapshot(current).turns.filter((turn) => turn.status !== 'streaming')
      })
      .catch((error) => orca.log(`could not save the conversation: ${error.message}`))
  }

  /** Workspaces on this computer, as `workspace.list` gives them: other hosts' folders are not here. */
  async function localWorkspaces() {
    const { workspaces } = await orca.host.call('workspace.list', {})
    return workspaces.filter((workspace) => !workspace.hostId || workspace.hostId === 'local')
  }

  /** The workspace's folder; the file, when named, must resolve inside it. */
  async function requireWorkspaceRoot(workspaceId, relativePath) {
    const row = (await localWorkspaces()).find((workspace) => workspace.id === workspaceId)
    if (!row) {
      throw hostError(
        'unavailable',
        'Code Explainer reads projects on this computer only, and Orca does not list this one here.'
      )
    }
    if (relativePath) {
      try {
        await projectFile(row.path, relativePath)
      } catch (error) {
        // A file deleted or renamed since it was found is still explained from the buffer.
        if (error?.code !== 'ENOENT') {
          throw hostError('invalid_params', 'The selected file is outside this workspace.')
        }
      }
    }
    return row.path
  }

  async function readInstruction(root, relativePath) {
    try {
      return await readProjectText(root, relativePath)
    } catch {
      return null
    }
  }

  /** `selection` and `mode`: a menu action on a selection; `shown`: the transcript's label for `text`. */
  async function startTurn(current, text, { selection, mode, shown } = {}) {
    if (current.run) {
      throw hostError('conflict', 'The agent is still answering. Stop it or wait.')
    }
    current.error = null
    const userTurn = {
      id: randomUUID(),
      role: 'user',
      text: selection
        ? `${EXPLAIN_MODES[mode ?? 'overview'].label} · ${selection.relativePath ?? 'the selection'}`
        : (shown ?? text),
      status: 'done',
      tools: [],
      ...(selection
        ? {
            selection: {
              relativePath: selection.relativePath ?? 'unsaved file',
              startLine: selection.startLine,
              endLine: selection.endLine
            },
            mode: mode ?? 'overview'
          }
        : {})
    }
    const answer = { id: randomUUID(), role: 'assistant', text: '', status: 'streaming', tools: [] }
    current.turns.push(userTurn, answer)
    const handle = { stop: () => undefined, cancelled: false }
    current.run = handle
    // Why captured: New conversation or another agent may reset `current` while this turn runs.
    const { provider, generation } = current
    const stale = () => current.generation !== generation
    post(current, true)

    const fail = (message) => {
      answer.status = 'error'
      answer.text = answer.text || message
      if (!stale()) {
        current.error = message
      }
    }
    try {
      const root = await requireWorkspaceRoot(current.workspaceId)
      const documents = await loadExplainerContext(
        (path) => readInstruction(root, path),
        provider,
        selection?.relativePath ?? ''
      )
      const prepared = prepareExplainerPrompt(
        documents,
        { hashes: current.hashes, initialized: current.started },
        text
      )
      const resume = current.started && current.agentSessionId !== null
      const sessionId = resume ? current.agentSessionId : provider === 'claude' ? randomUUID() : null
      // Read per question, so a changed setting applies from the next one.
      const options = agentOptions(provider, {
        model: await orca.settings.get(`${provider}Model`).catch(() => ''),
        effort: await orca.settings.get(`${provider}Effort`).catch(() => 'default')
      })
      if (stale() || handle.cancelled) {
        answer.status = 'cancelled'
        return
      }
      const binding = await mcp.bind(root, (summary) => {
        answer.tools.push(summary)
        post(current)
      })
      const cwd = agentDirectory(
        createHash('sha256').update(current.workspaceId).digest('hex').slice(0, 24)
      )
      let paragraphs = 0
      const codexMessages = new Map()
      await new Promise((resolve) => {
        const run = runAgentTurn(
          {
            provider,
            prompt: prepared.prompt,
            sessionId,
            resume,
            cwd,
            mcp: binding,
            ...options
          },
          {
            onSession: (id) => {
              if (!stale()) {
                current.agentSessionId = id
              }
            },
            onParagraph: () => {
              if (paragraphs++ > 0 && answer.text && !answer.text.endsWith('\n\n')) {
                answer.text += '\n\n'
              }
            },
            onDelta: (delta) => {
              answer.text += delta
              post(current)
            },
            onMessage: (id, message) => {
              codexMessages.set(id, message)
              answer.text = [...codexMessages.values()].join('\n\n')
              post(current)
            },
            onFinal: (final) => {
              if (!answer.text && final) {
                answer.text = final
              }
              answer.status = 'done'
              if (!stale()) {
                current.started = true
                current.hashes = prepared.hashes
                current.instructionFiles = prepared.files
              }
            },
            onError: (message) => fail(message),
            onExit: (code, stderr) => {
              live.runs.delete(run)
              binding.release()
              if (handle.cancelled) {
                answer.status = 'cancelled'
              } else if (answer.status === 'streaming') {
                fail(stderr || `The agent exited with code ${code}.`)
              }
              resolve()
            }
          }
        )
        live.runs.add(run)
        handle.stop = () => run.stop()
        // Stopped while it was still starting up.
        if (handle.cancelled) {
          run.stop()
        }
      })
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error))
    } finally {
      // A reset already cleared this run, and a newer turn may be running.
      if (current.run === handle) {
        current.run = null
      }
      if (!stale()) {
        post(current, true)
        await save(current)
      }
    }
  }

  function begin(current, text, details) {
    if (current.run) {
      throw hostError('conflict', 'The agent is still answering. Stop it or wait.')
    }
    // Why not awaited: a turn outlives the 120 s request limit; progress arrives as posts.
    void startTurn(current, text, details).catch((error) =>
      orca.log(`turn failed: ${error.message}`)
    )
    return { started: true }
  }

  // Orca gives a plugin editor its text but not its path: find the file by content, in the focused
  // workspace first, then in the other workspaces on this computer.
  orca.panels.handle('locate', async (input) => {
    const fingerprint = input?.fingerprint
    if (
      typeof fingerprint?.hash !== 'string' ||
      !Number.isInteger(fingerprint.length) ||
      !Number.isInteger(fingerprint.lines)
    ) {
      throw hostError('invalid_params', 'A text fingerprint is required.')
    }
    const workspaces = await localWorkspaces()
    const candidates = focusCandidates(
      workspaces,
      await orca.host.call('workspace.readContext', {})
    )
    // Only a workspace Orca singles out goes first: the same file may be in several worktrees.
    const focused = candidates.length === 1 ? candidates[0] : null
    const found = (workspace, relativePath, alsoMatches) => {
      void remember(workspace.id, fingerprint.hash, { relativePath, alsoMatches })
      return { workspaceId: workspace.id, relativePath, alsoMatches }
    }
    const places = await rememberedPlaces(workspaces, fingerprint.hash)
    /** This workspace's remembered place for the text, if the file there still has it. */
    const rememberedIn = async (workspace) => {
      const place = places.get(workspace.id)
      return place && (await fileHasText(workspace.path, place.relativePath, fingerprint))
        ? place
        : null
    }

    if (focused) {
      const own = await rememberedIn(focused)
      if (own) {
        return found(focused, own.relativePath, own.alsoMatches)
      }
      // Worktrees share their layout: where the text was in another one is the first guess here.
      for (const { relativePath } of places.values()) {
        if (await fileHasText(focused.path, relativePath, fingerprint)) {
          return found(focused, relativePath, [])
        }
      }
      const paths = await locateFile(focused.path, fingerprint, undefined, EDITOR_EXTENSIONS)
      if (paths.length > 0) {
        return found(focused, paths[0], paths.slice(1))
      }
    }
    // The workspaces that could be the focused one come first: a file is opened from it.
    const others = workspaces.filter((row) => row !== focused)
    const likely = others.filter((row) => candidates.includes(row))
    const unlikely = others.filter((row) => !candidates.includes(row))
    for (const workspace of [...likely, ...unlikely]) {
      const place = await rememberedIn(workspace)
      if (place) {
        return found(workspace, place.relativePath, place.alsoMatches)
      }
    }
    // Searched only when no workspace has this text remembered.
    const match =
      (await firstMatch(likely, fingerprint)) ?? (await firstMatch(unlikely, fingerprint))
    if (match) {
      return found(match.workspace, match.paths[0], match.paths.slice(1))
    }
    return { workspaceId: candidates[0]?.id ?? null, relativePath: null, alsoMatches: [] }
  })

  orca.panels.handle('explain', async (input) => {
    const selection = input?.selection
    if (
      !selection ||
      typeof selection.workspaceId !== 'string' ||
      typeof selection.text !== 'string'
    ) {
      throw hostError('invalid_params', 'A selection is required.')
    }
    const mode = isExplainMode(input.mode) ? input.mode : 'overview'
    await requireWorkspaceRoot(selection.workspaceId, selection.relativePath)
    const current = await conversation(selection.workspaceId)
    return begin(current, formatExplanationRequest(selection, mode), { selection, mode })
  })

  orca.panels.handle('ask', async (input) => {
    const text = typeof input?.text === 'string' ? input.text.trim().slice(0, 8000) : ''
    if (!text || typeof input?.workspaceId !== 'string') {
      throw hostError('invalid_params', 'A question is required.')
    }
    await requireWorkspaceRoot(input.workspaceId)
    const shown = typeof input.shown === 'string' ? input.shown.slice(0, 200) : undefined
    return begin(await conversation(input.workspaceId), text, { shown })
  })

  orca.panels.handle('cancel', async (input) => {
    const current = conversations.get(input?.workspaceId)
    if (!current?.run) {
      return { cancelled: false }
    }
    current.run.cancelled = true
    current.run.stop()
    return { cancelled: true }
  })

  orca.panels.handle('reset', async (input) => {
    const current = await conversation(input?.workspaceId)
    if (current.run) {
      current.run.cancelled = true
      current.run.stop()
    }
    current.run = null
    current.generation += 1
    current.provider = PROVIDERS.has(input?.provider) ? input.provider : await defaultProvider()
    current.agentSessionId = null
    current.started = false
    current.hashes = {}
    current.instructionFiles = []
    current.turns = []
    current.error = null
    await save(current)
    post(current, true)
    return snapshot(current)
  })

  orca.panels.handle('state', async (input) => {
    if (typeof input?.workspaceId !== 'string') {
      throw hostError('invalid_params', 'workspaceId is required.')
    }
    return snapshot(await conversation(input.workspaceId))
  })
}

export function deactivate() {
  for (const run of live.runs) {
    run.stop()
  }
  live.runs.clear()
  live.mcp?.close()
}
