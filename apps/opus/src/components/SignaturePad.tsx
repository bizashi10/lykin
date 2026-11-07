// Create a signature three ways: draw it, type it, or upload an image.
// Produces a trimmed, transparent PNG ready to place on the page.
import { useEffect, useRef, useState } from "react";
import { prepareImage } from "../lib/images";
import { Icon } from "./Icon";

export interface SignatureResult {
  bytes: Uint8Array;
  type: "png";
  width: number;
  height: number;
}

const INK = ["#13233b", "#1746d6", "#c62f2f"];
const SCRIPT_FONTS = [
  { label: "Flowing", css: '"Segoe Script", "Brush Script MT", cursive' },
  { label: "Formal", css: 'Georgia, "Times New Roman", serif' },
  { label: "Simple", css: '"Segoe UI", system-ui, sans-serif' },
];

export function SignaturePad({ onDone, onCancel }: { onDone: (s: SignatureResult) => void; onCancel: () => void }) {
  const [tab, setTab] = useState<"draw" | "type" | "upload">("draw");
  const [ink, setInk] = useState(INK[0]);
  const [typed, setTyped] = useState("");
  const [fontIdx, setFontIdx] = useState(0);
  const [uploaded, setUploaded] = useState<SignatureResult | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawn = useRef(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);

  // --- draw tab ---
  useEffect(() => {
    if (tab !== "draw") return;
    const c = canvasRef.current!;
    const ctx = c.getContext("2d")!;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    c.width = c.clientWidth * dpr;
    c.height = c.clientHeight * dpr;
    ctx.scale(dpr, dpr);
    ctx.lineJoin = ctx.lineCap = "round";
    let drawing = false;
    let last: [number, number] | null = null;
    const pos = (e: PointerEvent): [number, number] => {
      const r = c.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    const down = (e: PointerEvent) => {
      drawing = true;
      last = pos(e);
      c.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (!drawing) return;
      const p = pos(e);
      ctx.strokeStyle = ink;
      ctx.lineWidth = 2.6;
      ctx.beginPath();
      ctx.moveTo(last![0], last![1]);
      ctx.lineTo(p[0], p[1]);
      ctx.stroke();
      last = p;
      drawn.current = true;
    };
    const up = () => { drawing = false; last = null; };
    c.addEventListener("pointerdown", down);
    c.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      c.removeEventListener("pointerdown", down);
      c.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [tab, ink]);

  const clearDraw = () => {
    const c = canvasRef.current;
    if (c) c.getContext("2d")!.clearRect(0, 0, c.width, c.height);
    drawn.current = false;
  };

  /** Trims transparent margins from a canvas and returns a PNG. */
  async function finishCanvas(c: HTMLCanvasElement): Promise<SignatureResult | null> {
    const ctx = c.getContext("2d")!;
    const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height);
    let minX = width, minY = height, maxX = 0, maxY = 0, any = false;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (data[(y * width + x) * 4 + 3] > 10) {
          any = true;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (!any) return null;
    const pad = 8;
    minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
    maxX = Math.min(width - 1, maxX + pad); maxY = Math.min(height - 1, maxY + pad);
    const w = maxX - minX + 1, h = maxY - minY + 1;
    const out = document.createElement("canvas");
    out.width = w; out.height = h;
    out.getContext("2d")!.drawImage(c, minX, minY, w, h, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((r) => out.toBlob(r, "image/png"));
    if (!blob) return null;
    return { bytes: new Uint8Array(await blob.arrayBuffer()), type: "png", width: w, height: h };
  }

  async function renderTyped(): Promise<SignatureResult | null> {
    const text = typed.trim();
    if (!text) return null;
    const scale = 3;
    const fontPx = 64 * scale;
    const c = document.createElement("canvas");
    const ctx = c.getContext("2d")!;
    ctx.font = `${fontPx}px ${SCRIPT_FONTS[fontIdx].css}`;
    const w = Math.ceil(ctx.measureText(text).width) + 40 * scale;
    c.width = w;
    c.height = Math.ceil(fontPx * 1.6);
    const cx = c.getContext("2d")!;
    cx.font = `${fontPx}px ${SCRIPT_FONTS[fontIdx].css}`;
    cx.fillStyle = ink;
    cx.textBaseline = "middle";
    cx.fillText(text, 20 * scale, c.height / 2);
    return finishCanvas(c);
  }

  const confirm = async () => {
    let res: SignatureResult | null = null;
    if (tab === "draw") res = canvasRef.current ? await finishCanvas(canvasRef.current) : null;
    else if (tab === "type") res = await renderTyped();
    else res = uploaded;
    if (res) onDone(res);
  };

  const pickUpload = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/webp";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const img = await prepareImage(new Uint8Array(await file.arrayBuffer()), file.name);
      setUploaded({ bytes: img.bytes, type: "png", width: img.width, height: img.height });
    };
    input.click();
  };

  const canConfirm = tab === "type" ? typed.trim().length > 0 : tab === "upload" ? !!uploaded : true;

  return (
    <div className="overlay" onMouseDown={onCancel}>
      <div className="modal sign-modal" role="dialog" aria-label="Create signature" onMouseDown={(e) => e.stopPropagation()}>
        <h2>Add your signature</h2>
        <div className="segmented-control" role="tablist">
          {(["draw", "type", "upload"] as const).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
              {t === "draw" ? "Draw" : t === "type" ? "Type" : "Upload"}
            </button>
          ))}
        </div>

        {tab === "draw" && (
          <div className="sign-area">
            <canvas ref={canvasRef} className="sign-canvas" />
            <div className="sign-baseline" />
            <button className="ghost sign-clear" onClick={clearDraw}>Clear</button>
          </div>
        )}
        {tab === "type" && (
          <div className="sign-area">
            <input className="sign-input" style={{ fontFamily: SCRIPT_FONTS[fontIdx].css, color: ink }} value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Type your name" aria-label="Signature text" autoFocus />
            <div className="sign-fonts">
              {SCRIPT_FONTS.map((f, i) => (
                <button key={f.label} className={i === fontIdx ? "on" : ""} style={{ fontFamily: f.css }} onClick={() => setFontIdx(i)}>{f.label}</button>
              ))}
            </div>
          </div>
        )}
        {tab === "upload" && (
          <div className="sign-area upload" onClick={pickUpload}>
            {uploaded ? (
              <img alt="signature" src={URL.createObjectURL(new Blob([uploaded.bytes as BlobPart], { type: "image/png" }))} />
            ) : (
              <><Icon name="image-plus" size={28} /><span>Choose a signature image (PNG with transparency is best)</span></>
            )}
          </div>
        )}

        {tab !== "upload" && (
          <div className="sign-colors">
            Ink
            {INK.map((c) => (
              <button key={c} className={`swatch ${ink === c ? "on" : ""}`} style={{ background: c }} onClick={() => setInk(c)} aria-label={c} />
            ))}
          </div>
        )}

        <div className="modal-buttons">
          <span className="spacer" />
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" onClick={confirm} disabled={!canConfirm}>Place signature</button>
        </div>
      </div>
    </div>
  );
}
