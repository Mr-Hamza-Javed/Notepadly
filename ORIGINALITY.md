# Originality statement

Notepadly is a clean, independent implementation.

## The code

- All source code in this repository was written from scratch for Notepadly: the TypeScript and React frontend in `src/`, the Rust backend in `src-tauri/src/`, the build scripts and the tests.
- No source code was copied from Windows Notepad, Obsidian or any other editor or notepad app.
- No Microsoft software, and no other app, was decompiled, disassembled or reverse engineered to build Notepadly. No private or internal interfaces of other apps are used.

## How the Windows 11 look was made

Notepadly is designed to feel at home next to Windows 11 Notepad. That look was recreated only by **observing the public user interface**: watching the app run and comparing screenshots side by side. Sizes, spacing and colours were measured from those screenshots, then rebuilt in original HTML and CSS. The icons inside the app come from the Segoe Fluent Icons font that ships with Windows; they are referenced by character code and not copied into this repository.

The live Markdown editing works the way Obsidian's Live Preview does, from the user's point of view. That behaviour was implemented independently on top of CodeMirror 6; no Obsidian code was used.

## The icon

The Notepadly icon is an original vector drawing (`src-tauri/icons/source/notepadly-icon.svg`). Its notepad shape is styled after the Windows 11 Notepad icon, and the lightning bolt sets it apart. No Microsoft image files are included in this repository.

## Open-source libraries

Notepadly is built on open-source libraries, such as Tauri, React, CodeMirror, KaTeX and Mermaid. They are used as normal dependencies: npm and Cargo download them at build time, and their code is not copied into this repository's source. Each library keeps its own license; see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## Screenshots

The screenshots of Windows Notepad in `docs/screenshots` exist only to compare the two apps. Microsoft, Windows and Notepad are trademarks of Microsoft Corporation, and Notepadly is not affiliated with Microsoft.
