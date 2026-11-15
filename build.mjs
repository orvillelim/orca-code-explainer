// Bundles the editor frame and Monaco's workers into dist/. Run from anywhere: node build.mjs
import { build } from 'esbuild'
import { copyFileSync, mkdirSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'

const root = import.meta.dirname
const dist = join(root, 'dist')
const monacoEsm = 'monaco-editor/esm/vs'
const watch = process.argv.includes('--watch')

rmSync(dist, { recursive: true, force: true })
mkdirSync(dist, { recursive: true })
copyFileSync(join(root, 'src/editor/editor.html'), join(dist, 'editor.html'))

// Orca's highlighter imports its regex engine the Vite way (`onig.wasm?url`): ship the file beside
// editor.js and hand back its URL.
const wasmUrlPlugin = {
  name: 'wasm-url',
  setup(build) {
    build.onResolve({ filter: /\.wasm\?url$/ }, async (args) => {
      const resolved = await build.resolve(args.path.replace(/\?url$/, ''), {
        kind: args.kind,
        resolveDir: args.resolveDir
      })
      return { path: resolved.path, namespace: 'wasm-url' }
    })
    build.onLoad({ filter: /.*/, namespace: 'wasm-url' }, (args) => {
      const name = basename(args.path)
      copyFileSync(args.path, join(dist, name))
      // Why the page, not import.meta.url: split chunks live in dist/chunks, the asset in dist.
      return { contents: `export default new URL('${name}', document.baseURI).href`, loader: 'js' }
    })
  }
}

const common = {
  bundle: true,
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  target: 'es2022',
  logLevel: 'info',
  absWorkingDir: root
}

await Promise.all([
  build({
    ...common,
    // mermaid-runtime: loaded by URL only when a walkthrough is drawn (walkthrough.ts).
    entryPoints: {
      editor: 'src/editor/main.ts',
      'mermaid-runtime': 'src/editor/mermaid-runtime.ts'
    },
    outdir: dist,
    format: 'esm',
    loader: { '.ttf': 'file' },
    assetNames: '[name]',
    plugins: [wasmUrlPlugin]
  }),
  build({
    ...common,
    entryPoints: {
      'editor.worker': `${monacoEsm}/editor/editor.worker.js`,
      'json.worker': `${monacoEsm}/language/json/json.worker.js`,
      'css.worker': `${monacoEsm}/language/css/css.worker.js`,
      'html.worker': `${monacoEsm}/language/html/html.worker.js`,
      'ts.worker': `${monacoEsm}/language/typescript/ts.worker.js`
    },
    outdir: dist,
    format: 'iife'
  })
])
