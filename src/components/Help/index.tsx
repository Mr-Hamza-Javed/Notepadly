// Help page: what Notepadly can do and how to use it. A lazy chunk, loaded on first open.
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { actions } from "../../state/actions";
import "../../styles/settings.css";
import "../../styles/help.css";
import { CaptionButtons } from "../CaptionButtons";
import { focusEditorSoon } from "../focus";
import { AppIcon, G, Glyph } from "../icons";

interface Section {
  id: string;
  title: string;
  /** Extra words that should find this section in the search box. */
  keywords: string;
  body: ReactNode;
}

const K = ({ children }: { children: string }) => (
  <>
    {children.split("+").map((key, i) => (
      <span key={i}>
        {i > 0 && "+"}
        <kbd>{key}</kbd>
      </span>
    ))}
  </>
);

const C = ({ children }: { children: string }) => <code>{children}</code>;

function Table({ head, rows }: { head: [string, string]; rows: [ReactNode, ReactNode][] }) {
  return (
    <table className="help-table">
      <thead>
        <tr>
          <th>{head[0]}</th>
          <th>{head[1]}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([a, b], i) => (
          <tr key={i}>
            <td>{a}</td>
            <td>{b}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const SECTIONS: Section[] = [
  {
    id: "start",
    title: "Getting started",
    keywords: "intro basics new open first",
    body: (
      <>
        <p>
          Notepadly is a fast notepad that edits Markdown live. You type plain text, and formatting such as
          headings, bold text, lists and tables appears right where you write it. There is no separate preview.
        </p>
        <ul>
          <li>
            Start typing in the empty tab, or open a file with <K>Ctrl+O</K>. You can also drag files onto the
            window or open them from File Explorer.
          </li>
          <li>
            Save with <K>Ctrl+S</K>. New notes are saved as <C>.md</C> (Markdown) files.
          </li>
          <li>
            Click any formatted line to see its Markdown. Move the cursor away and it is formatted again.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "tabs",
    title: "Tabs and windows",
    keywords: "tab window close reorder drag session",
    body: (
      <ul>
        <li>
          <K>Ctrl+N</K> opens a new tab, <K>Ctrl+W</K> closes it, <K>Ctrl+Shift+N</K> opens a new window.
        </li>
        <li>
          Switch tabs with <K>Ctrl+Tab</K> and <K>Ctrl+Shift+Tab</K>, or jump straight to a tab with <K>Ctrl+1</K>{" "}
          to <K>Ctrl+9</K>.
        </li>
        <li>Drag a tab to reorder it. Middle-click a tab to close it.</li>
        <li>Right-click a tab to close others, close tabs to the right, copy the file path or show it in Explorer.</li>
        <li>A dot on a tab means it has unsaved changes. Hover the dot to close the tab.</li>
        <li>
          An untitled tab takes its name from the first line you type.
        </li>
      </ul>
    ),
  },
  {
    id: "files",
    title: "Opening and saving files",
    keywords: "save open lock large big encoding utf line ending crlf lf recent session draft changed disk background memory fast start update version",
    body: (
      <>
        <ul>
          <li>
            <strong>Files are never locked.</strong> Other programs can edit, rename or delete a file while it is open
            in Notepadly.
          </li>
          <li>
            <strong>Large files open instantly.</strong> The beginning shows at once and the rest loads as you scroll,
            so even very big files do not slow the app down.
          </li>
          <li>
            If a file changes on disk, a clean tab reloads by itself. If you have unsaved edits, a bar asks whether to
            reload or keep your version. Your edits are never overwritten without asking.
          </li>
          <li>
            Unsaved notes are kept when you close the app and come back the next time you open it. You can change
            this in Settings under <em>When Notepadly starts</em>.
          </li>
          <li>
            The status bar shows the line ending (Windows CRLF, Unix LF) and encoding (UTF-8, UTF-16, ANSI). Click
            either to change it.
          </li>
          <li>
            <em>File &gt; Recent</em> lists the last files you opened.
          </li>
          <li>
            Closing the last window keeps Notepadly asleep in the background, using very little memory, so it opens
            again instantly. Turn this off in Settings under <em>Keep running in the background</em>.
          </li>
          <li>
            The installed app updates itself. It downloads a new version in the background and installs it only after
            you close the window, so your work is never interrupted. Your notes, drafts and settings are always kept.
            Turn this off in Settings under <em>Update automatically</em>.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "modes",
    title: "Formatted, Markdown syntax and Plain text",
    keywords: "mode formatted syntax plain raw markdown toggle status bar",
    body: (
      <>
        <p>Each tab shows its mode at the bottom of the window:</p>
        <ul>
          <li>
            <strong>Formatted</strong>: live Markdown. Formatting is shown, and the Markdown marks appear only on the
            line you are editing. The formatting toolbar is visible.
          </li>
          <li>
            <strong>Markdown syntax</strong>: all Markdown marks stay visible, still with colours.
          </li>
          <li>
            <strong>Plain text</strong>: no formatting at all. Used for <C>.txt</C> and other non-Markdown files.
          </li>
        </ul>
        <p>
          Click <em>Formatted</em> in the status bar to switch to <em>Markdown syntax</em> and back. Turn formatting
          off for new tabs with <em>View &gt; Formatting</em> or in Settings.
        </p>
      </>
    ),
  },
  {
    id: "toolbar",
    title: "Formatting toolbar",
    keywords: "toolbar heading bold italic list table link clear",
    body: (
      <Table
        head={["Button", "What it does"]}
        rows={[
          ["H1 ▾", "Turns the line into a heading (1 to 6) or back into body text."],
          ["List ▾", "Bulleted, numbered or task list."],
          [<strong>B</strong>, <>Bold. Shortcut <K>Ctrl+B</K>.</>],
          [<em>I</em>, <>Italic. Shortcut <K>Ctrl+I</K>.</>],
          [<s>S</s>, "Strikethrough."],
          ["Link", <>Adds a link. Shortcut <K>Ctrl+K</K>.</>],
          ["Table ▾", "Hover the grid to pick a size, then click. Edit table adds or removes rows and columns."],
          ["Clear", "Removes the formatting from the selected text."],
        ]}
      />
    ),
  },
  {
    id: "markdown",
    title: "Markdown reference",
    keywords: "syntax cheat sheet heading bold italic list quote code link image wikilink tag footnote comment frontmatter highlight",
    body: (
      <Table
        head={["Type this", "To get"]}
        rows={[
          [<C>{"# Heading"}</C>, "Heading 1 (use ## to ###### for smaller headings)"],
          [<C>{"**bold**"}</C>, <strong>bold</strong>],
          [<C>{"*italic*"}</C>, <em>italic</em>],
          [<C>{"~~strike~~"}</C>, <s>strike</s>],
          [<C>{"==highlight=="}</C>, <mark>highlight</mark>],
          [<C>{"`code`"}</C>, <code>code</code>],
          [<C>{"[text](https://…)"}</C>, "A link. Ctrl+click to open it."],
          [<C>{"[[Note name]]"}</C>, "A link to another note in the same folder."],
          [<C>{"![alt](image.png)"}</C>, "An image. Add |200 after the alt text to set its width."],
          [<C>{"- item"}</C>, "Bulleted list"],
          [<C>{"1. item"}</C>, "Numbered list"],
          [<C>{"- [ ] task"}</C>, "Task with a checkbox you can click"],
          [<C>{"> quote"}</C>, "Quote"],
          [<C>{"> [!note] Title"}</C>, "Callout box (note, tip, warning, danger, info, example and more)"],
          [<C>{"---"}</C>, "Horizontal line"],
          [<C>{"```js"}</C>, "Code block with colours for the language"],
          [<C>{"$E = mc^2$"}</C>, "Maths formula"],
          [<C>{"#tag"}</C>, "Tag"],
          [<C>{"text[^1]"}</C>, "Footnote, with [^1]: note text on its own line"],
          [<C>{"%% note to self %%"}</C>, "Comment, dimmed and left out when printing"],
          [<C>{"<kbd>Ctrl</kbd>"}</C>, <kbd>Ctrl</kbd>],
        ]}
      />
    ),
  },
  {
    id: "lists",
    title: "Lists and tasks",
    keywords: "list bullet number task checkbox indent enter tab",
    body: (
      <ul>
        <li>Press Enter at the end of a list item to start the next one. Press Enter on an empty item to end the list.</li>
        <li>
          <K>Tab</K> indents an item, <K>Shift+Tab</K> moves it back out.
        </li>
        <li>Click a task checkbox to tick or untick it.</li>
      </ul>
    ),
  },
  {
    id: "tables",
    title: "Tables",
    keywords: "table cell row column edit grid",
    body: (
      <>
        <p>
          Tables always stay tables. Click a cell to edit it in place; while you edit, the cell shows its own
          Markdown.
        </p>
        <Table
          head={["Key", "In a table cell"]}
          rows={[
            [<K>Tab</K>, "Next cell. In the last cell, adds a new row."],
            [<K>Shift+Tab</K>, "Previous cell."],
            [<K>Enter</K>, "Cell below. In the last row, adds a new row."],
            [<K>Shift+Enter</K>, "Line break inside the cell."],
            ["Arrow keys", "Move between cells. Up from the top row or down from the last row leaves the table."],
            [<K>Esc</K>, "Leaves the table and puts the cursor below it."],
          ]}
        />
        <p>
          Insert a table from the toolbar's table button. Right-click any cell, or use <em>Edit table</em> while a
          cell is selected, to add or delete rows and columns. A table can't be inserted inside another table, so
          the insert options are greyed out while the cursor is in one.
        </p>
      </>
    ),
  },
  {
    id: "blocks",
    title: "Maths, diagrams and images",
    keywords: "math katex latex mermaid diagram chart image picture edit source double click",
    body: (
      <>
        <p>
          Maths formulas, Mermaid diagrams, images and horizontal lines stay rendered when you click them, so you
          can read and select around them freely.
        </p>
        <ul>
          <li>
            <strong>To edit one, double-click it</strong>, or hover a formula or diagram and click the edit button in
            its corner. Its Markdown opens; click elsewhere and it renders again.
          </li>
          <li>
            Block maths goes between <C>$$</C> lines. Diagrams go in a code block that starts with{" "}
            <C>```mermaid</C>.
          </li>
          <li>Images can use a path relative to the note, so keep pictures next to your notes.</li>
        </ul>
      </>
    ),
  },
  {
    id: "find",
    title: "Find, replace and go to",
    keywords: "find search replace go to line next previous bing",
    body: (
      <ul>
        <li>
          <K>Ctrl+F</K> finds text and <K>Ctrl+H</K> replaces it. <K>F3</K> and <K>Shift+F3</K> jump to the next
          and previous match.
        </li>
        <li>
          <K>Ctrl+G</K> goes to a line number.
        </li>
        <li>
          <K>Ctrl+E</K> searches the web for the selected text.
        </li>
      </ul>
    ),
  },
  {
    id: "view",
    title: "View, zoom and printing",
    keywords: "zoom word wrap status bar print page setup font size theme dark light",
    body: (
      <ul>
        <li>
          Zoom with <K>Ctrl++</K> and <K>Ctrl+-</K>, or <K>Ctrl</K> + mouse wheel. <K>Ctrl+0</K> resets it.
        </li>
        <li>
          <em>View</em> turns word wrap, the status bar and formatting on or off.
        </li>
        <li>
          Print with <K>Ctrl+P</K>. <em>File &gt; Page setup</em> sets orientation, margins, header and footer.
        </li>
        <li>
          <em>Settings</em> (the gear) changes the theme, font, spelling and what happens when the app starts.
        </li>
        <li>
          <K>F5</K> inserts the current time and date.
        </li>
      </ul>
    ),
  },
  {
    id: "languages",
    title: "Languages",
    keywords: "urdu arabic hebrew rtl right to left language script unicode emoji",
    body: (
      <p>
        Every language and script works. Lines written right to left, such as Urdu, Arabic or Hebrew, start from
        the right on their own, even in lists, quotes and tables.
      </p>
    ),
  },
  {
    id: "shortcuts",
    title: "All keyboard shortcuts",
    keywords: "keyboard shortcut keys hotkey",
    body: (
      <Table
        head={["Shortcut", "Action"]}
        rows={[
          [<K>Ctrl+N</K>, "New tab"],
          [<K>Ctrl+Shift+N</K>, "New window"],
          [<K>Ctrl+O</K>, "Open"],
          [<K>Ctrl+S</K>, "Save"],
          [<K>Ctrl+Shift+S</K>, "Save as"],
          [<K>Ctrl+Alt+S</K>, "Save all"],
          [<K>Ctrl+P</K>, "Print"],
          [<K>Ctrl+W</K>, "Close tab"],
          [<K>Ctrl+Shift+W</K>, "Close window"],
          [<K>Ctrl+Z</K>, "Undo"],
          [<K>Ctrl+Y</K>, "Redo"],
          [<K>Ctrl+F</K>, "Find"],
          [<K>Ctrl+H</K>, "Replace"],
          [<K>F3</K>, "Find next"],
          [<K>Shift+F3</K>, "Find previous"],
          [<K>Ctrl+G</K>, "Go to line"],
          [<K>Ctrl+E</K>, "Search the web"],
          [<K>Ctrl+A</K>, "Select all"],
          [<K>F5</K>, "Insert time and date"],
          [<K>Ctrl+B</K>, "Bold"],
          [<K>Ctrl+I</K>, "Italic"],
          [<K>Ctrl+K</K>, "Link"],
          [<K>Ctrl+Tab</K>, "Next tab"],
          [<K>Ctrl+Shift+Tab</K>, "Previous tab"],
          [<K>Ctrl+1</K>, "First tab (1 to 8), Ctrl+9 for the last"],
          [<K>Ctrl++</K>, "Zoom in"],
          [<K>Ctrl+-</K>, "Zoom out"],
          [<K>Ctrl+0</K>, "Reset zoom"],
          [<K>F1</K>, "Open this help"],
          [<K>Esc</K>, "Close help, settings or the find bar"],
        ]}
      />
    ),
  },
];

function goBack(): void {
  actions.closeSettings();
  focusEditorSoon();
}

const Nav = memo(function Nav({ sections, onPick }: { sections: Section[]; onPick: (id: string) => void }) {
  return (
    <nav className="help-nav" aria-label="Help topics">
      {sections.map((s) => (
        <button key={s.id} type="button" className="help-nav-item" onClick={() => onPick(s.id)}>
          {s.title}
        </button>
      ))}
    </nav>
  );
});

export default function Help() {
  const [query, setQuery] = useState("");
  const scroller = useRef<HTMLDivElement>(null);

  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return SECTIONS;
    return SECTIONS.filter((s) => {
      const hay = `${s.title} ${s.keywords}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [query]);

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

  const pick = (id: string) => {
    const target = scroller.current?.querySelector<HTMLElement>(`#help-${id}`);
    target?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="settings-page help-page">
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
      <div className="settings-scroll" ref={scroller}>
        <div className="help-grid">
          <header className="help-head">
            <h1 className="settings-h1">Help</h1>
            <input
              className="text-input help-search"
              type="search"
              placeholder="Search help"
              aria-label="Search help"
              value={query}
              autoFocus
              onChange={(e) => setQuery(e.target.value)}
            />
          </header>
          <Nav sections={shown} onPick={pick} />
          <main className="help-main">
            {shown.length === 0 && <p className="help-empty">Nothing matches “{query}”.</p>}
            {shown.map((s) => (
              <section key={s.id} id={`help-${s.id}`} className="card help-card">
                <h2 className="help-h2">{s.title}</h2>
                {s.body}
              </section>
            ))}
          </main>
        </div>
      </div>
    </div>
  );
}
