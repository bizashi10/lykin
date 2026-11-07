// The editing canvas: place text, shapes, drawings, highlights, images,
// signatures and redactions on a page, and fill form fields.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PageRef, Source } from "../lib/pdfops";
import { normalizeRotation } from "../lib/pdfops";
import { pageSize, renderPageDataUrl } from "../lib/render";
import {
  annoBox, newAnnoId, type Anno, type ImageStore, type TextAnno, type ShapeAnno, type ImageAnno,
} from "../lib/annots";
import type { FieldWidget } from "../lib/forms";
import { prepareImage } from "../lib/images";
import { PageCanvas } from "./PageCanvas";
import { SignaturePad } from "./SignaturePad";
import { Icon } from "./Icon";

export type Tool = "select" | "text" | "note" | "draw" | "highlight" | "line" | "arrow" | "rect" | "ellipse" | "image" | "signature" | "redact";

interface Props {
  pages: PageRef[];
  sources: Map<string, Source>;
  current: number;
  onCurrent: (i: number) => void;
  annos: Record<string, Anno[]>;
  commitAnnos: (key: string, list: Anno[]) => void;
  images: ImageStore;
  addImage: (bytes: Uint8Array, type: "png" | "jpg") => string;
  formFields: FieldWidget[];
  formValues: Record<string, string>;
  setFormValue: (name: string, value: string) => void;
  formSourceId: string | null;
  toast: (t: string, tone?: "info" | "error" | "success") => void;
}

const TOOLS: { id: Tool; icon: string; label: string }[] = [
  { id: "select", icon: "cursor", label: "Select" },
  { id: "text", icon: "text", label: "Text" },
  { id: "note", icon: "note", label: "Note" },
  { id: "draw", icon: "pen", label: "Draw" },
  { id: "highlight", icon: "highlight", label: "Highlight" },
  { id: "line", icon: "line", label: "Line" },
  { id: "arrow", icon: "arrow", label: "Arrow" },
  { id: "rect", icon: "square", label: "Rectangle" },
  { id: "ellipse", icon: "circle", label: "Ellipse" },
  { id: "image", icon: "image-plus", label: "Image" },
  { id: "signature", icon: "signature", label: "Signature" },
  { id: "redact", icon: "redact", label: "Redact" },
];

const COLORS = ["#13233b", "#c62f2f", "#2f7d4f", "#2a5bd7", "#d8a01c", "#7a3fd1", "#e5383b", "#ffffff"];

