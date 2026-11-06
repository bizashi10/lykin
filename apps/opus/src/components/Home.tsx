// Home: a single command field that finds tools as you type, recent files,
// and every tool grouped by what it's for. Dropping files here suggests tools.
import { useEffect, useMemo, useRef, useState } from "react";
import { CATEGORIES, TOOLS, matchTool, suggestFor, type ToolDef } from "../tools/registry";
import { Icon } from "./Icon";
import type { PickedFile } from "../lib/platform";
import type { Recent } from "../lib/recents";

interface Props {
  onTool: (tool: ToolDef, files?: PickedFile[]) => void;
  onOpen: () => void;
  onOpenRecent: (r: Recent) => void;
  onForgetRecent: (r: Recent) => void;
  recents: Recent[];
  dropped: PickedFile[] | null;
  onClearDropped: () => void;
  onOpenDropped: () => void;
  openDoc: { name: string } | null;
  onResume: () => void;
}

export function Home(props: Props) {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const results = useMemo(() => {
    if (!q.trim()) return [];
    return TOOLS.map((t) => ({ t, s: matchTool(t, q) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => Number(!!a.t.soon) - Number(!!b.t.soon) || b.s - a.s)
      .map((x) => x.t);
  }, [q]);
  useEffect(() => setActive(0), [q]);

  // Typing anywhere on the home screen goes to the search field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1) return;
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, [contenteditable], .overlay")) return;
      inputRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const suggestions = props.dropped ? suggestFor(props.dropped) : [];
  const launch = (t: ToolDef) => {
    if (t.soon) return;
    props.onTool(t, props.dropped ?? undefined);
  };

  return (
    <div className="home">
      <div className="home-inner">
        <section className="hero">
          <h1 className="hero-title">What are we finishing today?</h1>
          <div className={`command-field ${results.length ? "open" : ""}`}>
            <Icon name="search" size={20} />
            <input
              ref={inputRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Compress, merge, watermark, page numbers…"
              aria-label="Find a tool"
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)); }
                else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
                else if (e.key === "Enter" && results[active]) { e.preventDefault(); launch(results[active]); }
                else if (e.key === "Escape") setQ("");
              }}
            />
            <button className="open-btn" onClick={props.onOpen} title="Open a PDF in the page editor (Ctrl+O)">
              <Icon name="open" size={17} /> <span>Open PDF</span>
            </button>
            {results.length > 0 && (
              <div className="command-results" role="listbox">
                {results.slice(0, 7).map((t, i) => (
                  <button
                    key={t.id}
                    role="option"
                    aria-selected={i === active}
                    className={`cr-item cat-${t.category} ${i === active ? "active" : ""} ${t.soon ? "soon" : ""}`}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => launch(t)}
                  >
                    <span className="glyph"><Icon name={t.icon} size={17} /></span>
                    <span className="cr-text">
                      <strong>{t.name}</strong>
                      <span>{t.soon ? "Coming in a later update" : t.blurb}</span>
                    </span>
                    {i === active && !t.soon && <kbd>Enter</kbd>}
                  </button>
                ))}
              </div>
            )}
          </div>
          <p className="hero-sub">
            Everything runs on this PC. Drop files anywhere to get suggestions.
          </p>
        </section>

        {props.dropped && (
          <section className="dropped" aria-label="Suggested tools">
            <div className="dropped-head">
              <div className="dropped-files">
                <Icon name={props.dropped.every((f) => /\.pdf$/i.test(f.name)) ? "file" : "image"} size={18} />
                <strong>
                  {props.dropped.length === 1 ? props.dropped[0].name : `${props.dropped.length} files`}
                </strong>
                <span>What should Opus do with {props.dropped.length === 1 ? "it" : "them"}?</span>
              </div>
              <button className="ghost" onClick={props.onClearDropped}>Dismiss</button>
            </div>
            <div className="suggest-row">
              {props.dropped.length === 1 && /\.pdf$/i.test(props.dropped[0].name) && (
                <button className="suggest primary-suggest" onClick={props.onOpenDropped}>
                  <Icon name="read" size={18} /> Open in editor
                </button>
              )}
              {suggestions.map((t) => (
                <button key={t.id} className={`suggest cat-${t.category}`} onClick={() => launch(t)}>
                  <Icon name={t.icon} size={18} /> {t.name}
                </button>
              ))}
            </div>
          </section>
        )}

        {(props.openDoc || props.recents.length > 0) && (
          <section className="recents" aria-label="Recent files">
            <h2 className="section-title">Pick up where you left off</h2>
            <div className="recent-row">
              {props.openDoc && (
                <button className="recent current" onClick={props.onResume}>
                  <Icon name="read" size={18} />
                  <span className="recent-name">{props.openDoc.name}</span>
                  <span className="recent-when">Open now</span>
                </button>
              )}
              {props.recents.slice(0, 6).map((r) => (
                <div key={r.path} className="recent-wrap">
                  <button className="recent" onClick={() => props.onOpenRecent(r)} title={r.path}>
                    <Icon name="file" size={18} />
                    <span className="recent-name">{r.name}</span>
                    <span className="recent-when">{timeAgo(r.at)}</span>
                  </button>
                  <button className="recent-forget" onClick={() => props.onForgetRecent(r)} title="Remove from recent" aria-label={`Remove ${r.name} from recent`}>
                    <Icon name="close" size={12} />
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}

        <div className="catalog">
          {CATEGORIES.map((c) => (
            <section key={c.id} className={`category cat-${c.id}`} aria-labelledby={`cat-${c.id}`}>
              <div className="category-head">
                <h2 id={`cat-${c.id}`}>{c.name}</h2>
                <p>{c.hint}</p>
              </div>
              <div className="tool-grid">
                {TOOLS.filter((t) => t.category === c.id).map((t) => (
                  <button
                    key={t.id}
                    className={`tool-tile ${t.soon ? "soon" : ""}`}
                    onClick={() => launch(t)}
                    disabled={t.soon}
                    title={t.soon ? "Coming in a later update" : t.blurb}
                  >
                    <span className="glyph"><Icon name={t.icon} size={20} /></span>
                    <span className="tile-text">
                      <strong>{t.name}</strong>
                      <span>{t.blurb}</span>
                    </span>
                    {t.soon && <span className="soon-tag">Soon</span>}
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
        <footer className="home-foot">
          <span>Opus is part of Lykin</span>
          <span>No account · No uploads · No limits</span>
        </footer>
      </div>
    </div>
  );
}

function timeAgo(ts: number): string {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86400);
  if (d === 1) return "yesterday";
  if (d < 7) return `${d} days ago`;
  return new Date(ts).toLocaleDateString();
}
