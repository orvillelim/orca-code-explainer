// Monaco without its TypeScript, CSS and HTML language services: build.mjs leaves them out, since
// this editor is for reading and explaining and Source has completions and hover. Every language
// keeps its highlighting, which comes from grammars, not workers.
import * as monaco from 'monaco-editor'
// Orca's own Vue and Svelte grammars, bundled from the repo. Its Markdown grammar needs a TextMate
// WASM loaded through Vite, so Markdown keeps Monaco's built-in highlighting.
import { registerVueLanguage } from '../../vendor/orca/src/renderer/src/lib/monaco-languages/register-vue'
import { registerSvelteLanguage } from '../../vendor/orca/src/renderer/src/lib/monaco-languages/register-svelte'

globalThis.MonacoEnvironment = {
  getWorker() {
    // Why the page's URL: this module may be bundled into dist/chunks; the worker is in dist.
    return new Worker(new URL('editor.worker.js', document.baseURI))
  }
}

// JSON's highlighter lives in its language module, the rest needs the JSON worker, which is not
// shipped. With only tokens on, Monaco never starts that worker.
monaco.json.jsonDefaults.setModeConfiguration({
  documentFormattingEdits: false,
  documentRangeFormattingEdits: false,
  completionItems: false,
  hovers: false,
  documentSymbols: false,
  tokens: true,
  colors: false,
  foldingRanges: false,
  diagnostics: false,
  selectionRanges: false
})

for (const register of [registerVueLanguage, registerSvelteLanguage]) {
  try {
    register(monaco)
  } catch (error) {
    console.warn('Code Explainer: language registration failed', error)
  }
}

export { monaco }
