import { memo, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { engine } from "../editor";
import { actions } from "../state/actions";
import { useApp } from "../state/store";
import type { Dialog as DialogModel, PageSetup } from "../state/types";
import { Select } from "./Select";
import { focusEditorSoon } from "./focus";

type Button = { label: string; onClick: () => void; disabled?: boolean; primary?: boolean };

function dismiss() {
  actions.closeDialog();
  focusEditorSoon();
}

const FOCUSABLE = 'input, button:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** WinUI ContentDialog: smoke layer, card, tinted button footer. */
function Shell({ title, buttons, onEscape, children, labelId }: { title: string; buttons: Button[]; onEscape: () => void; children?: ReactNode; labelId: string }) {
  const root = useRef<HTMLDivElement | null>(null);
  const primary = buttons.find((b) => b.primary);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const target = el.querySelector<HTMLElement>("[data-autofocus]") ?? el.querySelector<HTMLElement>(".btn.primary") ?? el;
    target.focus();
    if (target instanceof HTMLInputElement) target.select();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onKeyDown = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      onEscape();
    } else if (e.key === "Enter") {
      const t = e.target as HTMLElement;
      const onOtherButton = t.tagName === "BUTTON" && !t.classList.contains("primary");
      if (!onOtherButton && primary && !primary.disabled) {
        e.preventDefault();
        primary.onClick();
      }
    } else if (e.key === "Tab") {
      const items = Array.from(root.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  return (
    <div className="smoke">
      <div ref={root} className="dialog" role="dialog" aria-modal="true" aria-labelledby={labelId} tabIndex={-1} onKeyDown={onKeyDown}>
        <div className="dialog-body">
          <h2 id={labelId} className="dialog-title">
            {title}
          </h2>
          {children}
        </div>
        <div className="dialog-footer">
          {buttons.map((b) => (
            <button key={b.label} type="button" className={b.primary ? "btn primary" : "btn"} disabled={b.disabled} onClick={b.onClick}>
              {b.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function ConfirmClose({ d }: { d: Extract<DialogModel, { kind: "confirm-close" }> }) {
  const title = useApp((s) => s.tabs.find((t) => t.id === d.tabId)?.title ?? "Untitled");
  // resolve() also clears the dialog; closeDialog() would resolve as "cancel".
  const answer = (r: "save" | "discard" | "cancel") => {
    d.resolve(r);
    focusEditorSoon();
  };
  return (
    <Shell
      labelId="dlg-close"
      title={`Do you want to save changes to ${title}?`}
      onEscape={() => answer("cancel")}
      buttons={[
        { label: "Save", primary: true, onClick: () => answer("save") },
        { label: "Don't save", onClick: () => answer("discard") },
        { label: "Cancel", onClick: () => answer("cancel") },
      ]}
    />
  );
}

function GoToLine() {
  const line = useApp((s) => s.cursor.line);
  const activeId = useApp((s) => s.activeId);
  const fullyLoaded = useApp((s) => s.tabs.find((t) => t.id === s.activeId)?.fullyLoaded ?? true);
  const [value, setValue] = useState(String(line));
  const [error, setError] = useState("");

  const n = Number.parseInt(value, 10);
  const valid = /^\d+$/.test(value.trim()) && n >= 1;

  const go = () => {
    if (!valid) return;
    const jump = () => {
      if (n > engine.lineCount()) {
        setError("The line number is beyond the total number of lines");
        return;
      }
      actions.closeDialog();
      engine.goToLine(n);
      focusEditorSoon();
    };
    if (n > engine.lineCount() && !fullyLoaded) void actions.ensureFullyLoaded(activeId).then(jump);
    else jump();
  };

  return (
    <Shell
      labelId="dlg-goto"
      title="Go to line"
      onEscape={dismiss}
      buttons={[
        { label: "Go to", primary: true, disabled: !valid, onClick: go },
        { label: "Cancel", onClick: dismiss },
      ]}
    >
      <div className="field">
        <label htmlFor="goto-line">Line number</label>
        <input
          id="goto-line"
          data-autofocus
          className="text-input"
          type="text"
          inputMode="numeric"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError("");
          }}
        />
        {error && <div className="field-error">{error}</div>}
      </div>
    </Shell>
  );
}

function LinkDialog({ d }: { d: Extract<DialogModel, { kind: "link" }> }) {
  const [text, setText] = useState(d.initialText);
  const [url, setUrl] = useState(d.initialUrl);
  const apply = () => {
    actions.applyLink(text, url.trim());
    focusEditorSoon();
  };
  return (
    <Shell
      labelId="dlg-link"
      title="Link"
      onEscape={dismiss}
      buttons={[
        { label: "Insert", primary: true, disabled: url.trim() === "", onClick: apply },
        { label: "Cancel", onClick: dismiss },
      ]}
    >
      <div className="field">
        <label htmlFor="link-text">Text</label>
        <input id="link-text" data-autofocus={d.initialText ? undefined : true} className="text-input" type="text" value={text} onChange={(e) => setText(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="link-url">URL</label>
        <input id="link-url" data-autofocus={d.initialText ? true : undefined} className="text-input" type="text" spellCheck={false} placeholder="https://" value={url} onChange={(e) => setUrl(e.target.value)} />
      </div>
    </Shell>
  );
}

const ORIENTATIONS = [
  { value: "portrait", label: "Portrait" },
  { value: "landscape", label: "Landscape" },
];

function PageSetupDialog() {
  const initial = useApp((s) => s.pageSetup);
  const [orientation, setOrientation] = useState<PageSetup["orientation"]>(initial.orientation);
  const [margin, setMargin] = useState(String(initial.marginMm));
  const [header, setHeader] = useState(initial.header);
  const [footer, setFooter] = useState(initial.footer);
  const marginMm = Number(margin);
  const valid = margin.trim() !== "" && Number.isFinite(marginMm) && marginMm >= 0 && marginMm <= 100;

  const save = () => {
    useApp.setState({ pageSetup: { orientation, marginMm, header, footer } });
    dismiss();
  };

  return (
    <Shell
      labelId="dlg-page"
      title="Page setup"
      onEscape={dismiss}
      buttons={[
        { label: "OK", primary: true, disabled: !valid, onClick: save },
        { label: "Cancel", onClick: dismiss },
      ]}
    >
      <div className="field-row">
        <div className="field">
          <span className="field-label">Orientation</span>
          <Select label="Orientation" value={orientation} options={ORIENTATIONS} onChange={(v) => setOrientation(v as PageSetup["orientation"])} />
        </div>
        <div className="field">
          <label htmlFor="ps-margin">Margin (mm)</label>
          <input id="ps-margin" data-autofocus className="text-input" type="text" inputMode="numeric" value={margin} onChange={(e) => setMargin(e.target.value)} />
        </div>
      </div>
      <div className="field">
        <label htmlFor="ps-header">Header</label>
        <input id="ps-header" className="text-input" type="text" value={header} onChange={(e) => setHeader(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="ps-footer">Footer</label>
        <input id="ps-footer" className="text-input" type="text" value={footer} onChange={(e) => setFooter(e.target.value)} />
      </div>
    </Shell>
  );
}

function Message({ d }: { d: Extract<DialogModel, { kind: "message" }> }) {
  return (
    <Shell labelId="dlg-msg" title={d.title} onEscape={dismiss} buttons={[{ label: "OK", primary: true, onClick: dismiss }]}>
      <p className="dialog-text">{d.body}</p>
    </Shell>
  );
}

export const Dialogs = memo(function Dialogs() {
  const d = useApp((s) => s.dialog);
  if (!d) return null;
  switch (d.kind) {
    case "confirm-close":
      return <ConfirmClose key={d.tabId} d={d} />;
    case "goto":
      return <GoToLine />;
    case "link":
      return <LinkDialog d={d} />;
    case "page-setup":
      return <PageSetupDialog />;
    case "message":
      return <Message d={d} />;
  }
});
