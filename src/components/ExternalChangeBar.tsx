import { memo } from "react";
import { actions } from "../state/actions";
import { useApp } from "../state/store";
import { focusEditorSoon } from "./focus";

export const ExternalChangeBar = memo(function ExternalChangeBar() {
  const id = useApp((s) => s.activeId);
  const change = useApp((s) => s.tabs.find((t) => t.id === s.activeId)?.externalChange ?? null);
  if (!change) return null;

  return (
    <div className="ext-bar" role="alert">
      <span className="msg">{change === "deleted" ? "This file was deleted or moved on disk" : "This file changed on disk"}</span>
      {change === "modified" && (
        <button
          type="button"
          className="btn small"
          onClick={() => {
            actions.reloadTab(id);
            focusEditorSoon();
          }}
        >
          Reload
        </button>
      )}
      <button
        type="button"
        className="btn small"
        onClick={() => {
          actions.keepMine(id);
          focusEditorSoon();
        }}
      >
        Keep mine
      </button>
    </div>
  );
});
