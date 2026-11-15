import type { editor } from 'monaco-editor'
// Orca's own editor-zoom steps and clamping, bundled from the repo.
import {
  computeEditorFontSize,
  nextEditorFontZoomLevel,
  type EditorZoomDirection
} from '../../vendor/orca/src/shared/editor/editor-font-zoom'

/** Orca's default editor font size, which zoom level 0 means. */
export const BASE_FONT_SIZE = 13
/** Scroll distance per zoom step, so a trackpad pinch does not jump several sizes at once. */
const WHEEL_STEP_PX = 40

export type Zoom = {
  zoom(direction: EditorZoomDirection): void
  /** Called with the zoom as a percentage of the default size, now and on each change. */
  onChange(listener: (percent: number) => void): void
}

/** One zoom level, in Orca's steps, saved in the plugin's storage and shared by every tab. */
function persistedZoom(storageKey: string, apply: (fontSize: number) => void): Zoom {
  const storage = globalThis.orca.storage
  const listeners = new Set<(percent: number) => void>()
  let level = 0
  const percent = (): number =>
    Math.round((computeEditorFontSize(BASE_FONT_SIZE, level) / BASE_FONT_SIZE) * 100)
  const set = (next: number): void => {
    level = next
    apply(computeEditorFontSize(BASE_FONT_SIZE, level))
    for (const listener of listeners) {
      listener(percent())
    }
  }
  const load = (): void => {
    void storage
      .get(storageKey)
      .then((saved) => {
        if (typeof saved === 'number' && saved !== level) {
          set(saved)
        }
      })
      .catch(() => undefined)
  }
  load()
  storage.onDidChange((change) => {
    if (change.key === storageKey) {
      load()
    }
  })
  return {
    zoom(direction) {
      const next = nextEditorFontZoomLevel(level, direction)
      if (next !== level || direction === 'reset') {
        set(next)
        void storage.set(storageKey, next).catch(() => undefined)
      }
    },
    onChange(listener) {
      listeners.add(listener)
      listener(percent())
    }
  }
}

/** Scales the "Explain code" button with the editor's font size. */
export function setHintScale(fontSize: number): void {
  document.documentElement.style.setProperty('--hint-zoom', String(fontSize / BASE_FONT_SIZE))
}

/**
 * Cmd/Ctrl + Option/Alt + `=` `-` `0`. Orca keeps Cmd/Ctrl + `=` `-` `0` for its own zoom before
 * they reach a plugin frame, so the plugin's zoom adds Option/Alt.
 */
function zoomKey(event: KeyboardEvent): EditorZoomDirection | null {
  if (!(event.metaKey || event.ctrlKey) || !event.altKey) {
    return null
  }
  // Why `code`: Option changes `key` on macOS (Option + `=` types `≠`).
  if (event.code === 'Equal' || event.code === 'NumpadAdd') {
    return 'in'
  }
  if (event.code === 'Minus' || event.code === 'NumpadSubtract') {
    return 'out'
  }
  return event.code === 'Digit0' || event.code === 'Numpad0' ? 'reset' : null
}

/**
 * Separate zoom for the editor and the explain pane. Each zooms with Cmd/Ctrl + Option/Alt +
 * `=` `-` `0` while it has focus, and with Cmd/Ctrl + scroll (or pinch) over it; the pane also has
 * buttons. `editorZoomedByOrca`: this Orca reports its own editor zoom (Cmd/Ctrl + `=`), so the
 * editor follows that instead.
 */
export function installZoom(options: {
  instance: editor.IStandaloneCodeEditor
  paneRoot: HTMLElement
  editorZoomedByOrca: boolean
}): { pane: Zoom } {
  const { instance, paneRoot } = options
  const pane = persistedZoom('paneZoomLevel', (fontSize) => {
    document.documentElement.style.setProperty('--pane-zoom', String(fontSize / BASE_FONT_SIZE))
  })
  const editorZoom = options.editorZoomedByOrca
    ? null
    : persistedZoom('editorZoomLevel', (fontSize) => {
        instance.updateOptions({ fontSize })
        setHintScale(fontSize)
      })
  const targetOf = (node: unknown): Zoom | null =>
    node instanceof Node && paneRoot.contains(node) ? pane : editorZoom

  window.addEventListener(
    'keydown',
    (event) => {
      const direction = zoomKey(event)
      const target = direction ? targetOf(document.activeElement) : null
      if (direction && target) {
        event.preventDefault()
        event.stopPropagation()
        target.zoom(direction)
      }
    },
    true
  )

  let wheel = 0
  window.addEventListener(
    'wheel',
    (event) => {
      const target = event.ctrlKey || event.metaKey ? targetOf(event.target) : null
      if (!target) {
        return
      }
      // Why: Cmd/Ctrl + scroll would otherwise scroll the editor or pane.
      event.preventDefault()
      event.stopPropagation()
      wheel += event.deltaY
      while (Math.abs(wheel) >= WHEEL_STEP_PX) {
        target.zoom(wheel < 0 ? 'in' : 'out')
        wheel -= Math.sign(wheel) * WHEEL_STEP_PX
      }
    },
    { capture: true, passive: false }
  )
  return { pane }
}
