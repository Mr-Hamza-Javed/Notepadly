import { lazy, memo, Suspense, useEffect } from "react";
import { actions } from "./state/actions";
import { useApp } from "./state/store";
import { Dialogs } from "./components/Dialogs";
import { EditorHost } from "./components/EditorHost";
import { ExternalChangeBar } from "./components/ExternalChangeBar";
import { FindBar } from "./components/FindBar";
import { FormatToolbar } from "./components/FormatToolbar";
import { G, Glyph } from "./components/icons";
import { MenuBar } from "./components/MenuBar";
import { StatusBar } from "./components/StatusBar";
import { TableContextMenu } from "./components/TableContextMenu";
import { TitleBar } from "./components/TitleBar";
import { Tooltip } from "./components/Tooltip";

// Settings and Help are separate chunks, loaded only when first opened.
const Settings = lazy(() => import("./components/Settings"));
const Help = lazy(() => import("./components/Help"));

const PageLayer = memo(function PageLayer() {
  const view = useApp((s) => s.view);
  if (view === "editor") return null;
  return (
    <Suspense fallback={<div className="settings-fallback" />}>{view === "help" ? <Help /> : <Settings />}</Suspense>
  );
});

const ChromeRow = memo(function ChromeRow() {
  return (
    <div className="chrome-row">
      <MenuBar />
      <FormatToolbar />
      <button type="button" className="gear help-btn" aria-label="Help" data-tip="Help (F1)" onClick={() => actions.openHelp()}>
        <Glyph cp={G.help} />
      </button>
      <button type="button" className="gear" aria-label="Settings" data-tip="Settings" onClick={() => actions.openSettings()}>
        <Glyph cp={G.gear} />
      </button>
    </div>
  );
});

function App() {
  const view = useApp((s) => s.view);

  // Dims the title strip on blur through CSS alone, so focus changes render nothing.
  useEffect(() => {
    const root = document.documentElement;
    const on = () => {
      root.dataset.focused = "true";
    };
    const off = () => {
      root.dataset.focused = "false";
    };
    root.dataset.focused = String(document.hasFocus());
    window.addEventListener("focus", on);
    window.addEventListener("blur", off);
    return () => {
      window.removeEventListener("focus", on);
      window.removeEventListener("blur", off);
    };
  }, []);

  return (
    <div className="app" data-view={view}>
      <TitleBar />
      <ChromeRow />
      <ExternalChangeBar />
      <div className="editor-area">
        <EditorHost />
        <FindBar />
      </div>
      <TableContextMenu />
      <StatusBar />
      <PageLayer />
      <Dialogs />
      <Tooltip />
    </div>
  );
}

export default App;
