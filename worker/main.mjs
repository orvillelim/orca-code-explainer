// Code Explainer worker: one conversation per workspace, explained by the Claude Code or Codex CLI,
// whose only tools read that project folder (read-only, inside the folder, secrets excluded).
import { createHash, randomUUID } from 'node:crypto'
import { agentDirectory, runAgentTurn } from './agent-cli.mjs'
import {
  formatExplanationRequest,
  loadExplainerContext,
  prepareExplainerPrompt
} from './project-context.mjs'
import { locateFile, projectFile, readProjectText } from './project-reader.mjs'
import { createWorkspaceMcp } from './workspace-mcp.mjs'
import { EXPLAIN_MODES, isExplainMode } from '../src/explain-modes.mjs'

/** How long a lookup may keep searching other workspaces after the focused one. */
const LOCATE_BUDGET_MS = 5000

/**
 * The focused workspace's row. Orca 1.4.256 (host API 1.5) names it only by display name and
 * branch; newer hosts also give its id.
 */
function focusedWorkspace(workspaces, context) {
  if (!context) {
    return null
  }
  return (
    workspaces.find((row) => context.workspaceId && row.id === context.workspaceId) ??
    workspaces.find(
      (row) => row.name === context.displayName && (row.branch ?? '') === (context.branch ?? '')
    ) ??
    null
  )
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
    current.run = { stop: () => undefined, cancelled: false }
    post(current, true)

    const fail = (message) => {
      answer.status = 'error'
      answer.text = answer.text || message
      current.error = message
    }
    try {
      const root = await requireWorkspaceRoot(current.workspaceId)
      const documents = await loadExplainerContext(
        (path) => readInstruction(root, path),
        current.provider,
        selection?.relativePath ?? ''
      )
      const prepared = prepareExplainerPrompt(
        documents,
        { hashes: current.hashes, initialized: current.started },
        text
      )
      const resume = current.started && current.agentSessionId !== null
      const sessionId = resume
        ? current.agentSessionId
        : current.provider === 'claude'
          ? randomUUID()
          : null
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
            provider: current.provider,
            prompt: prepared.prompt,
            sessionId,
            resume,
            cwd,
            mcp: binding
          },
          {
            onSession: (id) => {
              current.agentSessionId = id
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
              current.started = true
              current.hashes = prepared.hashes
              current.instructionFiles = prepared.files
            },
            onError: (message) => fail(message),
            onExit: (code, stderr) => {
              live.runs.delete(run)
              binding.release()
              if (current.run?.cancelled) {
                answer.status = 'cancelled'
              } else if (answer.status === 'streaming') {
                fail(stderr || `The agent exited with code ${code}.`)
              }
              resolve()
            }
          }
        )
        live.runs.add(run)
        current.run.stop = () => run.stop()
      })
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error))
    } finally {
      current.run = null
      post(current, true)
      await save(current)
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
    const focused = focusedWorkspace(workspaces, await orca.host.call('workspace.readContext', {}))
    const ordered = focused ? [focused, ...workspaces.filter((row) => row !== focused)] : workspaces
    const deadline = Date.now() + LOCATE_BUDGET_MS
    for (const workspace of ordered) {
      const paths = await locateFile(workspace.path, fingerprint)
      if (paths.length > 0) {
        return { workspaceId: workspace.id, relativePath: paths[0], alsoMatches: paths.slice(1) }
      }
      if (Date.now() > deadline) {
        break
      }
    }
    return { workspaceId: focused?.id ?? null, relativePath: null, alsoMatches: [] }
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
    current.run?.stop()
    current.run = null
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