export function Annotate(props: Props) {
  const { pages, sources, current, annos, commitAnnos, images } = props;
  const page = pages[current];
  const source = page ? sources.get(page.sourceId) : undefined;
  const list = useMemo(() => (page ? annos[page.key] ?? [] : []), [annos, page]);

  const [tool, setTool] = useState<Tool>("select");
  const [selected, setSelected] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [color, setColor] = useState("#c62f2f");
  const [strokeWidth, setStrokeWidth] = useState(2.5);
  const [textSize, setTextSize] = useState(16);
  const [fillOn, setFillOn] = useState(false);
  const [signOpen, setSignOpen] = useState(false);
  const [zoom, setZoom] = useState(1);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [avail, setAvail] = useState(800);
  const [size, setSize] = useState<{ vw: number; vh: number } | null>(null);
  const [pageUrl, setPageUrl] = useState<string | null>(null);

  // Visible page size at the effective rotation.
  useEffect(() => {
    if (!source || !page) return;
    let ok = true;
    pageSize(source, page.index, page.rotation).then((s) => ok && setSize({ vw: s.width, vh: s.height })).catch(() => {});
    return () => { ok = false; };
  }, [source, page]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setAvail(el.clientWidth - 48));
    ro.observe(el);
    setAvail(el.clientWidth - 48);
    return () => ro.disconnect();
  }, []);

  const scale = size ? Math.min((avail / size.vw) * zoom, 4) : 1;
  const dispW = size ? size.vw * scale : 0;
  const dispH = size ? size.vh * scale : 0;

  // Render the page to an image used as the canvas background (one layer, so it
  // always composites under the annotation overlays).
  const pageKey = page && size ? `${page.sourceId}:${page.index}:${page.rotation}:${Math.round(dispW / 24)}` : "";
  useEffect(() => {
    if (!source || !page || !dispW) return;
    let ok = true;
    setPageUrl(null);
    renderPageDataUrl(source, page.index, page.rotation, dispW).then((r) => ok && setPageUrl(r.url)).catch(() => {});
    return () => { ok = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageKey]);

  // Reset selection when the page changes.
  useEffect(() => { setSelected(null); setEditingId(null); }, [current]);

  const update = useCallback((next: Anno[]) => page && commitAnnos(page.key, next), [page, commitAnnos]);
  const addAnno = useCallback((a: Anno) => update([...list, a]), [list, update]);
  const patchAnno = useCallback((id: string, patch: Partial<Anno>) => update(list.map((x) => (x.id === id ? { ...x, ...patch } as Anno : x))), [list, update]);
  const removeAnno = useCallback((id: string) => { update(list.filter((x) => x.id !== id)); setSelected((s) => (s === id ? null : s)); }, [list, update]);

  // view <-> screen
  const toView = (clientX: number, clientY: number) => {
    const r = overlayRef.current!.getBoundingClientRect();
    return { x: (clientX - r.left) / scale, y: (clientY - r.top) / scale };
  };
  const overlayRef = useRef<HTMLDivElement>(null);

  // ---------- creation & editing ----------
  // A gesture (create/move/resize/draw) updates `live` locally for a smooth,
  // history-free preview, and commits ONE history entry on pointer-up.
  type BoxLike = { x: number; y: number; w: number; h: number };
  const draftRef = useRef<{ kind: "create" | "move" | "resize"; isNew: boolean; start: { x: number; y: number }; orig: Anno; handle?: string } | null>(null);
  const [live, setLive] = useState<Anno | null>(null);
  const liveRef = useRef<Anno | null>(null);
  const setLiveBoth = (a: Anno | null) => { liveRef.current = a; setLive(a); };

  const beginCreate = (e: React.PointerEvent) => {
    if (!size) return;
    const p = toView(e.clientX, e.clientY);
    const clamp = (v: number, hi: number) => Math.max(0, Math.min(hi, v));
    const x = clamp(p.x, size.vw), y = clamp(p.y, size.vh);
    const id = newAnnoId();

    if (tool === "text" || tool === "note") {
      const w = tool === "note" ? 160 : 180, h = tool === "note" ? 80 : textSize * 1.6;
      const a: TextAnno = { id, type: tool, x: Math.min(x, size.vw - w), y: Math.min(y, size.vh - h), w, h, text: "", size: textSize, color: tool === "note" ? "#333333" : color, align: "left", bold: false, italic: false };
      addAnno(a); setTool("select"); setSelected(id); setEditingId(id);
      return;
    }
    let a: Anno;
    if (tool === "draw") a = { id, type: "draw", points: [{ x, y }], color, width: strokeWidth };
    else if (tool === "line" || tool === "arrow") a = { id, type: "line", x1: x, y1: y, x2: x, y2: y, color, width: strokeWidth, arrow: tool === "arrow" };
    else if (tool === "rect" || tool === "ellipse") a = { id, type: tool, x, y, w: 0, h: 0, stroke: color, fill: fillOn ? color : null, width: strokeWidth };
    else if (tool === "highlight") a = { id, type: "highlight", x, y, w: 0, h: 0, color: "#ffe14a" };
    else a = { id, type: "redact", x, y, w: 0, h: 0 };
    setLiveBoth(a);
    draftRef.current = { kind: "create", isNew: true, start: p, orig: a };
    overlayRef.current!.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = draftRef.current;
    if (!d || !size) return;
    const p = toView(e.clientX, e.clientY);
    if (d.kind === "create") {
      const cur = liveRef.current!;
      if (cur.type === "draw") {
        const last = cur.points[cur.points.length - 1];
        if (Math.hypot(p.x - last.x, p.y - last.y) > 1.2) setLiveBoth({ ...cur, points: [...cur.points, { x: p.x, y: p.y }] });
      } else if (cur.type === "line") {
        setLiveBoth({ ...cur, x2: p.x, y2: p.y });
      } else {
        const x = Math.min(d.start.x, p.x), y = Math.min(d.start.y, p.y);
        setLiveBoth({ ...cur, x, y, w: Math.abs(p.x - d.start.x), h: Math.abs(p.y - d.start.y) } as Anno);
      }
    } else if (d.kind === "move") {
      setLiveBoth(movedAnno(d.orig, p.x - d.start.x, p.y - d.start.y));
    } else if (d.kind === "resize") {
      setLiveBoth(resizedAnno(d.orig, d.handle!, p.x - d.start.x, p.y - d.start.y));
    }
  };

  const endPointer = () => {
    const d = draftRef.current;
    draftRef.current = null;
    const cur = liveRef.current;
    setLiveBoth(null);
    if (!d || !cur) return;
    // Discard an accidental zero-size shape or empty drawing.
    if (d.isNew) {
      const b = annoBox(cur);
      if (cur.type === "draw" ? cur.points.length < 2 : cur.type !== "line" && b.w < 4 && b.h < 4) {
        if (tool !== "draw" && tool !== "highlight") setTool("select");
        return;
      }
      update([...list, cur]); // one history entry for the whole creation
      if (tool !== "draw" && tool !== "highlight") { setTool("select"); setSelected(cur.id); }
    } else {
      update(list.map((x) => (x.id === cur.id ? cur : x))); // one entry for the move/resize
    }
  };

  const movedAnno = (orig: Anno, dx: number, dy: number): Anno => {
    if (orig.type === "draw") return { ...orig, points: orig.points.map((pt) => ({ x: pt.x + dx, y: pt.y + dy })) };
    if (orig.type === "line") return { ...orig, x1: orig.x1 + dx, y1: orig.y1 + dy, x2: orig.x2 + dx, y2: orig.y2 + dy };
    const b = orig as Anno & BoxLike;
    return { ...b, x: b.x + dx, y: b.y + dy } as Anno;
  };
  const resizedAnno = (orig: Anno, handle: string, dx: number, dy: number): Anno => {
    if (orig.type === "draw" || orig.type === "line") return orig;
    const b = orig as Anno & BoxLike;
    let { x, y, w, h } = b;
    if (handle.includes("e")) w = Math.max(6, w + dx);
    if (handle.includes("s")) h = Math.max(6, h + dy);
    if (handle.includes("w")) { x = x + dx; w = Math.max(6, b.w - dx); }
    if (handle.includes("n")) { y = y + dy; h = Math.max(6, b.h - dy); }
    return { ...b, x, y, w, h } as Anno;
  };

  // What the overlay actually renders: the committed list, with the live
  // in-progress annotation swapped in (or appended for a brand-new one).
  const displayList = live
    ? (list.some((a) => a.id === live.id) ? list.map((a) => (a.id === live.id ? live : a)) : [...list, live])
    : list;

  // ---------- keyboard ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest("input, textarea, [contenteditable]")) return;
      if ((e.key === "Delete" || e.key === "Backspace") && selected) { e.preventDefault(); removeAnno(selected); }
      if (e.key === "Escape") { setSelected(null); setEditingId(null); setTool("select"); }
      const map: Record<string, Tool> = { v: "select", t: "text", d: "draw", h: "highlight", r: "rect", o: "ellipse", l: "line", a: "arrow" };
      if (!e.ctrlKey && !e.metaKey && map[e.key]) setTool(map[e.key]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, removeAnno]);

  // ---------- image / signature placement ----------
  const placeImage = async (res: { bytes: Uint8Array; type: "png" | "jpg"; width: number; height: number }) => {
    if (!size) return;
    const id = props.addImage(res.bytes, res.type);
    const maxW = size.vw * 0.4;
    const w = Math.min(maxW, res.width * 0.75);
    const h = (w * res.height) / res.width;
    const a: ImageAnno = { id: newAnnoId(), type: "image", x: (size.vw - w) / 2, y: (size.vh - h) / 2, w, h, imageId: id };
    addAnno(a); setTool("select"); setSelected(a.id);
  };
  const pickImage = () => {
    const input = document.createElement("input");
    input.type = "file"; input.accept = "image/*";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const img = await prepareImage(new Uint8Array(await file.arrayBuffer()), file.name);
        await placeImage(img);
      } catch (e) { props.toast((e as Error).message, "error"); }
    };
    input.click();
  };
  useEffect(() => {
    if (tool === "image") { pickImage(); setTool("select"); }
    if (tool === "signature") { setSignOpen(true); setTool("select"); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool]);

  const pageFields = useMemo(
    () => (source && props.formSourceId === page?.sourceId && normalizeRotation(source.baseRotations[page.index] + page.rotation) === 0
      ? props.formFields.filter((f) => f.page === page.index) : []),
    [source, props.formFields, props.formSourceId, page],
  );

  if (!page || !source) return <div className="annotate empty">Open a PDF to start editing.</div>;

  const creating = tool !== "select";

  return (
    <div className="annotate">
      <div className="anno-toolbar" role="toolbar" aria-label="Editing tools">
        <div className="tool-palette">
          {TOOLS.map((t) => (
            <button key={t.id} className={`palette-btn ${tool === t.id ? "on" : ""}`} onClick={() => setTool(t.id)} title={`${t.label}${"vtdhrolla".includes(t.id[0]) ? ` (${t.id[0].toUpperCase()})` : ""}`} aria-pressed={tool === t.id}>
              <Icon name={t.icon} size={18} />
            </button>
          ))}
        </div>
        <div className="anno-options">
          {(tool === "text" || tool === "note" || selectedIsText(list, selected)) && (
            <TextOptions size={textSize} setSize={setTextSize} color={color} setColor={setColor} list={list} selected={selected} patchAnno={patchAnno} />
          )}
          {needsStroke(tool, list, selected) && (
            <>
              <ColorRow label="Colour" value={color} onChange={(c) => { setColor(c); if (selected) patchAnno(selected, selStrokeKey(list, selected, c)); }} />
              <label className="opt-slider">Thickness
                <input type="range" min={1} max={12} step={0.5} value={strokeWidth} onChange={(e) => { const w = Number(e.target.value); setStrokeWidth(w); if (selected) patchAnno(selected, { width: w } as Partial<Anno>); }} />
              </label>
              {(tool === "rect" || tool === "ellipse") && (
                <label className="opt-check"><input type="checkbox" checked={fillOn} onChange={(e) => setFillOn(e.target.checked)} /> Fill</label>
              )}
            </>
          )}
          {tool === "redact" && <span className="opt-note"><Icon name="info" size={14} /> Redaction permanently removes what's underneath on save.</span>}
          {tool === "highlight" && <span className="opt-note">Drag across what you want to highlight.</span>}
        </div>
        <span className="spacer" />
        <div className="anno-zoom">
          <button className="icon-only" onClick={() => setZoom((z) => Math.max(0.5, z - 0.2))} title="Zoom out"><Icon name="zoom-out" size={16} /></button>
          <button className="link" onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button>
          <button className="icon-only" onClick={() => setZoom((z) => Math.min(4, z + 0.2))} title="Zoom in"><Icon name="zoom-in" size={16} /></button>
        </div>
      </div>

      <div className="anno-body">
        <div className="anno-strip" aria-label="Pages">
          {pages.map((p, i) => (
            <button key={p.key} className={`anno-thumb ${i === current ? "active" : ""}`} onClick={() => props.onCurrent(i)}>
              <PageCanvas source={sources.get(p.sourceId)!} index={p.index} rotation={p.rotation} width={96} preload={250} />
              <span>{i + 1}{(annos[p.key]?.length ?? 0) > 0 && <i className="anno-badge">{annos[p.key].length}</i>}</span>
            </button>
          ))}
        </div>

        <div className="anno-stage" ref={scrollRef}>
          {size && (
            <div className="anno-page" style={{ width: dispW, height: dispH, backgroundImage: pageUrl ? `url(${pageUrl})` : undefined, backgroundSize: "100% 100%" }}>

              {/* vector annotations */}
              <svg className="vec-layer" width={dispW} height={dispH} viewBox={`0 0 ${size.vw} ${size.vh}`}>
                <defs>
                  <marker id="arrowhead" markerWidth="6" markerHeight="6" refX="4.5" refY="3" orient="auto">
                    <path d="M0,0 L6,3 L0,6 Z" />
                  </marker>
                </defs>
                {displayList.map((a) => <VecShape key={a.id} a={a} selected={a.id === selected} />)}
              </svg>

              {/* html annotations (text / images) + selection chrome */}
              <div
                className="html-layer"
                ref={overlayRef}
                style={{ pointerEvents: creating ? "auto" : "auto", cursor: creating ? "crosshair" : "default" }}
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  if (creating) beginCreate(e);
                  else if (e.target === e.currentTarget) { setSelected(null); setEditingId(null); }
                }}
                onPointerMove={onPointerMove}
                onPointerUp={endPointer}
              >
                {/* form fields */}
                {pageFields.map((fld, i) => (
                  <FormControl key={`${fld.name}-${i}`} field={fld} value={props.formValues[fld.name] ?? ""} scale={scale} onChange={(v) => props.setFormValue(fld.name, v)} />
                ))}

                {displayList.map((a) => (
                  <HtmlAnno
                    key={a.id}
                    a={a}
                    scale={scale}
                    images={images}
                    selected={a.id === selected}
                    editing={a.id === editingId}
                    tool={tool}
                    onStartMove={(e) => {
                      if (creating) return;
                      setSelected(a.id);
                      const orig = list.find((x) => x.id === a.id) ?? a;
                      draftRef.current = { kind: "move", isNew: false, start: toView(e.clientX, e.clientY), orig };
                      setLiveBoth(orig);
                      overlayRef.current!.setPointerCapture(e.pointerId);
                    }}
                    onStartResize={(e, handle) => {
                      const orig = list.find((x) => x.id === a.id) ?? a;
                      draftRef.current = { kind: "resize", isNew: false, start: toView(e.clientX, e.clientY), orig, handle };
                      setLiveBoth(orig);
                      overlayRef.current!.setPointerCapture(e.pointerId);
                    }}
                    onEdit={() => setEditingId(a.id)}
                    onText={(text) => patchAnno(a.id, { text } as Partial<TextAnno>)}
                    onEndEdit={() => { setEditingId(null); if ((a.type === "text" || a.type === "note") && !(a as TextAnno).text.trim()) removeAnno(a.id); }}
                  />
                ))}
              </div>
            </div>
          )}
        </div>

        {selected && selectedAnno(list, selected) && (
          <div className="anno-selbar">
            <span>{labelFor(selectedAnno(list, selected)!)}</span>
            <button className="icon-only" onClick={() => removeAnno(selected)} title="Delete (Del)"><Icon name="trash" size={16} /></button>
          </div>
        )}
      </div>

      {signOpen && <SignaturePad onCancel={() => setSignOpen(false)} onDone={(s) => { setSignOpen(false); placeImage(s); }} />}
    </div>
  );
}

