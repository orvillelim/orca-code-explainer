import { answerBody, type AnswerContext } from './answer-markdown'
import { SUGGESTIONS, type ConversationSnapshot, type Provider, type Turn } from '../protocol'

export type ExplainPaneActions = {
  /** `shown` is what the transcript shows for a long prompt, such as a suggestion's label. */
  ask: (text: string, shown?: string) => void
  cancel: () => void
  reset: (provider: Provider) => void
  close: () => void
  /** A walkthrough step's lines in the file the answer is about; null clears the highlight. */
  onStepLines: (relativePath: string | null, lines: [number, number] | null) => void
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = className
  if (text !== undefined) {
    node.textContent = text
  }
  return node
}

function turnNode(turn: Turn, context: AnswerContext): HTMLElement {
  const node = element('article', `turn turn-${turn.role} turn-${turn.status}`)
  if (turn.role === 'user') {
    if (turn.selection) {
      const { relativePath, startLine, endLine } = turn.selection
      node.append(
        element(
          'div',
          'turn-source',
          `${relativePath}:${startLine}${endLine === startLine ? '' : `–${endLine}`}`
        )
      )
    }
    node.append(element('div', 'turn-text', turn.text))
    return node
  }
  if (turn.tools.length > 0) {
    const tools = element('details', 'turn-tools')
    tools.append(element('summary', '', `Read ${turn.tools.length} project item(s)`))
    for (const tool of turn.tools) {
      tools.append(element('div', 'turn-tool', tool))
    }
    node.append(tools)
  }
  const body = turn.text
    ? answerBody(turn.id, turn.text, turn.status !== 'streaming', context)
    : element('div', 'turn-markdown')
  if (!turn.text && turn.status === 'streaming') {
    body.append(element('p', 'muted', 'Thinking…'))
  }
  node.append(body)
  if (turn.status === 'cancelled') {
    node.append(element('div', 'turn-note', 'Stopped.'))
  }
  return node
}

