# Notepadly

A fast Windows notepad that looks like the Windows 11 Notepad and edits Markdown live, the way Obsidian's Live Preview does. Built with Tauri 2, React and CodeMirror 6.

- Live Markdown in one pane: headings, lists, tasks, tables edited in place, callouts, code, math, Mermaid, footnotes, wikilinks and images.
- Multiple tabs, session restore, find and replace, zoom, word wrap, light and dark themes.
- Never locks files: each read and save opens and closes the file.
- Large files open instantly: the first chunk shows at once and the rest loads as you scroll.
- Every script renders, and right-to-left lines (Urdu, Arabic, Hebrew) flow from the right.

Open [`sample.md`](sample.md) in the app to see every feature.

## Download

Get the latest installer from the [Releases](../../releases) page.

## Development

Requirements: Node.js 22+, Rust (stable) and the WebView2 runtime (built into Windows 11).

```bash
npm install
npm run app:dev      # run with hot reload
npm run app:build    # build the exe and installer into src-tauri/target/release
```

## Releasing a new version

Push a version tag. GitHub Actions builds the installer and a portable exe and publishes them as a release. The version comes from the tag.

```bash
git tag v0.2.0
git push origin v0.2.0
```