// ---------- helpers & subcomponents ----------

function selectedAnno(list: Anno[], id: string | null) { return id ? list.find((a) => a.id === id) : undefined; }
function selectedIsText(list: Anno[], id: string | null) { const a = selectedAnno(list, id); return a?.type === "text" || a?.type === "note"; }
function needsStroke(tool: Tool, list: Anno[], id: string | null) {
  if (["draw", "line", "arrow", "rect", "ellipse"].includes(tool)) return true;
  const a = selectedAnno(list, id);
  return !!a && ["draw", "line", "rect", "ellipse"].includes(a.type);
}
function selStrokeKey(list: Anno[], id: string, c: string): Partial<Anno> {
  const a = selectedAnno(list, id);
  if (!a) return {};
  if (a.type === "rect" || a.type === "ellipse") return { stroke: c } as Partial<ShapeAnno>;
  if (a.type === "draw" || a.type === "line") return { color: c } as Partial<Anno>;
  return {};
}
function labelFor(a: Anno) {
  return { text: "Text", note: "Note", draw: "Drawing", line: "Line", rect: "Rectangle", ellipse: "Ellipse", highlight: "Highlight", image: "Image", redact: "Redaction" }[a.type];
}

function ColorRow({ label, value, onChange }: { label: string; value: string; onChange: (c: string) => void }) {
  return (
    <div className="opt-colors">{label}
      {COLORS.map((c) => <button key={c} className={`swatch ${value.toLowerCase() === c ? "on" : ""}`} style={{ background: c, boxShadow: c === "#ffffff" ? "inset 0 0 0 1px var(--line-2)" : undefined }} onClick={() => onChange(c)} aria-label={c} />)}
    </div>
  );
}

