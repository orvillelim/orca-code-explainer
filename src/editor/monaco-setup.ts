import * as monaco from 'monaco-editor'
import { typescript as monacoTS } from 'monaco-editor'
// Orca's own Vue and Svelte grammars, bundled from the repo. Its Markdown grammar needs a TextMate
// WASM loaded through Vite, so Markdown keeps Monaco's built-in highlighting.
import { registerVueLanguage } from '../../vendor/orca/src/renderer/src/lib/monaco-languages/register-vue'
import { registerSvelteLanguage } from '../../vendor/orca/src/renderer/src/lib/monaco-languages/register-svelte'

const WORKERS: Record<string, string> = {
  json: 'json.worker.js',
  css: 'css.worker.js',
  scss: 'css.worker.js',
  less: 'css.worker.js',
  html: 'html.worker.js',
  handlebars: 'html.worker.js',
  razor: 'html.worker.js',
  typescript: 'ts.worker.js',
  javascript: 'ts.worker.js'
}

globalThis.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    // Why the page's URL: this module may be bundled into dist/chunks; the workers are in dist.
    return new Worker(new URL(WORKERS[label] ?? 'editor.worker.js', document.baseURI))
  }
}

// As Orca's editor: the sandboxed worker cannot resolve project imports, so diagnostics would be noise.
const diagnosticsOptions = {
  noSemanticValidation: true,
  noSuggestionDiagnostics: true,
  noSyntaxValidation: true
}
monacoTS.typescriptDefaults.setDiagnosticsOptions(diagnosticsOptions)
monacoTS.javascriptDefaults.setDiagnosticsOptions(diagnosticsOptions)
for (const defaults of [monacoTS.typescriptDefaults, monacoTS.javascriptDefaults]) {
  defaults.setCompilerOptions({ ...defaults.getCompilerOptions(), jsx: monacoTS.JsxEmit.Preserve })
}

for (const register of [registerVueLanguage, registerSvelteLanguage]) {
  try {
    register(monaco)
  } catch (error) {
    console.warn('Code Explainer: language registration failed', error)
  }
}

export { monaco }
