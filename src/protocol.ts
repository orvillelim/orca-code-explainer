/** Messages between the editor frame and the worker. The worker (plain .mjs) follows these shapes. */
import { BREAKDOWN_DIAGRAM_PROMPT, CALL_TREE_PROMPT, type ExplainMode } from './explain-modes.mjs'

export type { ExplainMode }

export type Provider = 'claude' | 'codex'

/** Where the open file is, found by content: Orca gives a plugin editor no path. */
export type LocatedFile = {
  workspaceId: string | null
  /** Null for a new file, or one whose saved text no longer matches the editor. */
  relativePath: string | null
  /** Other files with the same text; the first match is used. */
  alsoMatches: string[]
}

export type TextFingerprint = { hash: string; length: number; lines: number }

/** What the frame captured from its Monaco buffer, unsaved edits included. */
export type ExplainSelection = {
  workspaceId: string
  relativePath: string | null
  languageId: string
  startLine: number
  startColumn: number
  endLine: number
  endColumn: number
  text: string
  /** The selection with up to `contextLines` lines on each side. */
  surrounding: string
  surroundingStartLine: number
  /** The selection was cut to fit the request size. */
  trimmed: boolean
}

export type TurnStatus = 'streaming' | 'done' | 'error' | 'cancelled'

export type Turn = {
  id: string
  role: 'user' | 'assistant'
  text: string
  status: TurnStatus
  /** User turns that came from a selection. */
  selection?: { relativePath: string; startLine: number; endLine: number }
  /** User turns from the selection menu: which of its actions. */
  mode?: ExplainMode
  /** Assistant turns: project reads the agent made, as one-line summaries. */
  tools: string[]
}

export type ConversationSnapshot = {
  workspaceId: string
  provider: Provider
  busy: boolean
  error: string | null
  instructionFiles: string[]
  turns: Turn[]
}

declare module 'orca' {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- declaration merging needs an interface
  interface PluginRequests {
    locate: { input: { fingerprint: TextFingerprint }; output: LocatedFile }
    explain: {
      input: { selection: ExplainSelection; mode?: ExplainMode }
      output: { started: true }
    }
    ask: {
      /** `shown` replaces a long prompt in the transcript. */
      input: { workspaceId: string; text: string; shown?: string }
      output: { started: true }
    }
    cancel: { input: { workspaceId: string }; output: { cancelled: boolean } }
    reset: { input: { workspaceId: string; provider?: Provider }; output: ConversationSnapshot }
    state: { input: { workspaceId: string }; output: ConversationSnapshot }
  }
  // oxlint-disable-next-line typescript/consistent-type-definitions -- declaration merging needs an interface
  interface PluginPanelEvents {
    /** The whole conversation of one workspace, throttled while it streams. */
    conversation: ConversationSnapshot
  }
}

/** A chip's label, and the follow-up it sends when that is longer than the label. */
export type Suggestion = { label: string; prompt?: string }

export const SUGGESTIONS: readonly Suggestion[] = [
  { label: 'Show the call tree', prompt: CALL_TREE_PROMPT },
  { label: 'Show the breakdown diagram', prompt: BREAKDOWN_DIAGRAM_PROMPT },
  { label: 'Why was it designed this way?' },
  { label: 'What does it depend on, and what depends on it?' },
  { label: 'Which edge cases can break it?' }
]
