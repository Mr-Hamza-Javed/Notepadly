import { memo, useLayoutEffect, useRef } from "react";
import { mountEditor } from "../state/actions";

/**
 * The one stable parent of the CodeMirror view. It takes no props and never
 * re-renders; the settings page covers it instead of unmounting it.
 */
export const EditorHost = memo(function EditorHost() {
  const parent = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    if (parent.current) mountEditor(parent.current);
  }, []);

  return <div ref={parent} id="editor-host" className="editor-host" data-editor-host="" />;
});
