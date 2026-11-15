# Testing

## Running

```bash
npm test                     # every frontend test (Vitest)
npx vitest src/lib           # one folder, in watch mode
npx vitest run --coverage    # with a v8 coverage report
npm run typecheck            # the app, then the tests (tsconfig.test.json)
cd src-tauri && cargo test --lib
```

## Layout

- **Frontend tests sit next to the code they test**, as `*.test.ts` (`src/editor/commands.ts` → `src/editor/commands.test.ts`).
- **Shared helpers live in `src/test/`.** They are only used by tests. `tsconfig.json` leaves them out of the app build, and `tsconfig.test.json` typechecks them with the tests.
- **Rust tests are `#[cfg(test)] mod tests` blocks** at the bottom of each file in `src-tauri/src/`.
- **`vitest.config.ts`** holds the test settings. Tests run in Node by default. A file that needs a DOM starts with `// @vitest-environment jsdom`.

## Helpers in `src/test/`

| File | What it gives you |
| --- | --- |
| `dom.ts` | jsdom polyfills that CodeMirror needs (`matchMedia`, `ResizeObserver`, `Range` rects, `requestIdleCallback`). Loaded for every test file. |
| `editorHarness.ts` | `mountEngine()` mounts the real editor engine with a recording host. `markdownView()` gives a bare CodeMirror view with the Markdown language. |
| `fakeTauri.ts` | An in-memory stand-in for the Rust backend (`files.rs`, `store.rs`), plus fake dialogs and windows. The header comment lists where it differs from the real backend. |
| `appHarness.ts` | `bootApp()` starts the whole frontend (store, actions, loader, engine) against `fakeTauri`. `waitFor()` and `settle()` wait for async work. |

A test file that uses `bootApp()` mocks the Tauri modules at the top. Copy the `vi.mock(...)` lines from `src/state/actions.test.ts`.

In `fakeTauri`, a save into a folder that does not exist fails, as it does on disk. `backend.write()` creates the folder of the file it writes. Before a Save As into a new folder, call `backend.mkdir(folder)`.

## Known bugs as skipped tests

A bug that is too big to fix right away gets an entry in `BUGS.md` and a test marked `it.skip` (frontend) or `#[ignore = "known bug ..."]` (Rust). The test's name or a comment above it names the entry. When you fix the bug, remove the skip and check that the test passes.
