// The three ways to explain a selection, shared by the editor frame (menu, chips) and the worker
// (prompts). Plain JS so the worker can import it without a build.

export const CALL_TREE_PROMPT = `Draw a call tree of the selected code, in this format:

selection-action.ts   button click / context menu / ⌘⇧E
   └─ run()  ──────────►  main.ts  explain()
                             ├─ captureSelection()   ← text + surrounding lines from the buffer
                             └─ orca.plugin.request('explain', { selection })

Rules: start at the entry point that reaches the selection; indent each call under its caller with ├─, └─ and │; name the file where a call crosses into another file, with ──► (or │ and ▼ for a jump to another process); add a short ← note saying what each step does. Read the called code with the project tools so every name is real, and mark anything you could not confirm with (?). Put the tree in a \`\`\`text block, then explain the flow in two or three sentences.`

const OVERVIEW_PROMPT = `Give a high-level overview of the selected code: what it is for and the role it plays in the project. Stay high level: no line-by-line walkthrough, and no more than about 150 words before "Ask next". Use this format:

**In short:** one or two sentences on what it does and why it exists.

### What it's for
The problem it solves, in two or three bullets.

### Where it fits
Who calls or uses it and what it relies on, in two or three bullets, citing paths.

### Inputs and outputs
What goes in and what comes out (including side effects), in one or two bullets.

### Ask next
Three short questions about design decisions, dependencies and edge cases.`

/** Fence tag of the interactive walkthrough the frame draws. */
export const WALKTHROUGH_FENCE = 'explainer-walkthrough'

const INTERACTIVE_PROMPT = `Make an interactive walkthrough of how the selected code runs. The editor draws it as a flowchart the reader steps through with Prev/Next buttons and a button per state, highlighting the active box, the variable values and the source lines at each step.

Answer with exactly one fenced block tagged ${WALKTHROUGH_FENCE} that holds JSON, then a two or three sentence summary. The JSON:

\`\`\`${WALKTHROUGH_FENCE}
{
  "title": "percent(): from ratio to clamped percentage",
  "diagram": "flowchart TD\\n  A[\\"call percent(part, whole)\\"] --> B{\\"whole === 0?\\"}\\n  B -->|yes| C[\\"return 0\\"]\\n  B -->|no| D[\\"Math.round(part / whole * 100)\\"]\\n  D --> E[\\"clamp(value, 0, 100)\\"]",
  "states": [
    { "id": "zero", "label": "whole is 0" },
    { "id": "normal", "label": "part 5, whole 20" }
  ],
  "steps": [
    { "state": "zero", "nodes": ["A", "B"], "lines": [3, 4], "vars": { "part": "5", "whole": "0" }, "note": "The guard runs first so the division below can never see a zero." },
    { "state": "zero", "nodes": ["C"], "lines": [4, 4], "vars": { "part": "5", "whole": "0" }, "note": "Returns early; nothing else runs." },
    { "state": "normal", "nodes": ["B", "D"], "lines": [5, 5], "vars": { "part": "5", "whole": "20", "value": "25" }, "note": "5 / 20 * 100 rounds to 25." }
  ]
}
\`\`\`

Rules:
- "diagram" is a Mermaid flowchart (flowchart TD or LR) of the selected code's control flow: short alphanumeric node ids, every label in double quotes, decisions as {"…"}, loops as an edge back to the loop check. At most 30 nodes.
- "states" are the situations worth contrasting: each branch taken, or loop iterations (for example "iteration 1", "iteration 2", "after the loop"). Give each a short label with the concrete values that cause it. Use one state when there is nothing to contrast.
- "steps" follow execution order within each state, every one naming its state, the node ids active at that moment, the 1-based line range in the selected file ("lines"), the variable values at that moment as strings ("vars"), and a one-sentence note that says why, not just what. At most 40 steps.
- Pick small, concrete example values and keep them consistent across steps. Read related code with the project tools when needed; do not invent behaviour.
- The JSON must parse: escape quotes and newlines inside strings.`

/** @type {Record<'overview' | 'callTree' | 'interactive', { label: string; prompt: string }>} */
export const EXPLAIN_MODES = {
  overview: { label: 'Explain', prompt: OVERVIEW_PROMPT },
  callTree: { label: 'Call hierarchy', prompt: CALL_TREE_PROMPT },
  interactive: { label: 'Interactive', prompt: INTERACTIVE_PROMPT }
}

export function isExplainMode(value) {
  return typeof value === 'string' && Object.hasOwn(EXPLAIN_MODES, value)
}
