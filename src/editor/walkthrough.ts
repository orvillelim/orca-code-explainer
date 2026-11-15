// The Interactive answer: a flowchart the reader steps through, state by state, with the active
// boxes, the variable values and the source lines of each step. The agent writes it as JSON in an
// `explainer-walkthrough` fence (see explain-modes.mjs); nothing it writes is run as code.
import { WALKTHROUGH_FENCE } from '../explain-modes.mjs'
import type * as MermaidRuntime from './mermaid-runtime'

const MAX_STEPS = 40
const MAX_STATES = 12
const MAX_DIAGRAM_CHARS = 6000
const NODE_ID = /^[A-Za-z][A-Za-z0-9_]{0,31}$/
const SHORT_TEXT = 400
/** Smallest scale a diagram is shrunk to so it fits; below it, labels stop being readable and the
 *  diagram scrolls instead. */
const MIN_FIT_SCALE = 0.7

export type WalkthroughStep = {
  state: string | null
  nodes: string[]
  lines: [number, number] | null
  vars: [string, string][]
  note: string
}

export type Walkthrough = {
  title: string
  diagram: string
  states: { id: string; label: string }[]
  steps: WalkthroughStep[]
}

/** What the widget needs from the pane: where its lines are, and the editor to show them in. */
export type WalkthroughContext = {
  /** The selected file the answer is about; lines highlight only while it is open. */
  relativePath: string | null
  onStepLines: (relativePath: string | null, lines: [number, number] | null) => void
}

function text(value: unknown, max = SHORT_TEXT): string {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

function lineRange(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null
  }
  const from = Number(value[0])
  const to = Number(value[1] ?? value[0])
  return Number.isInteger(from) && Number.isInteger(to) && from >= 1 && to >= from
    ? [from, to]
    : null
}

function variables(value: unknown): [string, string][] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return []
  }
  return Object.entries(value)
    .slice(0, 16)
    .map(([name, raw]): [string, string] => [
      name.slice(0, 64),
      typeof raw === 'string' ? raw.slice(0, 120) : (JSON.stringify(raw)?.slice(0, 120) ?? '')
    ])
}

/** The agent's JSON as a walkthrough, or the reason it cannot be drawn. */
export function parseWalkthrough(source: string): Walkthrough | { error: string } {
  let raw: unknown
  try {
    raw = JSON.parse(source)
  } catch {
    return { error: 'The walkthrough is not valid JSON.' }
  }
  if (typeof raw !== 'object' || raw === null) {
    return { error: 'The walkthrough is empty.' }
  }
  const record: Record<string, unknown> = { ...raw }
  const diagram = text(record.diagram, MAX_DIAGRAM_CHARS + 1)
  if (!/^\s*(flowchart|graph)\s+(TD|TB|LR|RL|BT)\b/.test(diagram)) {
    return { error: 'The walkthrough has no Mermaid flowchart.' }
  }
  if (diagram.length > MAX_DIAGRAM_CHARS) {
    return { error: 'The walkthrough diagram is too large.' }
  }
  const states = (Array.isArray(record.states) ? record.states : [])
    .slice(0, MAX_STATES)
    .flatMap((entry: unknown) => {
      const state: Record<string, unknown> =
        typeof entry === 'object' && entry !== null ? { ...entry } : {}
      const id = text(state.id, 64)
      return id ? [{ id, label: text(state.label, 80) || id }] : []
    })
  const stateIds = new Set(states.map((state) => state.id))
  const steps = (Array.isArray(record.steps) ? record.steps : [])
    .slice(0, MAX_STEPS)
    .flatMap((entry: unknown): WalkthroughStep[] => {
      const step: Record<string, unknown> =
        typeof entry === 'object' && entry !== null ? { ...entry } : {}
      const state = text(step.state, 64)
      return [
        {
          state: stateIds.has(state) ? state : null,
          nodes: (Array.isArray(step.nodes) ? step.nodes : []).filter(
            (node: unknown): node is string => typeof node === 'string' && NODE_ID.test(node)
          ),
          lines: lineRange(step.lines),
          vars: variables(step.vars),
          note: text(step.note)
        }
      ]
    })
  if (steps.length === 0) {
    return { error: 'The walkthrough has no steps.' }
  }
  return { title: text(record.title, 160), diagram, states, steps }
}