function TextOptions({ size, setSize, color, setColor, list, selected, patchAnno }: { size: number; setSize: (n: number) => void; color: string; setColor: (c: string) => void; list: Anno[]; selected: string | null; patchAnno: (id: string, p: Partial<Anno>) => void }) {
  const a = selectedAnno(list, selected) as TextAnno | undefined;
  const isText = a?.type === "text" || a?.type === "note";
  return (
    <>
      <label className="opt-slider">Size
        <input type="range" min={8} max={48} value={isText ? a!.size : size} onChange={(e) => { const s = Number(e.target.value); setSize(s); if (isText) patchAnno(a!.id, { size: s } as Partial<TextAnno>); }} />
      </label>
      {(!a || a.type === "text") && <ColorRow label="Colour" value={isText ? a!.color : color} onChange={(c) => { setColor(c); if (isText && a!.type === "text") patchAnno(a!.id, { color: c } as Partial<TextAnno>); }} />}
      <div className="opt-group">
        <button className={`opt-toggle ${isText && a!.bold ? "on" : ""}`} onClick={() => isText && patchAnno(a!.id, { bold: !a!.bold } as Partial<TextAnno>)} title="Bold"><b>B</b></button>
        <button className={`opt-toggle ${isText && a!.italic ? "on" : ""}`} onClick={() => isText && patchAnno(a!.id, { italic: !a!.italic } as Partial<TextAnno>)} title="Italic"><i>I</i></button>
        {isText && a!.type === "text" && (["left", "center", "right"] as const).map((al) => (
          <button key={al} className={`opt-toggle ${a!.align === al ? "on" : ""}`} onClick={() => patchAnno(a!.id, { align: al } as Partial<TextAnno>)} title={al}><Icon name={`align-${al}`} size={15} /></button>
        ))}
      </div>
    </>
  );
}

