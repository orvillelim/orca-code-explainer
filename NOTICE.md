# Third-party code

This plugin is MIT licensed (see `LICENSE`). It also contains or bundles:

| What | Where | License |
| --- | --- | --- |
| Source files from [Orca](https://github.com/stablyai/orca) (Monaco language registrations, TextMate highlighter, Mermaid config and sanitizer, editor zoom steps, color contrast helpers), copied unchanged | `vendor/orca/` | MIT, © 2026 Lovecast Inc. (`vendor/orca/LICENSE`) |
| GDScript, Godot resource and shader TextMate grammars from the [Godot VS Code plugin](https://github.com/godotengine/godot-vscode-plugin), as vendored by Orca's Godot syntax plugin | `grammars/godot/` | MIT, © 2016–2022 The Godot Engine community (`grammars/godot/LICENSE`) |
| Monaco Editor, Mermaid, marked, DOMPurify, Shiki, vscode-oniguruma (npm packages, bundled into `dist/` by `build.mjs`) | `dist/` | MIT / Apache-2.0 / MPL-2.0 or Apache-2.0 (DOMPurify), as published by each project |

The files in `dist/` are build output of the sources in this repository (`node build.mjs`). They are minified for size, not to hide anything.