let runtime: Promise<typeof MermaidRuntime> | null = null

/** dist/mermaid-runtime.js, fetched the first time a walkthrough is drawn. */
function loadRuntime(): Promise<typeof MermaidRuntime> {
  runtime ??= import(new URL('mermaid-runtime.js', document.baseURI).href).catch(
    (error: unknown) => {
      runtime = null
      throw error
    }
  )
  return runtime
}

async function renderDiagram(diagram: string): Promise<string> {
  const isDark = document.documentElement.classList.contains('dark')
  // The pane's palette (editor.css) in dark mode; Mermaid's default theme in light mode.
  const colors = isDark
    ? {
        background: '#161d27',
        foreground: '#dbe3ec',
        primary: '#222c38',
        secondary: '#1b2430',
        tertiary: '#0f141b',
        border: '#3a4756'
      }
    : undefined
  return (await loadRuntime()).renderFlowchart(diagram, isDark, colors)
}

/** The node ids Mermaid drew, by element: `data-id`, else its `flowchart-<id>-<n>` element id. */
function diagramNodes(svg: Element): Map<string, Element[]> {
  const nodes = new Map<string, Element[]>()
  for (const node of svg.querySelectorAll('g.node')) {
    const id =
      node.getAttribute('data-id') ?? /(?:^|-)flowchart-([A-Za-z0-9_]+)-\d+$/.exec(node.id)?.[1]
    if (id) {
      nodes.set(id, [...(nodes.get(id) ?? []), node])
    }
  }
  return nodes
}

/** Scales a drawn diagram to fit its area, both ways, never above its natural size. */
function fitDiagram(area: HTMLElement, svg: SVGSVGElement): void {
  const box = svg.viewBox.baseVal
  if (!box || box.width === 0 || box.height === 0) {
    return
  }
  const style = getComputedStyle(area)
  const width =
    area.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight)
  const height =
    Number.parseFloat(style.maxHeight) -
    Number.parseFloat(style.paddingTop) -
    Number.parseFloat(style.paddingBottom)
  const scale = Math.max(
    MIN_FIT_SCALE,
    Math.min(1, width / box.width, Number.isFinite(height) ? height / box.height : 1)
  )
  svg.style.maxWidth = 'none'
  svg.setAttribute('width', String(Math.round(box.width * scale)))
  svg.setAttribute('height', String(Math.round(box.height * scale)))
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  content?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = className
  if (content !== undefined) {
    node.textContent = content
  }
  return node
}