function VecShape({ a, selected }: { a: Anno; selected: boolean }) {
  const sel = selected ? { filter: "drop-shadow(0 0 1px #2a5bd7)" } : undefined;
  switch (a.type) {
    case "rect": return <rect x={a.x} y={a.y} width={a.w} height={a.h} fill={a.fill ?? "none"} stroke={a.stroke} strokeWidth={a.width} style={sel} />;
    case "ellipse": return <ellipse cx={a.x + a.w / 2} cy={a.y + a.h / 2} rx={a.w / 2} ry={a.h / 2} fill={a.fill ?? "none"} stroke={a.stroke} strokeWidth={a.width} style={sel} />;
    case "highlight": return <rect x={a.x} y={a.y} width={a.w} height={a.h} fill={a.color ?? "#ffe14a"} opacity={0.4} style={{ mixBlendMode: "multiply", ...sel }} />;
    case "redact": return <rect x={a.x} y={a.y} width={a.w} height={a.h} fill="#000" style={sel} />;
    case "line": return <line x1={a.x1} y1={a.y1} x2={a.x2} y2={a.y2} stroke={a.color} strokeWidth={a.width} strokeLinecap="round" markerEnd={a.arrow ? "url(#arrowhead)" : undefined} style={sel} />;
    case "draw": return <polyline points={a.points.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke={a.color} strokeWidth={a.width} strokeLinecap="round" strokeLinejoin="round" style={sel} />;
    default: return null;
  }
}

interface HtmlProps {
  a: Anno; scale: number; images: ImageStore; selected: boolean; editing: boolean; tool: Tool;
  onStartMove: (e: React.PointerEvent) => void; onStartResize: (e: React.PointerEvent, handle: string) => void;
  onEdit: () => void; onText: (t: string) => void; onEndEdit: () => void;
}
function HtmlAnno({ a, scale, images, selected, editing, tool, onStartMove, onStartResize, onEdit, onText, onEndEdit }: HtmlProps) {
  const isHtml = a.type === "text" || a.type === "note" || a.type === "image";
  const box = annoBox(a);
  const style: React.CSSProperties = { left: box.x * scale, top: box.y * scale, width: box.w * scale, height: box.h * scale };
  const selectable = tool === "select";

  // Only text/image get a DOM body; shapes are drawn in SVG but still need a
  // hit/selection box when selected.
  if (!isHtml) {
    if (!selected || !selectable) return null;
    return <SelectionBox style={style} onStartMove={onStartMove} onStartResize={a.type === "draw" || a.type === "line" ? undefined : onStartResize} />;
  }

  const common = { className: `html-anno ${a.type} ${selected ? "selected" : ""}`, style, onPointerDown: (e: React.PointerEvent) => { if (!selectable) return; e.stopPropagation(); onStartMove(e); } };

  if (a.type === "image") {
    const img = images[a.imageId];
    const url = img ? URL.createObjectURL(new Blob([img.bytes as BlobPart], { type: img.type === "png" ? "image/png" : "image/jpeg" })) : "";
    return (
      <div {...common}>
        <img src={url} alt="" draggable={false} style={{ width: "100%", height: "100%", objectFit: "fill" }} />
        {selected && selectable && <Handles onStartResize={onStartResize} />}
      </div>
    );
  }

  const t = a as TextAnno;
  const fontStyle: React.CSSProperties = {
    fontSize: t.size * scale, fontWeight: t.bold ? 700 : 400, fontStyle: t.italic ? "italic" : "normal",
    color: t.type === "note" ? "#333" : t.color, textAlign: t.align, lineHeight: 1.2,
    fontFamily: "Instrument Sans Variable, Helvetica, Arial, sans-serif",
  };
  return (
    <div {...common} onDoubleClick={(e) => { e.stopPropagation(); onEdit(); }}>
      {editing ? (
        <textarea
          autoFocus className="anno-text-edit" style={fontStyle} value={t.text}
          onChange={(e) => onText(e.target.value)}
          onBlur={onEndEdit}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => { if (e.key === "Escape") (e.target as HTMLTextAreaElement).blur(); e.stopPropagation(); }}
        />
      ) : (
        <div className="anno-text-view" style={fontStyle} onDoubleClick={onEdit}>{t.text || <span className="placeholder">Double-click to edit</span>}</div>
      )}
      {selected && selectable && !editing && <Handles onStartResize={onStartResize} />}
    </div>
  );
}

