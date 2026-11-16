import './editor.css'
import { monaco } from './monaco-setup'
import { captureSelection, installExplainMenu } from './selection-action'
import { createExplainPane } from './explain-pane'
import { fingerprintText } from '../text-fingerprint.mjs'
import { followOrcaTypography } from './editor-typography'
import { BASE_FONT_SIZE, installZoom, setHintScale } from './editor-zoom'
import { registerGodotLanguages } from './godot-languages'
import { rememberLanguage, rememberedLanguage } from './language-memory'
import type { ConversationSnapshot, ExplainMode, LocatedFile, Provider } from '../protocol'

function byId(id: string): HTMLElement {
  const node = document.getElementById(id)
  if (!node) {
    throw new Error(`editor.html lacks #${id}`)
  }
  return node
}

registerGodotLanguages()

const orca = globalThis.orca
const editorRoot = byId('editor')
const paneRoot = byId('pane')
const splitter = byId('splitter')
const conversationButton = byId('conversation')

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function themeName(): string {
  return document.documentElement.classList.contains('dark') ? 'vs-dark' : 'vs'
}

/** Monaco's language for a path, by file name or extension, as Orca's editor picks it. */
function languageFor(relativePath: string): string {
  const name = relativePath.split('/').pop()?.toLowerCase() ?? ''
  for (const language of monaco.languages.getLanguages()) {
    if (language.filenames?.some((candidate) => candidate.toLowerCase() === name)) {
      return language.id
    }
  }
  let best = { id: 'plaintext', length: 0 }
  for (const language of monaco.languages.getLanguages()) {
    for (const extension of language.extensions ?? []) {
      if (name.endsWith(extension.toLowerCase()) && extension.length > best.length) {
        best = { id: language.id, length: extension.length }
      }
    }
  }
  return best.id
}

/** Orca names no path, so the worker finds the file whose text this is. */
function locate(text: string): Promise<LocatedFile> {
  const { hash, length } = fingerprintText(text)
  return orca.plugin.request('locate', {
    fingerprint: { hash, length, lines: text.split('\n').length }
  })
}

