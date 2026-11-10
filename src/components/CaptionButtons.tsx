import { memo, useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { actions } from "../state/actions";
import { G, Glyph } from "./icons";

export const CaptionButtons = memo(function CaptionButtons() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let dead = false;
    try {
      const win = getCurrentWindow();
      const sync = () => {
        void win.isMaximized().then((m) => {
          if (!dead) setMaximized(m);
        });
      };
      sync();
      void win.onResized(sync).then((u) => {
        if (dead) u();
        else unlisten = u;
      });
    } catch {
      // Outside Tauri (plain browser preview): buttons render but stay inert.
    }
    return () => {
      dead = true;
      unlisten?.();
    };
  }, []);

  return (
    <div className="caption">
      <button type="button" className="caption-btn" aria-label="Minimize" data-tip="Minimize" onClick={() => void getCurrentWindow().minimize()}>
        <Glyph cp={G.captionMin} />
      </button>
      <button
        type="button"
        className="caption-btn"
        aria-label={maximized ? "Restore" : "Maximize"}
        data-tip={maximized ? "Restore" : "Maximize"}
        onClick={() => void getCurrentWindow().toggleMaximize()}
      >
        <Glyph cp={maximized ? G.captionRestore : G.captionMax} />
      </button>
      <button type="button" className="caption-btn close" aria-label="Close" data-tip="Close" onClick={() => void actions.closeWindow()}>
        <Glyph cp={G.captionClose} />
      </button>
    </div>
  );
});
