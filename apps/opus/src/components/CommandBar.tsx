// Ctrl+K command bar: type to find any action and press Enter.
import { useEffect, useMemo, useRef, useState } from "react";

export interface Command {
  id: string;
  title: string;
  shortcut?: string;
  keywords?: string;
  enabled?: boolean;
  run: () => void;
}

function score(cmd: Command, q: string): number {
  if (!q) return 1;
  const hay = `${cmd.title} ${cmd.keywords ?? ""}`.toLowerCase();
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  let s = 0;
  for (const w of words) {
    const at = hay.indexOf(w);
    if (at < 0) return 0;
    s += at === 0 ? 3 : hay[at - 1] === " " ? 2 : 1;
  }
  return s;
}

export function CommandBar({ commands, onClose }: { commands: Command[]; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const results = useMemo(() => {
    return commands
      .filter((c) => c.enabled !== false)
      .map((c) => ({ c, s: score(c, q) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.c);
  }, [commands, q]);

  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector(".active")?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const run = (c: Command | undefined) => {
    if (!c) return;
    onClose();
    setTimeout(c.run, 0);
  };

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="command-bar" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Command bar">
        <input
          ref={inputRef}
          value={q}
          placeholder="Type a command…  (e.g. merge, rotate, password)"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, results.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              run(results[active]);
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
        />
        <div className="command-list" ref={listRef}>
          {results.length === 0 && <div className="command-empty">No matching command</div>}
          {results.map((c, i) => (
            <button
              key={c.id}
              className={`command-item ${i === active ? "active" : ""}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => run(c)}
            >
              <span>{c.title}</span>
              {c.shortcut && <kbd>{c.shortcut}</kbd>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