async function start(): Promise<void> {
  if (!orca.document) {
    throw new Error('Code Explainer runs as an editor.')
  }
  const session = await orca.document.session<string>()
  // The text as opened is the saved file, so it matches before any edit. Why asked now: the
  // worker may have to start and search, which runs while Monaco builds the editor.
  const openedHash = fingerprintText(session.value).hash
  const locating = locate(session.value)
  locating.catch(() => undefined)
  const model = monaco.editor.createModel(
    session.value,
    (await rememberedLanguage(openedHash)) ?? 'plaintext'
  )
  const instance = monaco.editor.create(editorRoot, {
    model,
    theme: themeName(),
    readOnly: session.readOnly,
    automaticLayout: true,
    scrollBeyondLastLine: false,
    lineNumbers: 'on',
    renderLineHighlight: 'line',
    tabSize: 2,
    smoothScrolling: true,
    cursorSmoothCaretAnimation: 'off',
    padding: { top: 0 },
    fontSize: BASE_FONT_SIZE,
    dropIntoEditor: { enabled: false }
  })
  instance.focus()

  // Why a flag: Orca's own document must not echo back to it as an edit.
  let applyingOutside = false
  model.onDidChangeContent(() => {
    if (!applyingOutside) {
      session.change(model.getValue())
    }
  })
  session.onReplace((value) => {
    applyingOutside = true
    try {
      // Kept on the undo stack, so undo still works after an outside write.
      model.pushEditOperations([], [{ range: model.getFullModelRange(), text: value }], () => null)
    } finally {
      applyingOutside = false
    }
  })
  orca.document.onDidChange((document) => instance.updateOptions({ readOnly: document.readOnly }))
  const editorZoomedByOrca = followOrcaTypography(
    instance,
    () => monaco.editor.remeasureFonts(),
    setHintScale
  )

  // --- Explain pane ---
  let file: LocatedFile | null = null
  // A walkthrough step's source lines, highlighted while the answer's file is the open one.
  const stepLines = instance.createDecorationsCollection()
  const highlightStepLines = (
    relativePath: string | null,
    lines: [number, number] | null
  ): void => {
    if (!lines || !relativePath || relativePath !== file?.relativePath) {
      stepLines.clear()
      return
    }
    const to = Math.min(lines[1], model.getLineCount())
    const from = Math.min(lines[0], to)
    stepLines.set([
      {
        range: new monaco.Range(from, 1, to, 1),
        options: {
          isWholeLine: true,
          className: 'wt-line',
          linesDecorationsClassName: 'wt-line-gutter'
        }
      }
    ])
    instance.revealLinesInCenterIfOutsideViewport(from, to)
  }
  // The workspace's conversation is drawn only once the pane is open: an old walkthrough's
  // diagram costs a noticeable pause, which must not land on every file opened.
  let latest: ConversationSnapshot | null = null
  let paneOpen = false
  const updateConversationButton = (): void => {
    const questions = latest?.turns.filter((turn) => turn.role === 'user').length ?? 0
    conversationButton.hidden = paneOpen || questions === 0
    conversationButton.textContent = latest?.busy
      ? 'Conversation · answering…'
      : `Conversation (${questions})`
  }
  const showConversation = (snapshot: ConversationSnapshot): void => {
    latest = snapshot
    if (paneOpen) {
      pane.render(snapshot)
    }
    updateConversationButton()
  }
  const showPane = (shown: boolean): void => {
    const opening = shown && !paneOpen
    paneOpen = shown
    paneRoot.hidden = !shown
    splitter.hidden = !shown
    if (opening && latest) {
      pane.render(latest)
      pane.scrollToEnd()
    }
    if (!shown) {
      stepLines.clear()
    }
    updateConversationButton()
  }
  conversationButton.addEventListener('click', () => showPane(true))
  const pane = createExplainPane(paneRoot, {
    ask: (text, shown) => {
      if (file?.workspaceId) {
        void orca.plugin
          .request('ask', { workspaceId: file.workspaceId, text, ...(shown ? { shown } : {}) })
          .catch((error: unknown) => pane.showError(errorMessage(error)))
      }
    },
    cancel: () => {
      if (file?.workspaceId) {
        void orca.plugin.request('cancel', { workspaceId: file.workspaceId }).catch(() => undefined)
      }
    },
    reset: (provider: Provider) => {
      stepLines.clear()
      if (file?.workspaceId) {
        void orca.plugin
          .request('reset', { workspaceId: file.workspaceId, provider })
          .then(showConversation)
          .catch((error: unknown) => pane.showError(errorMessage(error)))
      }
    },
    close: () => showPane(false),
    onStepLines: highlightStepLines
  })
  orca.on('theme', () => monaco.editor.setTheme(themeName()))
  const zoom = installZoom({ instance, paneRoot, editorZoomedByOrca })
  zoom.pane.onChange(pane.enableZoom(zoom.pane.zoom))
  orca.plugin.on('conversation', (snapshot: ConversationSnapshot) => {
    if (snapshot.workspaceId === file?.workspaceId) {
      showConversation(snapshot)
    }
  })

  /** `opened`: the file was found by the text it opened with, so its language is remembered. */
  const applyLocated = (located: LocatedFile, opened = false): void => {
    file = located
    if (located.relativePath) {
      const languageId = languageFor(located.relativePath)
      monaco.editor.setModelLanguage(model, languageId)
      if (opened) {
        void rememberLanguage(openedHash, languageId).catch(() => undefined)
      }
    }
    pane.setFile(located.relativePath, located.alsoMatches)
  }
  void locating
    .then((located) => {
      applyLocated(located, true)
      if (located.workspaceId) {
        return orca.plugin
          .request('state', { workspaceId: located.workspaceId })
          .then(showConversation)
      }
      return undefined
    })
    .catch((error: unknown) => console.warn('Code Explainer: could not find this file', error))

  const explain = async (mode: ExplainMode): Promise<void> => {
    if (!file?.relativePath) {
      applyLocated(
        await locate(model.getValue()).catch(
          () => file ?? { workspaceId: null, relativePath: null, alsoMatches: [] }
        )
      )
    }
    showPane(true)
    stepLines.clear()
    if (!file?.workspaceId) {
      pane.showError('Open this file from a project on this computer to explain it.')
      return
    }
    const contextLines = await orca.settings.get('contextLines').catch(() => undefined)
    const selection = captureSelection(
      instance,
      {
        workspaceId: file.workspaceId,
        relativePath: file.relativePath,
        languageId: model.getLanguageId()
      },
      typeof contextLines === 'number' ? contextLines : 20
    )
    if (!selection) {
      return
    }
    try {
      await orca.plugin.request('explain', { selection, mode })
    } catch (error) {
      pane.showError(errorMessage(error))
    }
  }
  installExplainMenu(instance, (mode) => void explain(mode))

  // --- Splitter ---
  splitter.addEventListener('pointerdown', (event) => {
    splitter.setPointerCapture(event.pointerId)
    const move = (moved: PointerEvent): void => {
      // Why divide: the pane is zoomed, so its CSS width is its on-screen width over the zoom.
      const zoom = Number(getComputedStyle(paneRoot).zoom) || 1
      const width = Math.min(
        Math.max(window.innerWidth - moved.clientX, 260),
        window.innerWidth - 240
      )
      document.documentElement.style.setProperty('--pane-width', `${width / zoom}px`)
    }
    const up = (): void => {
      splitter.removeEventListener('pointermove', move)
      splitter.removeEventListener('pointerup', up)
    }
    splitter.addEventListener('pointermove', move)
    splitter.addEventListener('pointerup', up)
  })
}

start().catch((error: unknown) => {
  editorRoot.textContent = `Code Explainer could not open this file: ${errorMessage(error)}`
})