function SelectionBox({ style, onStartMove, onStartResize }: { style: React.CSSProperties; onStartMove: (e: React.PointerEvent) => void; onStartResize?: (e: React.PointerEvent, h: string) => void }) {
  return (
    <div className="html-anno selection-only selected" style={style} onPointerDown={(e) => { e.stopPropagation(); onStartMove(e); }}>
      {onStartResize && <Handles onStartResize={onStartResize} />}
    </div>
  );
}

function Handles({ onStartResize }: { onStartResize: (e: React.PointerEvent, h: string) => void }) {
  return (
    <>
      {["nw", "ne", "sw", "se", "n", "s", "e", "w"].map((h) => (
        <span key={h} className={`handle h-${h}`} onPointerDown={(e) => { e.stopPropagation(); onStartResize(e, h); }} />
      ))}
    </>
  );
}

function FormControl({ field, value, scale, onChange }: { field: FieldWidget; value: string; scale: number; onChange: (v: string) => void }) {
  const style: React.CSSProperties = { left: field.rect.x * scale, top: field.rect.y * scale, width: field.rect.w * scale, height: field.rect.h * scale };
  if (field.kind === "checkbox") {
    return <input type="checkbox" className="form-field cb" style={style} checked={!!value} onChange={(e) => onChange(e.target.checked ? "on" : "")} aria-label={field.name} />;
  }
  if (field.kind === "dropdown" || field.kind === "list") {
    return (
      <select className="form-field" style={style} value={value} onChange={(e) => onChange(e.target.value)} aria-label={field.name}>
        <option value=""></option>
        {field.options?.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  }
  if (field.kind === "radio") {
    return <input type="radio" className="form-field cb" style={style} checked={value === field.exportValue} onChange={() => onChange(field.exportValue ?? "")} aria-label={`${field.name} ${field.exportValue}`} />;
  }
  const fontPx = Math.min(field.rect.h * scale * 0.6, 15 * scale);
  if (field.multiline) {
    return <textarea className="form-field" style={{ ...style, fontSize: fontPx }} value={value} onChange={(e) => onChange(e.target.value)} aria-label={field.name} />;
  }
  return <input type="text" className="form-field" style={{ ...style, fontSize: fontPx }} value={value} onChange={(e) => onChange(e.target.value)} aria-label={field.name} />;
}

