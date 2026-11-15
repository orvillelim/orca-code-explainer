import type { editor } from 'monaco-editor'
import { monaco } from './monaco-setup'
import type { ExplainSelection } from '../protocol'
import { EXPLAIN_MODES, type ExplainMode } from '../explain-modes.mjs'

/** Why 48 KiB: the frame-to-worker request carries at most 64 KiB of JSON. */
const MAX_SELECTION_CHARS = 48 * 1024
const MAX_SURROUNDING_CHARS = 12 * 1024

type FileIdentity = { workspaceId: string; relativePath: string | null; languageId: string }

/** The exact selection and its neighbourhood, read from the editor's buffer, not from disk. */
export function captureSelection(
  instance: editor.IStandaloneCodeEditor,
  file: FileIdentity,
  contextLines: number
): ExplainSelection | null {
  const model = instance.getModel()
  const selection = instance.getSelection()
  if (!model || !selection || selection.isEmpty()) {
    return null
  }
  const start = Math.max(1, selection.startLineNumber - contextLines)
  const end = Math.min(model.getLineCount(), selection.endLineNumber + contextLines)
  const text = model.getValueInRange(selection)
  const surrounding = model.getValueInRange({
    startLineNumber: start,
    startColumn: 1,
    endLineNumber: end,
    endColumn: model.getLineMaxColumn(end)
  })
  return {
    ...file,
    startLine: selection.startLineNumber,
    startColumn: selection.startColumn,
    endLine: selection.endLineNumber,
    endColumn: selection.endColumn,
    text: text.slice(0, MAX_SELECTION_CHARS),
    surrounding: surrounding.slice(0, MAX_SURROUNDING_CHARS),
    surroundingStartLine: start,
    trimmed: text.length > MAX_SELECTION_CHARS
  }
}

type MenuItem = {
  mode: ExplainMode
  glyph: string
  /** Shown on the right of the button. */
  keys: string
  keybinding: number
}

const isMac = /Mac|iPhone|iPad/.test(navigator.platform)
const MOD = isMac ? '⌘' : 'Ctrl+'
const ALT = isMac ? '⌥' : 'Alt+'
const SHIFT = isMac ? '⇧' : 'Shift+'

// Why ⌘⌥ for the two new actions: Orca binds most ⌘⇧ letters and forwards them before they reach
// this frame; Mod+Alt+H and Mod+Alt+I are free.
const MENU: MenuItem[] = [
  {
    mode: 'overview',
    glyph: '◉',
    keys: `${MOD}${SHIFT}E`,
    keybinding: monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyE
  },
  {
    mode: 'callTree',
    glyph: '⑂',
    keys: `${MOD}${ALT}H`,
    keybinding: monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyH
  },
  {
    mode: 'interactive',
    glyph: '▶',
    keys: `${MOD}${ALT}I`,
    keybinding: monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyI
  }
]

/**
 * The selection menu: Explain, Call hierarchy and Interactive stacked beside a selection, the same
 * three in the context menu, and their shortcuts. Its buttons keep the selection: they never take
 * focus on mousedown.
 */
export function installExplainMenu(
  instance: editor.IStandaloneCodeEditor,
  run: (mode: ExplainMode) => void
): { setEnabled: (enabled: boolean) => void } {
  let enabled = true
  const node = document.createElement('div')
  node.className = 'explain-menu'
  node.setAttribute('role', 'menu')
  for (const item of MENU) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'explain-menu-item'
    button.setAttribute('role', 'menuitem')
    const glyph = document.createElement('span')
    glyph.className = 'explain-menu-glyph'
    glyph.textContent = item.glyph
    const label = document.createElement('span')
    label.className = 'explain-menu-label'
    label.textContent = EXPLAIN_MODES[item.mode].label
    const keys = document.createElement('kbd')
    keys.className = 'explain-menu-keys'
    keys.textContent = item.keys
    button.append(glyph, label, keys)
    button.addEventListener('mousedown', (event) => event.preventDefault())
    button.addEventListener('click', () => {
      hide()
      run(item.mode)
    })
    node.append(button)
  }

  let position: { lineNumber: number; column: number } | null = null
  const widget: editor.IContentWidget = {
    getId: () => 'orca.codeExplainer.menu',
    getDomNode: () => node,
    getPosition: () =>
      position
        ? {
            position,
            preference: [
              monaco.editor.ContentWidgetPositionPreference.BELOW,
              monaco.editor.ContentWidgetPositionPreference.ABOVE
            ]
          }
        : null
  }
  instance.addContentWidget(widget)

  // Chosen: the menu steps aside for the answer, and returns with the next selection.
  const hide = (): void => {
    position = null
    node.hidden = true
    instance.layoutContentWidget(widget)
  }
  const update = (): void => {
    const selection = instance.getSelection()
    position =
      enabled && selection && !selection.isEmpty()
        ? { lineNumber: selection.endLineNumber, column: selection.endColumn }
        : null
    node.hidden = position === null
    instance.layoutContentWidget(widget)
  }
  instance.onDidChangeCursorSelection(update)
  instance.onKeyDown((event) => {
    if (event.keyCode === monaco.KeyCode.Escape && position !== null) {
      hide()
    }
  })

  MENU.forEach((item, index) => {
    instance.addAction({
      id: `orca.codeExplainer.${item.mode}`,
      label: EXPLAIN_MODES[item.mode].label,
      precondition: 'editorHasSelection',
      keybindings: [item.keybinding],
      contextMenuGroupId: 'navigation',
      contextMenuOrder: index,
      run: () => {
        if (enabled) {
          hide()
          run(item.mode)
        }
      }
    })
  })
  update()
  return {
    setEnabled(next) {
      enabled = next
      update()
    }
  }
}