/** The conversation beside the editor: transcript, suggested questions and a composer. */
export function createExplainPane(root: HTMLElement, actions: ExplainPaneActions) {
  const header = element('header', 'pane-header')
  const title = element('div', 'pane-title', 'Explain')
  const provider = element('select', 'pane-select')
  provider.title = 'Agent: picking another starts a new conversation with it'
  for (const [value, label] of [
    ['claude', 'Claude Code'],
    ['codex', 'Codex']
  ] as const) {
    const option = element('option', '', label)
    option.value = value
    provider.append(option)
  }
  // The pane's own zoom (see editor-zoom.ts); the editor zooms separately.
  const zoomGroup = element('div', 'pane-zoom')
  zoomGroup.hidden = true
  const zoomOut = element('button', 'pane-button pane-icon', '−')
  zoomOut.type = 'button'
  zoomOut.title = 'Zoom this pane out (⌘⌥- or ⌘ + scroll over it)'
  const zoomLabel = element('button', 'pane-button pane-zoom-level', '100%')
  zoomLabel.type = 'button'
  zoomLabel.title = 'Reset this pane’s zoom (⌘⌥0)'
  const zoomIn = element('button', 'pane-button pane-icon', '+')
  zoomIn.type = 'button'
  zoomIn.title = 'Zoom this pane in (⌘⌥= or ⌘ + scroll over it)'
  zoomGroup.append(zoomOut, zoomLabel, zoomIn)
  const reset = element('button', 'pane-button', 'New conversation')
  reset.type = 'button'
  const close = element('button', 'pane-button pane-icon', '×')
  close.type = 'button'
  close.title = 'Close'
  header.append(title, provider, reset, close)

  const fileLabel = element('div', 'pane-file')
  const transcript = element('div', 'pane-transcript')
  const error = element('div', 'pane-error')
  error.hidden = true
  const suggestions = element('div', 'pane-suggestions')
  for (const suggestion of SUGGESTIONS) {
    const chip = element('button', 'pane-chip', suggestion.label)
    chip.type = 'button'
    chip.addEventListener('click', () =>
      actions.ask(suggestion.prompt ?? suggestion.label, suggestion.label)
    )
    suggestions.append(chip)
  }
  const composer = element('form', 'pane-composer')
  const input = element('textarea', 'pane-input')
  input.rows = 2
  input.placeholder = 'Ask a follow-up…'
  const send = element('button', 'pane-button pane-primary', 'Send')
  send.type = 'submit'
  const stop = element('button', 'pane-button', 'Stop')
  stop.type = 'button'
  composer.append(input, send, stop)
  const footer = element('div', 'pane-footer')
  const subheader = element('div', 'pane-subheader')
  subheader.append(fileLabel, zoomGroup)
  root.append(header, subheader, transcript, error, suggestions, composer, footer)

  let busy = false
  const submit = (): void => {
    const text = input.value.trim()
    if (text && !busy) {
      input.value = ''
      actions.ask(text)
    }
  }
  composer.addEventListener('submit', (event) => {
    event.preventDefault()
    submit()
  })
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault()
      submit()
    }
  })
  stop.addEventListener('click', () => actions.cancel())
  const chosenProvider = (): Provider => (provider.value === 'codex' ? 'codex' : 'claude')
  reset.addEventListener('click', () => actions.reset(chosenProvider()))
  // The agents cannot continue each other's sessions, so switching starts a new conversation.
  provider.addEventListener('change', () => actions.reset(chosenProvider()))
  close.addEventListener('click', () => actions.close())

  const pane = {
    render(snapshot: ConversationSnapshot): void {
      busy = snapshot.busy
      const pinned = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 24
      // Each answer is about the file of the selection that asked for it.
      let relativePath: string | null = null
      transcript.replaceChildren(
        ...snapshot.turns.map((turn) => {
          if (turn.role === 'user') {
            relativePath = turn.selection?.relativePath ?? relativePath
          }
          return turnNode(turn, {
            relativePath,
            ask: (text) => !busy && actions.ask(text),
            onStepLines: actions.onStepLines
          })
        })
      )
      if (snapshot.turns.length === 0) {
        transcript.append(
          element('p', 'pane-empty', 'Highlight code and choose Explain code to start.')
        )
      }
      if (pinned) {
        transcript.scrollTop = transcript.scrollHeight
      }
      provider.value = snapshot.provider
      error.hidden = snapshot.error === null
      error.textContent = snapshot.error ?? ''
      suggestions.hidden = snapshot.busy || snapshot.turns.length === 0
      send.disabled = snapshot.busy
      stop.hidden = !snapshot.busy
      footer.textContent = snapshot.instructionFiles.length
        ? `Instructions: ${snapshot.instructionFiles.join(', ')}`
        : ''
    },
    /** Shows the latest answer; a pane filled while hidden has nothing to scroll by then. */
    scrollToEnd(): void {
      transcript.scrollTop = transcript.scrollHeight
    },
    /** Which file the explanation is about, or why it is unknown. */
    setFile(relativePath: string | null, alsoMatches: string[]): void {
      fileLabel.textContent = relativePath
        ? alsoMatches.length
          ? `${relativePath} (same text as ${alsoMatches.join(', ')})`
          : relativePath
        : 'File not found in your projects; explaining without its path.'
      fileLabel.title = fileLabel.textContent
    },
    /** Shows the zoom buttons, which call `zoom`; `percent` is the current zoom. */
    enableZoom(zoom: (direction: 'in' | 'out' | 'reset') => void): (percent: number) => void {
      zoomGroup.hidden = false
      zoomOut.addEventListener('click', () => zoom('out'))
      zoomIn.addEventListener('click', () => zoom('in'))
      zoomLabel.addEventListener('click', () => zoom('reset'))
      return (percent) => {
        zoomLabel.textContent = `${percent}%`
      }
    },
    showError(message: string): void {
      error.hidden = false
      error.textContent = message
    }
  }
  return pane
}
