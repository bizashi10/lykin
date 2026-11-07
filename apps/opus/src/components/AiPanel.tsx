// "Chat with your PDF" and summaries, powered by the offline model. Handles
// first-run setup (download), starting the model, and streaming replies.
import { useEffect, useRef, useState } from "react";
import {
  aiInfo, setupAI, cancelSetup, startServer, streamChat, chatMessages, summarizeMessages,
  type AiInfo, type SetupProgress, type ChatMessage,
} from "../lib/ai";
import { isDesktop } from "../lib/platform";
import { Icon } from "./Icon";

type Phase = "checking" | "needs-setup" | "setting-up" | "starting" | "ready" | "error";

interface Props {
  getText: () => Promise<string>;
  docName: string;
  onClose: () => void;
}

interface Turn {
  role: "user" | "assistant";
  content: string;
}

function mb(n: number) {
  return n >= 1024 ? `${(n / 1024).toFixed(1)} GB` : `${Math.round(n)} MB`;
}

export function AiPanel({ getText, docName, onClose }: Props) {
  const [phase, setPhase] = useState<Phase>("checking");
  const [info, setInfo] = useState<AiInfo | null>(null);
  const [progress, setProgress] = useState<SetupProgress | null>(null);
  const [error, setError] = useState("");
  const [port, setPort] = useState(0);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const docText = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    (async () => {
      if (!isDesktop) { setPhase("error"); setError("The AI runs in the installed Opus app."); return; }
      try {
        const i = await aiInfo();
        setInfo(i);
        if (i.running && i.port) { setPort(i.port); setPhase("ready"); }
        else if (i.has_server && i.model_present) start();
        else setPhase("needs-setup");
      } catch (e) {
        setPhase("error"); setError(String((e as Error).message ?? e));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [turns, busy]);

  const runSetup = async () => {
    setPhase("setting-up"); setError("");
    try {
      await setupAI(setProgress);
      await start();
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      if (msg.includes("cancel")) { setPhase("needs-setup"); setProgress(null); }
      else { setPhase("error"); setError(msg); }
    }
  };

  const start = async () => {
    setPhase("starting"); setError("");
    try {
      const p = await startServer();
      setPort(p); setPhase("ready");
    } catch (e) {
      setPhase("error"); setError(String((e as Error).message ?? e));
    }
  };

  const ensureText = async () => {
    if (docText.current === null) docText.current = await getText().catch(() => "");
    return docText.current ?? "";
  };

  const ask = async (question: string, build?: (doc: string) => ChatMessage[]) => {
    if (busy || !port) return;
    const q = question.trim();
    if (!q && !build) return;
    setInput("");
    setBusy(true);
    const history: ChatMessage[] = turns.map((t) => ({ role: t.role, content: t.content }));
    setTurns((t) => [...t, ...(q ? [{ role: "user" as const, content: q }] : []), { role: "assistant", content: "" }]);
    const doc = await ensureText();
    const messages = build ? build(doc) : chatMessages(doc, q, history);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      await streamChat(port, messages, {
        signal: ctrl.signal,
        onToken: (piece) => setTurns((t) => {
          const copy = [...t];
          copy[copy.length - 1] = { role: "assistant", content: copy[copy.length - 1].content + piece };
          return copy;
        }),
      });
    } catch (e) {
      if (!ctrl.signal.aborted) {
        setTurns((t) => {
          const copy = [...t];
          copy[copy.length - 1] = { role: "assistant", content: `⚠️ ${String((e as Error).message ?? e)}` };
          return copy;
        });
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  };

  const stop = () => abortRef.current?.abort();

  return (
    <aside className="ai-panel" aria-label="AI assistant">
      <header className="ai-head">
        <span className="ai-title"><Icon name="spark" size={16} /> Assistant</span>
        <span className="ai-doc" title={docName}>{docName}</span>
        <button className="icon-only" onClick={onClose} title="Close"><Icon name="close" size={16} /></button>
      </header>

      {phase === "checking" && <div className="ai-center"><div className="spinner" /> Checking…</div>}

      {phase === "needs-setup" && (
        <div className="ai-setup">
          <div className="ai-spark"><Icon name="spark" size={30} /></div>
          <h3>Set up the offline assistant</h3>
          <p>Opus will download the AI engine and the {info?.model_name ?? "model"} (~{mb(info?.model_size_mb ?? 4700)}) once. After that it runs entirely on your PC — no internet, no account, nothing leaves your computer.</p>
          <p className="ai-note">Works best with an NVIDIA GPU. The download is large; it only happens once.</p>
          <button className="primary big" onClick={runSetup}>Download &amp; set up</button>
        </div>
      )}

      {phase === "setting-up" && (
        <div className="ai-setup">
          <h3>Setting up…</h3>
          <p>{progress?.note ?? "Starting…"}</p>
          {progress && progress.total > 0 ? (
            <>
              <div className="ai-bar"><div style={{ width: `${Math.min(100, (progress.received / progress.total) * 100)}%` }} /></div>
              <div className="ai-bar-label">{mb(progress.received / 1048576)} of {mb(progress.total / 1048576)}</div>
            </>
          ) : <div className="ai-bar indeterminate"><div /></div>}
          <button onClick={() => cancelSetup()}>Cancel</button>
        </div>
      )}

      {phase === "starting" && <div className="ai-center"><div className="spinner" /> Loading the model…<br /><span className="ai-note">First load can take up to a minute.</span></div>}

      {phase === "error" && (
        <div className="ai-setup">
          <div className="ai-spark error"><Icon name="info" size={28} /></div>
          <h3>The assistant isn't available</h3>
          <p className="form-error">{error}</p>
          <button onClick={() => { setPhase("checking"); setError(""); aiInfo().then((i) => { setInfo(i); setPhase(i.has_server && i.model_present ? "starting" : "needs-setup"); if (i.has_server && i.model_present) start(); }); }}>Try again</button>
        </div>
      )}

      {phase === "ready" && (
        <>
          <div className="ai-chat" ref={listRef}>
            {turns.length === 0 && (
              <div className="ai-welcome">
                <p>Ask anything about <b>{docName}</b>.</p>
                <div className="ai-chips">
                  <button onClick={() => ask("", (d) => summarizeMessages(d, "brief"))}>Summarize</button>
                  <button onClick={() => ask("", (d) => summarizeMessages(d, "bullets"))}>Key points</button>
                  <button onClick={() => ask("What are the most important dates, names and figures?")}>Dates &amp; figures</button>
                </div>
                <p className="ai-note">Answers come from the document text. The assistant can still make mistakes — check anything important.</p>
              </div>
            )}
            {turns.map((t, i) => (
              <div key={i} className={`ai-msg ${t.role}`}>
                {t.role === "assistant" && <span className="ai-av"><Icon name="spark" size={13} /></span>}
                <div className="ai-bubble">{t.content || <span className="ai-dots"><i /><i /><i /></span>}</div>
              </div>
            ))}
          </div>
          <form
            className="ai-input"
            onSubmit={(e) => { e.preventDefault(); ask(input); }}
          >
            <textarea
              value={input}
              placeholder={`Ask about ${docName}…`}
              rows={1}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(input); } }}
              disabled={busy}
            />
            {busy ? (
              <button type="button" className="ai-send stop" onClick={stop} title="Stop"><Icon name="stop" size={16} /></button>
            ) : (
              <button type="submit" className="ai-send" disabled={!input.trim()} title="Send"><Icon name="send" size={16} /></button>
            )}
          </form>
        </>
      )}
    </aside>
  );
}