/** The interactive widget for one walkthrough. */
export function createWalkthrough(walk: Walkthrough, context: WalkthroughContext): HTMLElement {
  const root = element('div', 'wt')
  root.tabIndex = 0
  root.setAttribute('aria-label', 'Interactive walkthrough; use the arrow keys to step')
  if (walk.title) {
    root.append(element('div', 'wt-title', walk.title))
  }
  const chips = element('div', 'wt-states')
  const chipFor = new Map<string, HTMLButtonElement>()
  for (const state of walk.states) {
    const chip = element('button', 'wt-state', state.label)
    chip.type = 'button'
    chip.addEventListener('click', () => {
      const first = walk.steps.findIndex((step) => step.state === state.id)
      if (first !== -1) {
        show(first, true)
      }
    })
    chipFor.set(state.id, chip)
    chips.append(chip)
  }
  if (walk.states.length > 1) {
    root.append(chips)
  }
  const diagram = element('div', 'wt-diagram')
  diagram.append(element('p', 'muted', 'Drawing the flowchart…'))
  const controls = element('div', 'wt-controls')
  const prev = element('button', 'pane-button', '◀ Prev')
  prev.type = 'button'
  const counter = element('span', 'wt-counter')
  const next = element('button', 'pane-button', 'Next ▶')
  next.type = 'button'
  controls.append(prev, counter, next)
  const note = element('p', 'wt-note')
  const lines = element('div', 'wt-lines')
  const vars = element('table', 'wt-vars')
  // Why above the diagram: a tall flowchart would push the step controls out of view.
  root.append(controls, note, lines, vars, diagram)

  let nodes = new Map<string, Element[]>()
  let current = 0
  const show = (index: number, reveal: boolean): void => {
    current = Math.max(0, Math.min(walk.steps.length - 1, index))
    const step = walk.steps[current]
    if (!step) {
      return
    }
    counter.textContent = `Step ${current + 1} / ${walk.steps.length}`
    prev.disabled = current === 0
    next.disabled = current === walk.steps.length - 1
    for (const [id, chip] of chipFor) {
      chip.classList.toggle('wt-state-active', id === step.state)
    }
    const visited = new Set(walk.steps.slice(0, current).flatMap((done) => done.nodes))
    for (const [id, drawn] of nodes) {
      for (const node of drawn) {
        node.classList.toggle('wt-active', step.nodes.includes(id))
        node.classList.toggle('wt-visited', !step.nodes.includes(id) && visited.has(id))
      }
    }
    note.textContent = step.note
    lines.textContent = step.lines
      ? `Lines ${step.lines[0]}${step.lines[1] === step.lines[0] ? '' : `–${step.lines[1]}`}${context.relativePath ? ` · ${context.relativePath}` : ''}`
      : ''
    const before = new Map(current > 0 ? walk.steps[current - 1]?.vars : [])
    vars.replaceChildren(
      ...step.vars.map(([name, value]) => {
        const row = element('tr', before.get(name) === value ? '' : 'wt-changed')
        row.append(element('th', '', name), element('td', '', value))
        return row
      })
    )
    vars.hidden = step.vars.length === 0
    // Keep the active box in view inside the diagram's own scroll area.
    const active = step.nodes.flatMap((id) => nodes.get(id) ?? [])[0]
    if (active) {
      const box = active.getBoundingClientRect()
      const view = diagram.getBoundingClientRect()
      if (box.top < view.top || box.bottom > view.bottom) {
        diagram.scrollTop += box.top - view.top - view.height / 2 + box.height / 2
      }
    }
    if (reveal) {
      context.onStepLines(context.relativePath, step.lines)
    }
  }
  prev.addEventListener('click', () => show(current - 1, true))
  next.addEventListener('click', () => show(current + 1, true))
  root.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault()
      show(current + 1, true)
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault()
      show(current - 1, true)
    }
  })
  // Why on focus: an answer restored from an earlier session should not move the editor until
  // the reader turns to it.
  root.addEventListener('focusin', () => show(current, true))

  void renderDiagram(walk.diagram)
    .then((svg) => {
      diagram.innerHTML = svg
      const drawn = diagram.querySelector('svg')
      if (drawn) {
        fitDiagram(diagram, drawn)
        // Refit when the pane is resized or zoomed.
        new ResizeObserver(() => fitDiagram(diagram, drawn)).observe(diagram)
        nodes = diagramNodes(drawn)
      }
      show(current, false)
    })
    .catch((error: unknown) => {
      diagram.replaceChildren(
        element(
          'p',
          'wt-error',
          `Couldn't draw the flowchart: ${error instanceof Error ? error.message : String(error)}`
        )
      )
    })
  show(0, false)
  return root
}

/** Replaces each walkthrough fence in a finished answer with its widget, or a note if it is bad. */
export function mountWalkthroughs(body: HTMLElement, context: WalkthroughContext): void {
  for (const code of body.querySelectorAll(`pre > code.language-${WALKTHROUGH_FENCE}`)) {
    const pre = code.parentElement
    const walk = parseWalkthrough(code.textContent ?? '')
    if ('error' in walk) {
      pre?.before(element('p', 'wt-error', `Couldn't draw this walkthrough: ${walk.error}`))
      continue
    }
    pre?.replaceWith(createWalkthrough(walk, context))
  }
}

/** While an answer streams, its walkthrough JSON shows as a placeholder, not raw text. */
export function hideStreamingWalkthroughs(body: HTMLElement): void {
  for (const code of body.querySelectorAll(`pre > code.language-${WALKTHROUGH_FENCE}`)) {
    code.parentElement?.replaceWith(element('p', 'muted', 'Preparing the interactive walkthrough…'))
  }
}
