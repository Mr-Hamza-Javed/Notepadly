import { memo, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { ipc } from "../../lib/ipc";
import { actions } from "../../state/actions";
import { useApp } from "../../state/store";
import type { Settings as SettingsModel, ThemeSetting } from "../../state/types";
import "../../styles/settings.css";
import { CaptionButtons } from "../CaptionButtons";
import { focusEditorSoon } from "../focus";
import { AppIcon, G, Glyph, WordWrapIcon } from "../icons";
import { Select, type SelectOption } from "../Select";

const WEIGHTS: Record<string, number> = { Light: 300, Regular: 400, Medium: 500, Semibold: 600, Bold: 700 };
const SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72];

const STYLE_OPTIONS: SelectOption[] = Object.keys(WEIGHTS).map((s) => ({ value: s, label: s }));
const SIZE_OPTIONS: SelectOption[] = SIZES.map((s) => ({ value: String(s), label: String(s) }));
const OPEN_OPTIONS: SelectOption[] = [
  { value: "tab", label: "Open in a new tab" },
  { value: "window", label: "Open in a new window" },
];

function set<K extends keyof SettingsModel>(key: K, value: SettingsModel[K]) {
  actions.setSetting(key, value);
}

function Icon({ cp }: { cp: number }) {
  return (
    <span className="card-icon">
      <Glyph cp={cp} />
    </span>
  );
}

function Toggle({ value, label, onChange }: { value: boolean; label: string; onChange: (v: boolean) => void }) {
  return (
    <button type="button" className="toggle" role="switch" aria-checked={value} aria-label={label} onClick={() => onChange(!value)}>
      <span className="toggle-track">
        <span className="toggle-knob" />
      </span>
      <span className="toggle-text">{value ? "On" : "Off"}</span>
    </button>
  );
}

function ToggleCard({ icon, title, subtitle, value, onChange }: { icon: ReactNode; title: string; subtitle?: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="card">
      <div className="card-head">
        {icon}
        <div className="card-text">
          <div className="card-title">{title}</div>
          {subtitle && <div className="card-sub">{subtitle}</div>}
        </div>
        <Toggle value={value} label={title} onChange={onChange} />
      </div>
    </div>
  );
}

function Expander({ icon, title, subtitle, onFirstOpen, children }: { icon: ReactNode; title: string; subtitle?: string; onFirstOpen?: () => void; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="card">
      <button
        type="button"
        className="card-head"
        aria-expanded={open}
        onClick={() => {
          if (!open) onFirstOpen?.();
          setOpen(!open);
        }}
      >
        {icon}
        <div className="card-text">
          <div className="card-title">{title}</div>
          {subtitle && <div className="card-sub">{subtitle}</div>}
        </div>
        <span className="exp-chev">
          <Glyph cp={open ? G.up : G.down} size={10} />
        </span>
      </button>
      {open && <div className="exp-body">{children}</div>}
    </div>
  );
}

function Radios<T extends string>({ value, options, label, onChange }: { value: T; options: { value: T; label: string }[]; label: string; onChange: (v: T) => void }) {
  return (
    <div className="radio-group" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" className="radio" role="radio" aria-checked={o.value === value} onClick={() => onChange(o.value)}>
          <span className="radio-mark" />
          {o.label}
        </button>
      ))}
    </div>
  );
}

let fontCache: string[] | null = null;

function useSystemFonts(current: string) {
  const [fonts, setFonts] = useState<string[]>(fontCache ?? []);
  const load = useCallback(() => {
    if (fontCache) {
      setFonts(fontCache);
      return;
    }
    void ipc
      .systemFonts()
      .then((list) => {
        fontCache = list;
        setFonts(list);
      })
      .catch(() => undefined);
  }, []);
  const options = useMemo<SelectOption[]>(() => {
    const names = Array.from(new Set([current, "Inter", ...fonts])).sort((a, b) => a.localeCompare(b));
    return names.map((n) => ({ value: n, label: n }));
  }, [fonts, current]);
  return { options, load };
}

const THEMES: { value: ThemeSetting; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "Use system setting" },
];

const STARTUP: { value: SettingsModel["startup"]; label: string }[] = [
  { value: "continue", label: "Continue previous session" },
  { value: "new", label: "Start new session and discard unsaved changes" },
];

