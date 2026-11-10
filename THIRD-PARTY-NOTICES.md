# Third-party notices

Notepadly uses these open-source libraries directly. Each is used under its own license, and its copyright stays with its authors. The libraries they depend on in turn use similar permissive licenses; the full list is in `package-lock.json` and `src-tauri/Cargo.lock`.

## Frontend (npm)

| Library | License |
| --- | --- |
| [React](https://github.com/facebook/react), React DOM | MIT |
| [CodeMirror 6](https://codemirror.net): `@codemirror/state`, `view`, `commands`, `language`, `language-data`, `lang-markdown`, `search` | MIT |
| [Lezer](https://lezer.codemirror.net): `@lezer/common`, `highlight`, `markdown` | MIT |
| [KaTeX](https://katex.org) (including its fonts) | MIT |
| [Mermaid](https://mermaid.js.org) | MIT |
| [marked](https://marked.js.org) | MIT |
| [Zustand](https://github.com/pmndrs/zustand) | MIT |
| [Tauri API](https://tauri.app): `@tauri-apps/api`, `plugin-dialog`, `plugin-opener` | MIT or Apache-2.0 |

## Backend (Rust crates)

| Crate | License |
| --- | --- |
| [Tauri](https://tauri.app) and the plugins `dialog`, `opener`, `single-instance`, `window-state` | Apache-2.0 or MIT |
| [serde](https://serde.rs) | MIT or Apache-2.0 |
| [encoding_rs](https://github.com/hsivonen/encoding_rs) | (Apache-2.0 or MIT) and BSD-3-Clause |
| [winreg](https://github.com/gentoo90/winreg-rs) | MIT |
| [windows-sys](https://github.com/microsoft/windows-rs), windows-core | MIT or Apache-2.0 |
| [webview2-com](https://github.com/wravery/webview2-rs) | MIT |

## Build tools (not shipped in the app)

TypeScript (Apache-2.0), Vite (MIT), Vitest (MIT), `@vitejs/plugin-react` (MIT), `@tauri-apps/cli` (Apache-2.0 or MIT) and `@resvg/resvg-js` (MPL-2.0, used only to render the icon files).

## Runtime provided by Windows

Notepadly displays its window with Microsoft Edge WebView2 and uses the Segoe Fluent Icons font. Both are part of Windows and are not included in Notepadly's files.
