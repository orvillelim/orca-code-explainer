import type { editor, IPosition, Selection } from 'monaco-editor'
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

// Why ⌘⌥ for the other actions: Orca binds most ⌘⇧ letters and forwards them before they reach
// this frame; Mod+Alt+H and Mod+Alt+I are free, and Mod+Alt+B is chosen to match.
const MENU: MenuItem[] = [
  {
    mode: 'overview',
    glyph: '◉',
    keys: `${MOD}${SHIFT}E`,
    keybinding: monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyE
  },
  {
    mode: 'breakdown',
    glyph: '≡',
    keys: `${MOD}${ALT}B`,
    keybinding: monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyB
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
 * The selection menu: Explain, Break it down, Call hierarchy and Interactive stacked beside a
 * selection, the same four in the context menu, and their shortcuts. Its buttons keep the
 * selection: they never take focus on mousedown.
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

  // Closed (an action chosen, Escape, a press elsewhere): it returns with the next selection.
  const hide = (): void => {
    position = null
    node.hidden = true
    instance.layoutContentWidget(widget)
  }
  // Where the menu opens: where the pointer let go of a mouse selection, else at the cursor's end
  // of the selection. Why not the selection's end: a selection dragged upwards, or taller than the
  // view, ends far from the pointer.
  let pointerAnchor: IPosition | null = null
  let dragging = false
  const anchorOf = (selection: Selection): IPosition => {
    if (pointerAnchor) {
      return pointerAnchor
    }
    const { positionLineNumber: lineNumber, positionColumn: column } = selection
    // A whole-line selection (triple click, line numbers) ends at column 1 of the line below it.
    const model = instance.getModel()
    if (model && column === 1 && lineNumber > selection.startLineNumber) {
      return { lineNumber: lineNumber - 1, column: model.getLineMaxColumn(lineNumber - 1) }
    }
    return { lineNumber, column }
  }
  const update = (): void => {
    const selection = instance.getSelection()
    position =
      enabled && !dragging && selection && !selection.isEmpty() ? anchorOf(selection) : null
    node.hidden = position === null
    instance.layoutContentWidget(widget)
  }
  // While the menu is open, a press on the code only closes it and keeps the highlight; the next
  // press acts as usual. Presses elsewhere (pane, scrollbar, right-click) close it and go through.
  const selectingTargets = new Set<editor.MouseTargetType>([
    monaco.editor.MouseTargetType.CONTENT_TEXT,
    monaco.editor.MouseTargetType.CONTENT_EMPTY,
    monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS,
    monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS,
    monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN
  ])
  let swallowing = false
  // A press in the editor may make a new selection: the menu waits until release, then opens
  // under the pointer.
  let selectedWhilePressed = false
  window.addEventListener(
    'pointerdown',
    (event) => {
      const target = event.target instanceof Node ? event.target : null
      if (target && node.contains(target)) {
        return
      }
      const open = position !== null
      hide()
      if (event.button !== 0 || !target || !instance.getDomNode()?.contains(target)) {
        return
      }
      const hit = instance.getTargetAtClientPoint(event.clientX, event.clientY)
      if (open && hit && selectingTargets.has(hit.type)) {
        // Why both: Monaco selects on mousedown, which a cancelled pointerdown no longer sends.
        event.preventDefault()
        event.stopPropagation()
        swallowing = true
        return
      }
      dragging = true
      selectedWhilePressed = false
    },
    true
  )
  window.addEventListener(
    'mousedown',
    (event) => {
      if (swallowing) {
        event.preventDefault()
        event.stopPropagation()
      }
    },
    true
  )
  const release = (event: PointerEvent): void => {
    swallowing = false
    if (!dragging) {
      return
    }
    dragging = false
    // The press scrolled or clicked aside without selecting, so the menu stays closed.
    if (!selectedWhilePressed) {
      return
    }
    const target = instance.getTargetAtClientPoint(event.clientX, event.clientY)
    pointerAnchor = target?.position ?? null
    update()
  }
  // Clicked outside this frame, in the rest of Orca.
  window.addEventListener('blur', hide)
  // Why the window: Monaco captures the pointer for a drag, which can end outside the editor.
  window.addEventListener('pointerup', release, true)
  window.addEventListener('pointercancel', release, true)
  instance.onDidChangeCursorSelection((event) => {
    selectedWhilePressed ||= dragging
    if (event.source !== 'mouse') {
      pointerAnchor = null
      dragging = false
    }
    update()
  })
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
