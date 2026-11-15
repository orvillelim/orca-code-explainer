// Built as its own file (dist/mermaid-runtime.js) and loaded only when a walkthrough is drawn,
// so Mermaid's ~3 MB never slows the editor down. Uses Orca's own Mermaid setup, bundled.
import mermaid from 'mermaid'
import { getMermaidConfig } from '../../vendor/orca/src/renderer/src/components/editor/diagrams/mermaid-config'
import { sanitizeMermaidSvg } from '../../vendor/orca/src/renderer/src/components/editor/diagrams/mermaid-sanitize'
import { readableMermaidFlowchartSvg } from '../../vendor/orca/src/shared/mermaid-flowchart-contrast'

export type FlowchartColors = {
  background: string
  foreground: string
  primary: string
  secondary: string
  tertiary: string
  border: string
}

let renders = 0
// Mermaid keeps global state, so renders take turns.
let queue: Promise<unknown> = Promise.resolve()

/** A Mermaid flowchart as sanitized SVG, in strict security mode as Orca renders diagrams. */
export function renderFlowchart(
  diagram: string,
  isDark: boolean,
  colors?: FlowchartColors
): Promise<string> {
  const task = queue.then(async () => {
    const config = getMermaidConfig(isDark, colors)
    mermaid.initialize({
      ...config,
      // Compact for the narrow pane: smaller text and boxes, tighter spacing than Mermaid's defaults
      // (16px text, 15px padding, 50px between nodes and ranks); fitDiagram then scales to the pane.
      themeVariables: { ...config?.themeVariables, fontSize: '11px' },
      flowchart: {
        nodeSpacing: 16,
        rankSpacing: 20,
        padding: 5,
        diagramPadding: 4,
        wrappingWidth: 130,
        useMaxWidth: false
      }
    })
    renders += 1
    const { svg } = await mermaid.render(`code-explainer-walkthrough-${renders}`, diagram)
    const sanitized = sanitizeMermaidSvg(svg)
    return colors
      ? readableMermaidFlowchartSvg(sanitized, colors.foreground, colors.background)
      : sanitized
  })
  queue = task.catch(() => undefined)
  return task
}
