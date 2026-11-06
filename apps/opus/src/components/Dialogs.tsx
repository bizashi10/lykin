// Small pop-up windows: password entry, protect, split, go-to-page.
import { useEffect, useRef, useState, type ReactNode } from "react";

function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="modal" role="dialog" aria-label={title} onMouseDown={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function PasswordDialog({
  fileName, wrong, onSubmit, onCancel,
}: { fileName: string; wrong: boolean; onSubmit: (pw: string) => void; onCancel: () => void }) {
  const [pw, setPw] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <Modal title="Password required" onClose={onCancel}>
      <p>
        <b>{fileName}</b> is protected. Enter its password to open it.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(pw);
        }}
      >
        <input ref={ref} type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Password" aria-label="Password" />
        {wrong && <div className="form-error">That password is not correct. Try again.</div>}
        <div className="modal-buttons">
          <button type="button" onClick={onCancel}>Cancel</button>
          <button type="submit" className="primary">Open</button>
        </div>
      </form>
    </Modal>
  );
}

export function ProtectDialog({
  hasPassword, onSubmit, onRemove, onCancel,
}: { hasPassword: boolean; onSubmit: (pw: string) => void; onRemove: () => void; onCancel: () => void }) {
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [err, setErr] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <Modal title={hasPassword ? "Change password" : "Protect with a password"} onClose={onCancel}>
      <p>
        Anyone opening this PDF will need the password. The file is locked with strong AES-256 encryption.
        <br />
        <b>Keep the password safe — it cannot be recovered if you forget it.</b>
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (pw.length < 1) return setErr("Type a password.");
          if (pw !== pw2) return setErr("The two passwords don't match.");
          onSubmit(pw);
        }}
      >
        <input ref={ref} type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="New password" aria-label="New password" />
        <input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} placeholder="Type it again" aria-label="Confirm password" />
        {err && <div className="form-error">{err}</div>}
        <div className="modal-buttons">
          {hasPassword && (
            <button type="button" className="danger-text" onClick={onRemove}>
              Remove password
            </button>
          )}
          <span className="spacer" />
          <button type="button" onClick={onCancel}>Cancel</button>
          <button type="submit" className="primary">{hasPassword ? "Change password" : "Protect"}</button>
        </div>
      </form>
      <p className="hint">The password is applied the next time you save.</p>
    </Modal>
  );
}

export type SplitMode = "every" | "ranges" | "each";

export function SplitDialog({
  pageCount, onSubmit, onCancel,
}: { pageCount: number; onSubmit: (mode: SplitMode, value: string) => void; onCancel: () => void }) {
  const [mode, setMode] = useState<SplitMode>("ranges");
  const [ranges, setRanges] = useState(pageCount > 1 ? `1-${Math.ceil(pageCount / 2)}, ${Math.ceil(pageCount / 2) + 1}-${pageCount}` : "1");
  const [every, setEvery] = useState("1");
  return (
    <Modal title="Split into several PDFs" onClose={onCancel}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(mode, mode === "ranges" ? ranges : mode === "every" ? every : "1");
        }}
      >
        <label className="radio">
          <input type="radio" checked={mode === "ranges"} onChange={() => setMode("ranges")} />
          <span>By page ranges — one file per range</span>
        </label>
        {mode === "ranges" && (
          <input value={ranges} onChange={(e) => setRanges(e.target.value)} placeholder="e.g. 1-3, 4-6, 7-" aria-label="Page ranges" autoFocus />
        )}
        <label className="radio">
          <input type="radio" checked={mode === "every"} onChange={() => setMode("every")} />
          <span>Every few pages</span>
        </label>
        {mode === "every" && (
          <div className="inline">
            A new file every
            <input type="number" min={1} max={pageCount} value={every} onChange={(e) => setEvery(e.target.value)} aria-label="Pages per file" style={{ width: 80 }} />
            pages
          </div>
        )}
        <label className="radio">
          <input type="radio" checked={mode === "each"} onChange={() => setMode("each")} />
          <span>Each page as its own file ({pageCount} files)</span>
        </label>
        <div className="modal-buttons">
          <span className="spacer" />
          <button type="button" onClick={onCancel}>Cancel</button>
          <button type="submit" className="primary">Choose folder & split</button>
        </div>
      </form>
    </Modal>
  );
}

export function GotoDialog({ pageCount, onSubmit, onCancel }: { pageCount: number; onSubmit: (i: number) => void; onCancel: () => void }) {
  const [v, setV] = useState("");
  return (
    <Modal title="Go to page" onClose={onCancel}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const n = parseInt(v, 10);
          if (n >= 1 && n <= pageCount) onSubmit(n - 1);
        }}
      >
        <input autoFocus type="number" min={1} max={pageCount} value={v} onChange={(e) => setV(e.target.value)} placeholder={`1–${pageCount}`} aria-label="Page number" />
        <div className="modal-buttons">
          <span className="spacer" />
          <button type="button" onClick={onCancel}>Cancel</button>
          <button type="submit" className="primary">Go</button>
        </div>
      </form>
    </Modal>
  );
}