const FontCard = memo(function FontCard() {
  const family = useApp((s) => s.settings.fontFamily);
  const style = useApp((s) => s.settings.fontStyle);
  const size = useApp((s) => s.settings.fontSizePt);
  const { options, load } = useSystemFonts(family);
  const onFamily = useCallback((v: string) => set("fontFamily", v), []);
  const onStyle = useCallback((v: string) => set("fontStyle", v), []);
  const onSize = useCallback((v: string) => set("fontSizePt", Number(v)), []);

  return (
    <Expander icon={<Icon cp={G.font} />} title="Font" onFirstOpen={load}>
      <div className="font-row">
        <span>Family</span>
        <Select label="Font family" value={family} options={options} onChange={onFamily} onOpen={load} />
      </div>
      <div className="font-row">
        <span>Style</span>
        <Select label="Font style" value={style} options={STYLE_OPTIONS} onChange={onStyle} />
      </div>
      <div className="font-row">
        <span>Size</span>
        <Select label="Font size" value={String(size)} options={SIZE_OPTIONS} onChange={onSize} />
      </div>
      <div
        className="font-sample"
        style={{
          fontFamily: `"${family}", "Segoe UI Variable Text", "Segoe UI", sans-serif`,
          fontWeight: WEIGHTS[style] ?? 400,
          fontSize: `${size}pt`,
          lineHeight: 1.3,
        }}
      >
        The sound of ocean waves calms my soul.
      </div>
    </Expander>
  );
});

function About() {
  const [version, setVersion] = useState("");
  useEffect(() => {
    let dead = false;
    void getVersion()
      .then((v) => {
        if (!dead) setVersion(v);
      })
      .catch(() => undefined);
    return () => {
      dead = true;
    };
  }, []);
  return (
    <aside className="about">
      <h2 className="about-h">About this app</h2>
      <p className="about-line">Notepadly</p>
      {version && <p className="about-line">{`Version ${version}`}</p>}
    </aside>
  );
}

function goBack() {
  actions.closeSettings();
  focusEditorSoon();
}

export default function Settings() {
  const s = useApp((st) => st.settings);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && e.key === "ArrowLeft") {
        e.preventDefault();
        goBack();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="settings-page">
      <div className="settings-title">
        <button type="button" className="settings-back" aria-label="Back" data-tip="Back" onClick={goBack}>
          <Glyph cp={G.back} size={14} />
        </button>
        <div className="settings-appicon" data-tauri-drag-region="">
          <AppIcon />
        </div>
        <div className="settings-appname" data-tauri-drag-region="">
          Notepadly
        </div>
        <div className="settings-drag" data-tauri-drag-region="" />
        <CaptionButtons />
      </div>
      <div className="settings-scroll">
        <div className="settings-grid">
          <h1 className="settings-h1">Settings</h1>
          <div className="settings-col">
            <h2 className="settings-label">Appearance</h2>
            <Expander icon={<Icon cp={G.palette} />} title="App theme" subtitle="Select which app theme to display">
              <Radios label="App theme" value={s.theme} options={THEMES} onChange={(v) => set("theme", v)} />
            </Expander>

            <h2 className="settings-label">Text Formatting</h2>
            <FontCard />
            <ToggleCard
              icon={
                <span className="card-icon">
                  <WordWrapIcon />
                </span>
              }
              title="Word wrap"
              subtitle="Fit text within window by default"
              value={s.wordWrap}
              onChange={(v) => set("wordWrap", v)}
            />
            <ToggleCard icon={<Icon cp={G.formatting} />} title="Formatting" value={s.formatting} onChange={(v) => set("formatting", v)} />

            <h2 className="settings-label">Opening</h2>
            <div className="card">
              <div className="card-head">
                <Icon cp={G.openFile} />
                <div className="card-text">
                  <div className="card-title">Opening files</div>
                  <div className="card-sub">Choose where your files are opened</div>
                </div>
                <Select label="Opening files" value={s.openFilesIn} options={OPEN_OPTIONS} onChange={(v) => set("openFilesIn", v as SettingsModel["openFilesIn"])} />
              </div>
            </div>
            <Expander icon={<Icon cp={G.startup} />} title="When Notepadly starts">
              <Radios label="When Notepadly starts" value={s.startup} options={STARTUP} onChange={(v) => set("startup", v)} />
            </Expander>
            <ToggleCard
              icon={<Icon cp={G.speed} />}
              title="Keep running in the background"
              subtitle="Opens instantly next time. Uses little memory while closed."
              value={s.background}
              onChange={(v) => set("background", v)}
            />
            <ToggleCard icon={<Icon cp={G.recent} />} title="Recent Files" value={s.recentFiles} onChange={(v) => set("recentFiles", v)} />

            <h2 className="settings-label">Spelling</h2>
            <ToggleCard icon={<Icon cp={G.spell} />} title="Spell check" value={s.spellcheck} onChange={(v) => set("spellcheck", v)} />
            <ToggleCard
              icon={<Icon cp={G.autocorrect} />}
              title="Autocorrect"
              subtitle="Typos are automatically corrected when spell check is turned on"
              value={s.autocorrect}
              onChange={(v) => set("autocorrect", v)}
            />
          </div>
          <About />
        </div>
      </div>
    </div>
  );
}
