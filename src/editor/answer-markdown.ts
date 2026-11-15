import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { monaco } from './monaco-setup'
import {
  hideStreamingWalkthroughs,
  mountWalkthroughs,
  type WalkthroughContext
} from './walkthrough'

/** Fence tags agents write, as Monaco language ids. */
const FENCE_LANGUAGES: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  py: 'python',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  yml: 'yaml',
  md: 'markdown',
  rs: 'rust',
  rb: 'ruby',
  kt: 'kotlin',
  cs: 'csharp',
  'c++': 'cpp',
  gd: 'gdscript',
  gdscript: 'gdscript'
}

function fenceLanguage(code: Element): string | null {
  const tag = /language-([\w+#-]+)/.exec(code.className)?.[1]?.toLowerCase()
  if (!tag) {
    return null
  }
  const id = FENCE_LANGUAGES[tag] ?? tag
  return monaco.languages.getLanguages().some((language) => language.id === id) ? id : null
}

/** The agent's "Ask next" list, so its questions can be clicked as follow-ups. */
function markAskNext(body: HTMLElement): void {
  for (const heading of body.querySelectorAll('h1, h2, h3, h4')) {
    const list = heading.nextElementSibling
    if (/^ask next$/i.test(heading.textContent?.trim() ?? '') && list?.matches('ul, ol')) {
      list.classList.add('ask-next')
      for (const item of list.querySelectorAll('li')) {
        item.setAttribute('role', 'button')
        item.tabIndex = 0
        item.title = 'Ask this'
      }
    }
  }
}

/** Monaco token types as the pane's palette classes (`tok-*` in editor.css). */
const TOKEN_CLASSES: [string, string][] = [
  ['comment', 'comment'],
  ['string.escape', 'number'],
  ['string', 'string'],
  ['regexp', 'number'],
  ['number', 'number'],
  ['keyword', 'keyword'],
  ['attribute.name', 'keyword'],
  ['type', 'type'],
  ['tag', 'type'],
  ['function', 'function'],
  ['variable.parameter', 'number'],
  ['delimiter', 'punctuation'],
  ['operator', 'punctuation'],
  ['invalid', 'invalid']
]

function tokenClass(type: string): string | null {
  const match = TOKEN_CLASSES.find(([prefix]) => type === prefix || type.startsWith(`${prefix}.`))
  return match ? `tok-${match[1]}` : null
}

/**
 * Colors a code block with the pane's palette. Monaco only splits the text into tokens; its theme
 * belongs to the editor, which keeps Orca's colors.
 */
async function paintCode(code: Element, language: string): Promise<void> {
  const text = (code.textContent ?? '').replace(/\n+$/, '')
  // Why colorize first: it waits for a lazily loaded grammar (GDScript) that tokenize does not.
  await monaco.editor.colorize('', language, {})
  const lines = text.split('\n')
  const fragment = document.createDocumentFragment()
  monaco.editor.tokenize(text, language).forEach((tokens, row) => {
    const line = lines[row] ?? ''
    tokens.forEach((token, index) => {
      const piece = line.slice(token.offset, tokens[index + 1]?.offset ?? line.length)
      const className = tokenClass(token.type)
      if (className) {
        const span = document.createElement('span')
        span.className = className
        span.textContent = piece
        fragment.append(span)
      } else {
        fragment.append(piece)
      }
    })
    if (row < lines.length - 1) {
      fragment.append('\n')
    }
  })
  code.replaceChildren(fragment)
}

export type AnswerContext = WalkthroughContext & {
  /** Sends a clicked "Ask next" question as a follow-up. */
  ask: (text: string) => void
}

/** Clicking or pressing Enter on an "Ask next" question asks it. */
function listenForAskNext(body: HTMLElement, ask: (text: string) => void): void {
  const askItem = (event: Event): void => {
    const item = event.target instanceof Element ? event.target.closest('.ask-next li') : null
    if (
      item?.textContent &&
      (event.type === 'click' || (event instanceof KeyboardEvent && event.key === 'Enter'))
    ) {
      ask(item.textContent.trim())
    }
  }
  body.addEventListener('click', askItem)
  body.addEventListener('keydown', askItem)
}

// Finished answers never change, so each is built once and kept, live: a walkthrough keeps its
// step and its listeners while the transcript re-renders around it.
const finished = new Map<string, HTMLElement>()

/** An answer's body: sanitized Markdown, colored code, and interactive walkthroughs once done. */
export function answerBody(
  key: string,
  text: string,
  done: boolean,
  context: AnswerContext
): HTMLElement {
  const cached = done ? finished.get(key) : undefined
  if (cached) {
    return cached
  }
  const body = document.createElement('div')
  body.className = 'turn-markdown'
  body.innerHTML = DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true }))
  markAskNext(body)
  listenForAskNext(body, context.ask)
  if (!done) {
    hideStreamingWalkthroughs(body)
    return body
  }
  mountWalkthroughs(body, context)
  for (const code of body.querySelectorAll('pre > code')) {
    const language = fenceLanguage(code)
    if (language) {
      void paintCode(code, language).catch(() => undefined)
    }
  }
  finished.set(key, body)
  return body
}
