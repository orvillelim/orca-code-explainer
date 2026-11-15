import type { editor } from 'monaco-editor'

/** Orca's file-editor font settings; `editor.readTypography` is newer than Orca 1.4.256. */
type Typography = {
  cssFontFamily: string
  fontSize: number
  fontWeight: string
  lineHeight: number
  fontLigatures: boolean
  wordWrap: 'on' | 'off'
  minimap: boolean
}

type NewerFrameApi = {
  host: { has(method: string): boolean; call(method: string, params: object): Promise<unknown> }
  on(event: string, handler: (payload: unknown) => void): unknown
}

function isTypography(value: unknown): value is Typography {
  return (
    typeof value === 'object' &&
    value !== null &&
    'cssFontFamily' in value &&
    typeof value.cssFontFamily === 'string' &&
    'fontSize' in value &&
    typeof value.fontSize === 'number'
  )
}

function options(typography: Typography): editor.IEditorOptions {
  return {
    fontFamily: typography.cssFontFamily,
    fontSize: typography.fontSize,
    fontWeight: typography.fontWeight,
    lineHeight: typography.lineHeight,
    fontLigatures: typography.fontLigatures,
    wordWrap: typography.wordWrap,
    minimap: { enabled: typography.minimap }
  }
}

/**
 * Uses Orca's editor font, size (its editor zoom included) and wrapping where this Orca offers
 * them, and reports each font size. False when this Orca does not, so the plugin zooms itself.
 */
export function followOrcaTypography(
  instance: editor.IStandaloneCodeEditor,
  remeasure: () => void,
  onFontSize: (fontSize: number) => void
): boolean {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the oldest typings this plugin targets (host API 1.5) lack these names; `host.has` gates the call and `isTypography` checks every answer.
  const frame = globalThis.orca as unknown as NewerFrameApi
  if (!frame.host.has('editor.readTypography')) {
    return false
  }
  const apply = (value: unknown): void => {
    if (isTypography(value)) {
      instance.updateOptions(options(value))
      remeasure()
      onFontSize(value.fontSize)
    }
  }
  void frame.host.call('editor.readTypography', {}).then(apply, () => undefined)
  frame.on('editor.typography.changed', apply)
  return true
}
