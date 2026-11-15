// esbuild bundles CSS imports into dist/editor.css.
declare module '*.css'

// build.mjs copies a `?url` asset beside editor.js and gives its URL.
declare module '*?url' {
  const url: string
  export default url
}
