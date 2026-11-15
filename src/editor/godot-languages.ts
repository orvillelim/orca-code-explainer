import type { LanguageRegistration } from 'shiki/core'
import { monaco } from './monaco-setup'
// Orca's own TextMate highlighter, bundled from the repo, with the Godot grammars in grammars/godot.
import { registerTextMateLanguage } from '../../vendor/orca/src/renderer/src/lib/monaco-languages/textmate-language-registration'
import { loadEditorCore } from '../../vendor/orca/src/renderer/src/lib/monaco-languages/textmate-token-provider'

const BRACKETS: [string, string][] = [
  ['{', '}'],
  ['[', ']'],
  ['(', ')']
]
const PAIRS = [...BRACKETS, ['"', '"'], ["'", "'"]].map(([open, close]) => ({ open, close }))

/** TextMate scopes as the token names Monaco's light and dark themes color. */
function monacoToken(scopes: readonly string[]): string {
  const scope = scopes.at(-1) ?? ''
  const rules: [string, string][] = [
    ['comment', 'comment'],
    ['string', 'string'],
    ['constant.numeric', 'number'],
    ['constant.character', 'string.escape'],
    ['constant.language', 'keyword'],
    ['storage', 'keyword'],
    ['keyword.operator', 'operator'],
    ['keyword', 'keyword'],
    ['support.class', 'type'],
    ['entity.name.type', 'type'],
    ['entity.name.class', 'type'],
    ['class.other', 'type'],
    ['entity.name.function', 'function'],
    ['meta.function-call', 'function'],
    ['entity.other.attribute-name', 'attribute.name'],
    ['variable.parameter', 'variable.parameter'],
    ['variable', 'variable'],
    ['invalid', 'invalid']
  ]
  return rules.find(([prefix]) => scope === prefix || scope.startsWith(`${prefix}.`))?.[1] ?? ''
}

async function grammar(
  name: string,
  load: () => Promise<{ default: object }>,
  embeddedLangs: string[] = []
): Promise<LanguageRegistration> {
  const { default: json } = await load()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the JSON is a vendored TextMate grammar; Shiki's registration is that grammar plus a name.
  return { ...json, name, embeddedLangs } as LanguageRegistration
}

const gdscript = () =>
  grammar('gdscript', () => import('../../grammars/godot/gdscript.tmLanguage.json'))
const gdshader = () =>
  grammar('gdshader', () => import('../../grammars/godot/gdshader.tmLanguage.json'))

/** Resources embed GDScript and shader blocks, so those load into the shared registry first. */
async function gdresource(): Promise<LanguageRegistration> {
  const core = await loadEditorCore()
  await core.core.loadLanguage(await gdscript(), await gdshader())
  return grammar('gdresource', () => import('../../grammars/godot/gdresource.tmLanguage.json'), [
    'gdscript',
    'gdshader'
  ])
}

/** GDScript, Godot resources and shaders, highlighted with the same grammars as Orca's Godot plugin. */
export function registerGodotLanguages(): void {
  const configuration = { brackets: BRACKETS, autoClosingPairs: PAIRS, surroundingPairs: PAIRS }
  registerTextMateLanguage(monaco, {
    language: { id: 'gdscript', extensions: ['.gd'], aliases: ['GDScript'] },
    configuration: { ...configuration, comments: { lineComment: '#' } },
    loadGrammar: gdscript,
    mapTokenScopes: monacoToken
  })
  registerTextMateLanguage(monaco, {
    language: {
      id: 'gdshader',
      extensions: ['.gdshader', '.gdshaderinc'],
      aliases: ['Godot Shader']
    },
    configuration: {
      ...configuration,
      comments: { lineComment: '//', blockComment: ['/*', '*/'] }
    },
    loadGrammar: gdshader,
    mapTokenScopes: monacoToken
  })
  registerTextMateLanguage(monaco, {
    language: {
      id: 'gdresource',
      extensions: ['.tscn', '.tres', '.escn', '.godot', '.gdextension'],
      aliases: ['Godot Resource']
    },
    configuration: { ...configuration, comments: { lineComment: ';' } },
    loadGrammar: gdresource,
    mapTokenScopes: monacoToken
  })
}
