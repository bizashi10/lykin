// The workspace for one tool: add files, set options, run, save the results.
import { useEffect, useMemo, useRef, useState } from "react";
import type { ToolDef } from "../tools/registry";
import { CATEGORIES } from "../tools/registry";
import {
  buildPdf, pagesOf, loadSource, parseRanges, chunkPages, baseName, describeGroup, normalizeRotation,
  type Source, type PageRef,
} from "../lib/pdfops";
import * as T from "../lib/tools";
import * as native from "../lib/native";
import * as platform from "../lib/platform";
import { prepareImage, previewUrl, pdfToImages, extractImages, isImageName } from "../lib/images";
import { closeSource } from "../lib/render";
import { PageCanvas } from "./PageCanvas";
import { Icon } from "./Icon";
import { Field, Segmented, Slider, ColorPicker, PositionPicker, Toggle } from "./ui";

export interface LoadedPdf {
  source: Source;
  file: platform.PickedFile;
  password?: string;
}

interface Item {
  id: string;
  name: string;
  path?: string;
  size: number;
  source?: Source;
  image?: Awaited<ReturnType<typeof prepareImage>> & { url: string };
  /** Raw bytes for files that failed to load (Repair only). */
  raw?: Uint8Array;
  wasProtected?: boolean;
  /** The password the file was opened with, so results stay protected. */
  password?: string;
  /** How the file was locked when it was added. */
  lock?: "password" | "restrictions" | "none";
}

interface Output {
  name: string;
  bytes: Uint8Array;
  kind: "pdf" | "image" | "error";
  note?: string;
  good?: boolean;
  from?: Item;
  saved?: boolean;
}

interface Props {
  tool: ToolDef;
  initialFiles: platform.PickedFile[];
  loadPdfs: (files: platform.PickedFile[], opts?: { lenient?: boolean }) => Promise<(LoadedPdf | { file: platform.PickedFile; failed: true })[]>;
  onOpenInEditor: (out: { name: string; bytes: Uint8Array }) => void;
  toast: (text: string, tone?: "info" | "error" | "success", action?: { label: string; run: () => void }) => void;
  onBack: () => void;
  engineReady: boolean;
  /** Tells the app whether there are results that haven't been saved yet. */
  onUnsavedChange?: (unsaved: boolean) => void;
}

let uid = 0;
const nextId = () => `i${++uid}`;

const SUFFIX: Record<string, string> = {
  compress: "compressed", repair: "repaired", grayscale: "grayscale", flatten: "flattened", rotate: "rotated",
  blank: "with-blanks", reverse: "reversed", pdfa: "pdfa", "page-numbers": "numbered", watermark: "watermarked",
  crop: "cropped", protect: "protected", unlock: "unlocked", metadata: "edited", remove: "trimmed", extract: "extract",
};

export function ToolRunner({ tool, initialFiles, loadPdfs, onOpenInEditor, toast, onBack, engineReady, onUnsavedChange }: Props) {
  const [items, setItems] = useState<Item[]>([]);
  const [outputs, setOutputs] = useState<Output[] | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [dragOver, setDragOver] = useState(false);
  const [loading, setLoading] = useState(false);
  const opts = useToolOptions(tool.id);
  const category = CATEGORIES.find((c) => c.id === tool.category)!;
  const preview = useLivePreview(tool.id, items[0]?.source, opts.values);

  // Results go stale the moment an option changes.
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    if (!running) setOutputs(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.values]);

  const unsaved = !!outputs?.some((o) => o.kind !== "error" && !o.saved);
  useEffect(() => {
    onUnsavedChange?.(unsaved);
  }, [unsaved, onUnsavedChange]);

  // Free the memory used by loaded files when leaving the tool.
  const itemsRef = useRef(items);
  itemsRef.current = items;
  useEffect(() => () => itemsRef.current.forEach((i) => i.source && closeSource(i.source.id)), []);
  const accept = tool.input === "images" ? isImageName : (n: string) => /\.pdf$/i.test(n);

  // ---------- adding files ----------
  const addFiles = async (files: platform.PickedFile[]) => {
    const fitting = files.filter((f) => accept(f.name));
    if (fitting.length < files.length) {
      toast(tool.input === "images" ? "Only images can be added here" : "Only PDF files can be added here", "error");
    }
    if (!fitting.length) return;
    const limited = tool.multiple ? fitting : fitting.slice(0, 1);
    setOutputs(null);
    setError("");
    setLoading(true);
    try {
      if (tool.input === "images") {
        const ready: Item[] = [];
        for (const f of limited) {
          try {
            const img = await prepareImage(f.bytes, f.name);
            ready.push({ id: nextId(), name: f.name, size: f.bytes.length, image: { ...img, url: previewUrl(img.bytes) } });
          } catch (e) {
            toast((e as Error).message, "error");
          }
        }
        setItems((cur) => [...cur, ...ready]);
      } else {
        const loaded = await loadPdfs(limited, { lenient: tool.id === "repair" });
        const ready: Item[] = loaded.map((l) =>
          "failed" in l
            ? { id: nextId(), name: l.file.name, path: l.file.path, size: l.file.bytes.length, raw: l.file.bytes }
            : { id: nextId(), name: l.file.name, path: l.file.path, size: l.file.bytes.length, source: l.source, wasProtected: l.password !== undefined || l.source.restrictionsRemoved, password: l.password, lock: l.password !== undefined ? "password" : l.source.restrictionsRemoved ? "restrictions" : "none" },
        );
        setItems((cur) => (tool.multiple ? [...cur, ...ready] : ready.slice(0, 1)));
      }
    } finally {
      setLoading(false);
    }
  };

  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (initialFiles.length) addFiles(initialFiles);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pick = async () => {
    if (tool.input === "images") {
      if (platform.isDesktop) {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const chosen = await open({ multiple: true, filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "webp", "gif", "bmp", "avif", "tif", "tiff"] }] });
        if (!chosen) return;
        const paths = Array.isArray(chosen) ? chosen : [chosen];
        addFiles(await Promise.all(paths.map(platform.readPath)));
      } else {
        const input = document.createElement("input");
        input.type = "file";
        input.multiple = true;
        input.accept = "image/*";
        input.onchange = async () => addFiles(await Promise.all(Array.from(input.files ?? []).map(platform.fromBrowserFile)));
        input.click();
      }
    } else {
      addFiles(await platform.pickPdfs(tool.multiple));
    }
  };

  const remove = (id: string) => {
    const gone = items.find((i) => i.id === id);
    if (gone?.source) closeSource(gone.source.id);
    setItems((cur) => cur.filter((i) => i.id !== id));
    setOutputs(null);
  };
  const move = (id: string, dir: -1 | 1) =>
    setItems((cur) => {
      const i = cur.findIndex((x) => x.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= cur.length) return cur;
      const next = [...cur];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  const dragId = useRef<string | null>(null);

  // ---------- running ----------
  const needsEngine = tool.engine && !engineReady;
  const single = items[0];
  const canRun = items.length > 0 && !running && !needsEngine && (tool.mode !== "combine" || tool.id !== "merge" || items.length >= 2);

  const run = async () => {
    setRunning(true);
    setError("");
    setOutputs(null);
    await new Promise((r) => setTimeout(r, 30));
    try {
      let res = await execute(tool.id, items, opts.values, setProgress);
      // Keep password protection on results made from protected files.
      if (tool.id !== "unlock" && tool.id !== "protect") {
        res = await Promise.all(
          res.map(async (o) =>
            o.kind === "pdf" && o.from?.password
              ? { ...o, bytes: await T.reprotect(o.bytes, o.from.password), note: o.note ? `${o.note} · still protected` : "Still protected" }
              : o,
          ),
        );
      }
      const ok = res.filter((o) => o.kind !== "error");
      if (res.length && !ok.length) throw new Error(res[0].note ?? "Nothing was produced");
      setOutputs(res);
      if (res.length === 0) setError("Nothing was produced. Check the options and try again.");
    } catch (e) {
      console.error(e);
      setError(friendly(e));
    } finally {
      setRunning(false);
      setProgress("");
    }
  };

  /** Opening a result is fine; only ask if *other* results would be lost. */
  const openResult = async (o: Output) => {
    const others = outputs?.filter((x) => x !== o && x.kind !== "error" && !x.saved).length ?? 0;
    if (others && !(await platform.confirm(`${others} other result${others === 1 ? " hasn't" : "s haven't"} been saved. Open this one anyway?`))) return;
    onUnsavedChange?.(false);
    onOpenInEditor(o);
  };
  const markSaved = (list: Output[]) => setOutputs((cur) => cur?.map((o) => (list.some((l) => l.name === o.name && l.bytes === o.bytes) ? { ...o, saved: true } : o)) ?? null);
  const saveOne = async (o: Output) => {
    try {
      const target = await platform.saveBytes(o.bytes, o.name);
      if (target) markSaved([o]);
      if (target) toast(`Saved ${platform.fileNameOf(target)}`, "success", platform.isDesktop ? { label: "Show", run: () => platform.showInFolder(target) } : undefined);
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };
  const saveAll = async () => {
    const good = outputs?.filter((o) => o.kind !== "error") ?? [];
    if (!good.length) return;
    const folder = await platform.pickFolder();
    if (!folder) return;
    try {
      const written = await platform.saveManyToFolder(folder, good);
      markSaved(good);
      toast(`Saved ${written.length} files`, "success", platform.isDesktop && written[0] ? { label: "Show", run: () => platform.showInFolder(written[0]) } : undefined);
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  const totalIn = items.reduce((s, i) => s + i.size, 0);
  const goodCount = outputs?.filter((o) => o.kind !== "error").length ?? 0;
  const failedCount = (outputs?.length ?? 0) - goodCount;
  const runLabel = RUN_LABEL[tool.id] ?? tool.name;

  return (
    <div
      className={`tool-screen cat-${tool.category}`}
      onDragOver={(e) => {
        if (Array.from(e.dataTransfer.types).includes("Files")) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragOver(false);
      }}
      onDrop={async (e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        e.stopPropagation();
        setDragOver(false);
        addFiles(await Promise.all(Array.from(e.dataTransfer.files).map(platform.fromBrowserFile)));
      }}
    >
      <header className="tool-head">
        <button className="back" onClick={onBack} title="Back to all tools">
          <Icon name="back" />
        </button>
        <div className="tool-glyph"><Icon name={tool.icon} size={22} /></div>
        <div className="tool-title">
          <h1>{tool.name}</h1>
          <p>{tool.blurb}</p>
        </div>
        <span className="tool-cat">{category.name}</span>
      </header>

      <div className="tool-body">
        <section className="tool-files" aria-label="Files">
          {outputs && outputs.length > 0 && (
            <section className="results" aria-label="Results">
              <div className="results-head">
                <div className="done-mark"><Icon name="check" size={18} /></div>
                <div>
                  <h2>{goodCount === 1 ? "Your file is ready" : `${goodCount} files are ready`}</h2>
                  <p>{failedCount ? `${failedCount} couldn't be processed — see below.` : unsaved ? "Nothing is saved until you choose where." : "Saved."}</p>
                </div>
                <span className="spacer" />
                {goodCount > 1 && <button className="primary" onClick={saveAll}><Icon name="folder" size={16} /> Save all to a folder</button>}
                {goodCount === 1 && <button className="primary" onClick={() => saveOne(outputs.find((o) => o.kind !== "error")!)}><Icon name="save" size={16} /> Save</button>}
              </div>
              <ul className="result-list">
                {outputs.slice(0, 200).map((o, i) => (
                  <li key={i} className={`result-row ${o.kind === "error" ? "failed" : ""}`}>
                    <Icon name={o.kind === "pdf" ? "file" : o.kind === "error" ? "info" : "image"} size={18} />
                    <span className="result-name" title={o.name}>{o.name}</span>
                    {o.note && <span className={`pill ${o.kind === "error" ? "red" : o.good ? "green" : ""}`}>{o.note}</span>}
                    {o.kind !== "error" && <span className="result-size">{T.formatBytes(o.bytes.length)}</span>}
                    {o.saved && <span className="saved-tick" title="Saved"><Icon name="check" size={16} /></span>}
                    {o.kind === "pdf" && (
                      <button className="ghost" onClick={() => openResult(o)} title="Open in the page editor">Open</button>
                    )}
                    {goodCount > 1 && o.kind !== "error" && <button className="ghost" onClick={() => saveOne(o)}>Save</button>}
                  </li>
                ))}
                {outputs.length > 200 && <li className="result-row muted">…and {outputs.length - 200} more</li>}
              </ul>
            </section>
          )}
          {items.length === 0 ? (
            <button className={`dropzone ${dragOver ? "over" : ""}`} onClick={pick} disabled={loading}>
              <Icon name={tool.input === "images" ? "image-plus" : "upload"} size={34} />
              <strong>{loading ? "Reading files…" : tool.input === "images" ? "Choose images" : tool.multiple ? "Choose PDF files" : "Choose a PDF"}</strong>
              <span>or drop {tool.input === "images" ? "images" : tool.multiple ? "PDFs" : "a PDF"} here</span>
            </button>
          ) : (
            <>
              <div className="files-bar">
                <span>
                  {items.length} {tool.input === "images" ? "image" : "file"}{items.length === 1 ? "" : "s"} · {T.formatBytes(totalIn)}
                </span>
                <span className="spacer" />
                {tool.mode === "combine" && items.length > 1 && (
                  <button className="ghost" onClick={() => setItems((c) => [...c].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })))}>
                    Sort A–Z
                  </button>
                )}
                {(tool.multiple || items.length === 0) && (
                  <button className="ghost" onClick={pick}><Icon name="plus" size={16} /> Add</button>
                )}
                {!tool.multiple && <button className="ghost" onClick={pick}>Replace</button>}
              </div>

              {isPagePicker(tool.id) && single?.source ? (
                <PagePicker source={single.source} selected={opts.values.pickedPages} onChange={(p) => opts.set({ pickedPages: p })} mode={tool.id === "remove" ? "remove" : "keep"} />
              ) : (
                <ul className={`file-list ${tool.input === "images" ? "as-grid" : ""}`}>
                  {items.map((it, idx) => (
                    <li
                      key={it.id}
                      className="file-row"
                      draggable={tool.mode === "combine"}
                      onDragStart={() => (dragId.current = it.id)}
                      onDragOver={(e) => {
                        if (dragId.current) e.preventDefault();
                      }}
                      onDrop={(e) => {
                        if (!dragId.current) return;
                        e.preventDefault();
                        e.stopPropagation();
                        const from = dragId.current;
                        dragId.current = null;
                        setItems((cur) => {
                          const a = cur.findIndex((x) => x.id === from);
                          const b = cur.findIndex((x) => x.id === it.id);
                          if (a < 0 || b < 0 || a === b) return cur;
                          const next = [...cur];
                          const [m] = next.splice(a, 1);
                          next.splice(b, 0, m);
                          return next;
                        });
                      }}
                    >
                      <div className="file-thumb">
                        {it.image ? (
                          <img src={it.image.url} alt="" />
                        ) : it.source ? (
                          <PageCanvas source={it.source} index={0} rotation={0} width={tool.input === "images" ? 120 : 52} preload={200} />
                        ) : (
                          <div className="thumb-broken"><Icon name="repair" /></div>
                        )}
                      </div>
                      <div className="file-meta">
                        <div className="file-name" title={it.name}>{tool.mode === "combine" && <span className="order">{idx + 1}</span>}{it.name}</div>
                        <div className="file-sub">
                          {it.source ? `${it.source.pageCount} page${it.source.pageCount === 1 ? "" : "s"} · ` : it.image ? `${it.image.width}×${it.image.height} · ` : "Damaged · "}
                          {T.formatBytes(it.size)}
                          {it.lock === "password" && <span className="pill gold"><Icon name="lock" size={11} /> password entered</span>}
                          {it.lock === "restrictions" && <span className="pill gold"><Icon name="lock" size={11} /> had restrictions</span>}
                          {tool.id === "unlock" && it.lock === "none" && <span className="pill">not locked</span>}
                        </div>
                      </div>
                      <div className="file-actions">
                        {tool.mode === "combine" && (
                          <>
                            <button className="icon-only" onClick={() => move(it.id, -1)} disabled={idx === 0} title="Move up"><Icon name="up" size={16} /></button>
                            <button className="icon-only" onClick={() => move(it.id, 1)} disabled={idx === items.length - 1} title="Move down"><Icon name="down" size={16} /></button>
                          </>
                        )}
                        <button className="icon-only" onClick={() => remove(it.id)} title="Remove from list"><Icon name="close" size={16} /></button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              {preview && (
                <div className="live-preview" aria-label="Preview of page 1">
                  <div className="lp-head">
                    <span className="lp-dot" /> Live preview · page 1{items.length > 1 ? ` of ${items[0].name}` : ""}
                  </div>
                  <div className="lp-stage">
                    <PageCanvas key={preview.id} source={preview} index={0} rotation={0} width={340} preload={100} />
                  </div>
                </div>
              )}
            </>
          )}
        </section>

        <aside className="tool-panel" aria-label="Options">
          <div className="panel-scroll">
            <Options tool={tool} opts={opts} items={items} />
            {needsEngine && (
              <div className="notice">
                <Icon name="info" size={16} />
                <span>{platform.isDesktop ? "The PDF engine wasn't found. Reinstall Opus to restore it." : "This tool runs in the installed Opus app."}</span>
              </div>
            )}
          </div>
          <div className="panel-foot">
            {error && <div className="form-error" role="alert">{error}</div>}
            <button className="primary run" disabled={!canRun} onClick={run}>
              {running ? <><span className="spinner small" /> {progress || "Working…"}</> : <>{runLabel}</>}
            </button>
            {tool.id === "merge" && items.length === 1 && <div className="field-hint center">Add at least one more PDF</div>}
          </div>
        </aside>
      </div>


      {dragOver && <div className="drop-hint"><div>Drop to add</div></div>}
    </div>
  );
}

const RUN_LABEL: Record<string, string> = {
  merge: "Merge PDFs", split: "Split PDF", remove: "Remove pages", extract: "Extract pages", rotate: "Rotate",
  blank: "Insert pages", reverse: "Reverse pages", compress: "Compress", repair: "Repair", grayscale: "Convert to grayscale",
  flatten: "Flatten forms", metadata: "Save properties", "pdf-to-image": "Convert to images", "image-to-pdf": "Create PDF",
  "extract-images": "Extract images", pdfa: "Convert to PDF/A", "page-numbers": "Add page numbers", watermark: "Add watermark",
  crop: "Crop pages", protect: "Protect", unlock: "Unlock",
};

const isPagePicker = (id: string) => id === "remove" || id === "extract";

// ---------- options ----------

interface Values {
  pickedPages: number[];
  splitMode: "ranges" | "every" | "each";
  ranges: string;
  every: number;
  extractSeparate: boolean;
  angle: number;
  rotateWhich: "all" | "portrait" | "landscape";
  blankWhere: "end" | "start" | "between";
  level: native.CompressLevel;
  imgFormat: "jpg" | "png";
  dpi: number;
  quality: number;
  pageSize: "fit" | "a4" | "letter";
  orientation: "auto" | "portrait" | "landscape";
  margin: number;
  pdfaPart: 1 | 2 | 3;
  numPos: T.Position;
  numFormat: string;
  numStart: number;
  numSize: number;
  numSkipFirst: boolean;
  numFont: "sans" | "serif" | "mono";
  color: string;
  wmKind: "text" | "image";
  wmText: string;
  wmImage?: { bytes: Uint8Array; type: "png" | "jpg"; url: string; name: string };
  wmSize: number;
  wmOpacity: number;
  wmAngle: number;
  wmLayout: "center" | "tile" | T.Position;
  wmBold: boolean;
  crop: { top: number; right: number; bottom: number; left: number };
  password: string;
  password2: string;
  info: T.DocInfo | null;
}

const DEFAULTS: Values = {
  pickedPages: [], splitMode: "ranges", ranges: "", every: 1, extractSeparate: false,
  angle: 90, rotateWhich: "all", blankWhere: "end", level: "recommended",
  imgFormat: "jpg", dpi: 150, quality: 0.9, pageSize: "fit", orientation: "auto", margin: 0, pdfaPart: 2,
  numPos: "bottom-center", numFormat: "{n}", numStart: 1, numSize: 11, numSkipFirst: false, numFont: "sans", color: "#1b1f27",
  wmKind: "text", wmText: "CONFIDENTIAL", wmSize: 54, wmOpacity: 0.25, wmAngle: 45, wmLayout: "center", wmBold: true,
  crop: { top: 10, right: 10, bottom: 10, left: 10 }, password: "", password2: "", info: null,
};

function useToolOptions(_toolId: string) {
  const [values, setValues] = useState<Values>(DEFAULTS);
  return { values, set: (patch: Partial<Values>) => setValues((v) => ({ ...v, ...patch })) };
}
type Opts = ReturnType<typeof useToolOptions>;

function Options({ tool, opts, items }: { tool: ToolDef; opts: Opts; items: Item[] }) {
  const v = opts.values;
  const set = opts.set;
  const pageCount = items[0]?.source?.pageCount ?? 0;

  // Prefill properties from the file.
  const infoFor = useRef<string | null>(null);
  useEffect(() => {
    if (tool.id !== "metadata" || !items[0]?.source || infoFor.current === items[0].id) return;
    infoFor.current = items[0].id;
    T.readInfo(items[0].source.bytes).then((info) => set({ info })).catch(() => set({ info: { title: "", author: "", subject: "", keywords: "" } }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool.id, items]);

  // Sensible split ranges once we know the page count.
  useEffect(() => {
    if (tool.id === "split" && pageCount && !v.ranges) {
      const half = Math.ceil(pageCount / 2);
      set({ ranges: pageCount > 1 ? `1-${half}, ${half + 1}-${pageCount}` : "1" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool.id, pageCount]);

  switch (tool.id) {
    case "merge":
      return <Explainer text="Files are combined top to bottom. Drag them, or use the arrows, to change the order." />;
    case "split":
      return (
        <>
          <Field label="Split by">
            <Segmented label="Split mode" value={v.splitMode} onChange={(splitMode) => set({ splitMode })} options={[
              { value: "ranges", label: "Ranges" }, { value: "every", label: "Every N pages" }, { value: "each", label: "Each page" },
            ]} />
          </Field>
          {v.splitMode === "ranges" && (
            <Field label="Page ranges" hint="One new file per range, e.g. 1-3, 4-6, 7-">
              <input value={v.ranges} onChange={(e) => set({ ranges: e.target.value })} aria-label="Page ranges" />
            </Field>
          )}
          {v.splitMode === "every" && (
            <Field label="Pages per file">
              <input type="number" min={1} value={v.every} onChange={(e) => set({ every: Math.max(1, Number(e.target.value) || 1) })} aria-label="Pages per file" />
            </Field>
          )}
          {pageCount > 0 && <Explainer text={splitSummary(v, pageCount)} />}
        </>
      );
    case "remove":
    case "extract":
      return (
        <>
          <Explainer text={tool.id === "remove" ? "Click the pages to remove. They're marked in red." : "Click the pages to keep. They're marked with a tick."} />
          {pageCount > 0 && (
            <div className="quick-select">
              <button className="ghost" onClick={() => set({ pickedPages: [] })}>None</button>
              <button className="ghost" onClick={() => set({ pickedPages: Array.from({ length: pageCount }, (_, i) => i).filter((i) => i % 2 === 0) })}>Odd</button>
              <button className="ghost" onClick={() => set({ pickedPages: Array.from({ length: pageCount }, (_, i) => i).filter((i) => i % 2 === 1) })}>Even</button>
            </div>
          )}
          <TypedPages pageCount={pageCount} selected={v.pickedPages} onChange={(pickedPages) => set({ pickedPages })} />
          {tool.id === "extract" && <Toggle checked={v.extractSeparate} onChange={(extractSeparate) => set({ extractSeparate })} label="Save each page as its own file" />}
          <div className="count-line">{v.pickedPages.length} of {pageCount} pages selected</div>
        </>
      );
    case "rotate":
      return (
        <>
          <Field label="Turn">
            <Segmented label="Angle" value={v.angle} onChange={(angle) => set({ angle })} options={[
              { value: 270, label: <><Icon name="rotate-left" size={15} /> Left</> }, { value: 90, label: <><Icon name="rotate-right" size={15} /> Right</> }, { value: 180, label: "180°" },
            ]} />
          </Field>
          <Field label="Which pages">
            <Segmented label="Which pages" value={v.rotateWhich} onChange={(rotateWhich) => set({ rotateWhich })} options={[
              { value: "all", label: "All" }, { value: "portrait", label: "Portrait" }, { value: "landscape", label: "Landscape" },
            ]} />
          </Field>
        </>
      );
    case "blank":
      return (
        <Field label="Where">
          <Segmented label="Where" value={v.blankWhere} onChange={(blankWhere) => set({ blankWhere })} options={[
            { value: "start", label: "At start" }, { value: "end", label: "At end" }, { value: "between", label: "Between pages" },
          ]} />
        </Field>
      );
    case "compress":
      return (
        <Field label="Compression">
          <div className="choice-cards">
            {([
              ["extreme", "Smallest file", "Lowest quality. Fine for reading on screen."],
              ["recommended", "Recommended", "Good quality, much smaller. Best for sharing."],
              ["light", "Print quality", "Keeps detail for printing, removes waste."],
            ] as const).map(([val, title, desc]) => (
              <button key={val} type="button" className={`choice ${v.level === val ? "on" : ""}`} onClick={() => set({ level: val })} aria-pressed={v.level === val}>
                <strong>{title}</strong>
                <span>{desc}</span>
              </button>
            ))}
          </div>
        </Field>
      );
    case "repair":
      return <Explainer text="Opus rebuilds the file's structure. Pages that are truly missing from the file can't be brought back." />;
    case "grayscale":
      return <Explainer text="Text, drawings and photos become shades of grey." />;
    case "flatten":
      return <Explainer text="Form fields become plain page content, so the answers can't be changed." />;
    case "metadata":
      return v.info ? (
        <>
          {(["title", "author", "subject", "keywords"] as const).map((k) => (
            <Field key={k} label={k[0].toUpperCase() + k.slice(1)} hint={k === "keywords" ? "Separate with commas" : undefined}>
              <input value={v.info![k]} onChange={(e) => set({ info: { ...v.info!, [k]: e.target.value } })} aria-label={k} />
            </Field>
          ))}
        </>
      ) : (
        <Explainer text="Add a PDF to see and change its properties." />
      );
    case "pdf-to-image":
      return (
        <>
          <Field label="Format">
            <Segmented label="Format" value={v.imgFormat} onChange={(imgFormat) => set({ imgFormat })} options={[
              { value: "jpg", label: "JPG", title: "Smaller files, best for photos" }, { value: "png", label: "PNG", title: "Sharp text, larger files" },
            ]} />
          </Field>
          <Field label="Resolution" hint={v.dpi >= 300 ? "Print quality — large files" : v.dpi <= 96 ? "Screen quality — small files" : "Good for most uses"}>
            <Slider label="Resolution" value={v.dpi} min={72} max={600} step={12} onChange={(dpi) => set({ dpi })} format={(d) => `${d} dpi`} />
          </Field>
          {v.imgFormat === "jpg" && (
            <Field label="JPG quality">
              <Slider label="Quality" value={Math.round(v.quality * 100)} min={50} max={100} onChange={(q) => set({ quality: q / 100 })} format={(q) => `${q}%`} />
            </Field>
          )}
        </>
      );
    case "image-to-pdf":
      return (
        <>
          <Field label="Page size">
            <Segmented label="Page size" value={v.pageSize} onChange={(pageSize) => set({ pageSize })} options={[
              { value: "fit", label: "Fit image" }, { value: "a4", label: "A4" }, { value: "letter", label: "Letter" },
            ]} />
          </Field>
          {v.pageSize !== "fit" && (
            <Field label="Orientation">
              <Segmented label="Orientation" value={v.orientation} onChange={(orientation) => set({ orientation })} options={[
                { value: "auto", label: "Auto" }, { value: "portrait", label: "Portrait" }, { value: "landscape", label: "Landscape" },
              ]} />
            </Field>
          )}
          <Field label="Margin">
            <Slider label="Margin" value={v.margin} min={0} max={40} onChange={(margin) => set({ margin })} format={(m) => (m ? `${m} mm` : "None")} />
          </Field>
          <Explainer text="Images become pages top to bottom. Drag to reorder. Phone photos are turned the right way up." />
        </>
      );
    case "extract-images":
      return <Explainer text="Every picture inside the PDF is saved as its own file — photos as JPG, graphics with transparency as PNG. Tiny decorative images are skipped." />;
    case "pdfa":
      return (
        <Field label="Standard" hint="PDF/A-2b suits almost every archive and court system.">
          <Segmented label="PDF/A part" value={v.pdfaPart} onChange={(pdfaPart) => set({ pdfaPart })} options={[
            { value: 1, label: "PDF/A-1b" }, { value: 2, label: "PDF/A-2b" }, { value: 3, label: "PDF/A-3b" },
          ]} />
        </Field>
      );
    case "page-numbers":
      return (
        <>
          <Field label="Position">
            <PositionPicker value={v.numPos} onChange={(numPos) => set({ numPos })} />
          </Field>
          <Field label="Style">
            <Segmented label="Number style" value={v.numFormat} onChange={(numFormat) => set({ numFormat })} options={[
              { value: "{n}", label: "1" }, { value: "Page {n}", label: "Page 1" }, { value: "{n} / {total}", label: "1 / 9" }, { value: "Page {n} of {total}", label: "Page 1 of 9" },
            ]} />
          </Field>
          <div className="field-row">
            <Field label="Start at">
              <input type="number" min={0} value={v.numStart} onChange={(e) => set({ numStart: Number(e.target.value) || 0 })} aria-label="Start at" />
            </Field>
            <Field label="Size">
              <input type="number" min={6} max={48} value={v.numSize} onChange={(e) => set({ numSize: Math.min(48, Math.max(6, Number(e.target.value) || 11)) })} aria-label="Text size" />
            </Field>
          </div>
          <Field label="Typeface">
            <Segmented label="Typeface" value={v.numFont} onChange={(numFont) => set({ numFont })} options={[
              { value: "sans", label: "Sans" }, { value: "serif", label: "Serif" }, { value: "mono", label: "Mono" },
            ]} />
          </Field>
          <Field label="Colour"><ColorPicker value={v.color} onChange={(color) => set({ color })} /></Field>
          <Toggle checked={v.numSkipFirst} onChange={(numSkipFirst) => set({ numSkipFirst })} label="Skip the first page (cover)" />
        </>
      );
    case "watermark":
      return (
        <>
          <Field label="Watermark">
            <Segmented label="Kind" value={v.wmKind} onChange={(wmKind) => set({ wmKind })} options={[{ value: "text", label: "Text" }, { value: "image", label: "Image" }]} />
          </Field>
          {v.wmKind === "text" ? (
            <>
              <Field label="Text">
                <input value={v.wmText} onChange={(e) => set({ wmText: e.target.value })} aria-label="Watermark text" />
                {T.unsupportedChars(v.wmText) && <div className="field-hint warn">The built-in font has no {T.unsupportedChars(v.wmText)} — those characters will print as “?”.</div>}
              </Field>
              <Field label="Size"><Slider label="Size" value={v.wmSize} min={10} max={140} onChange={(wmSize) => set({ wmSize })} format={(s) => `${s} pt`} /></Field>
              <Field label="Colour"><ColorPicker value={v.color} onChange={(color) => set({ color })} /></Field>
              <Toggle checked={v.wmBold} onChange={(wmBold) => set({ wmBold })} label="Bold" />
            </>
          ) : (
            <>
              <Field label="Image" hint="PNG with transparency works best for logos">
                <ImagePick value={v.wmImage} onChange={(wmImage) => set({ wmImage })} />
              </Field>
              <Field label="Width"><Slider label="Image width" value={Math.round(v.wmSize)} min={5} max={100} onChange={(wmSize) => set({ wmSize })} format={(s) => `${s}% of page`} /></Field>
            </>
          )}
          <Field label="Placement">
            <Segmented label="Placement" value={v.wmLayout === "center" || v.wmLayout === "tile" ? v.wmLayout : "corner"} onChange={(l) => set({ wmLayout: l === "corner" ? "bottom-right" : (l as "center" | "tile") })} options={[
              { value: "center", label: "Centre" }, { value: "tile", label: "Tiled" }, { value: "corner", label: "Corner" },
            ]} />
          </Field>
          {v.wmLayout !== "center" && v.wmLayout !== "tile" && <PositionPicker value={v.wmLayout} onChange={(wmLayout) => set({ wmLayout })} />}
          <Field label="Opacity"><Slider label="Opacity" value={Math.round(v.wmOpacity * 100)} min={5} max={100} onChange={(o) => set({ wmOpacity: o / 100 })} format={(o) => `${o}%`} /></Field>
          <Field label="Angle"><Slider label="Angle" value={v.wmAngle} min={-90} max={90} step={5} onChange={(wmAngle) => set({ wmAngle })} format={(a) => `${a}°`} /></Field>
        </>
      );
    case "crop":
      return (
        <>
          <Field label="Trim from each edge (mm)">
            <div className="crop-grid">
              {(["top", "left", "right", "bottom"] as const).map((k) => (
                <label key={k} className={`crop-${k}`}>
                  <span>{k}</span>
                  <input type="number" min={0} max={200} value={v.crop[k]} onChange={(e) => set({ crop: { ...v.crop, [k]: Math.max(0, Number(e.target.value) || 0) } })} aria-label={`Trim ${k}`} />
                </label>
              ))}
              <div className="crop-page" aria-hidden="true" />
            </div>
          </Field>
          <Explainer text="Cropping hides the trimmed area. It can be undone later by any PDF editor." />
        </>
      );
    case "protect":
      return (
        <>
          <Field label="Password"><input type="password" value={v.password} onChange={(e) => set({ password: e.target.value })} aria-label="Password" autoComplete="new-password" /></Field>
          <Field label="Repeat password"><input type="password" value={v.password2} onChange={(e) => set({ password2: e.target.value })} aria-label="Repeat password" autoComplete="new-password" /></Field>
          <Explainer text="AES-256 encryption. Keep the password safe — it can't be recovered." />
        </>
      );
    case "unlock":
      return (
        <>
          <Explainer text="Removes both kinds of lock: the password needed to open a file, and restrictions on printing, copying or editing." />
          <Explainer text="For files that need a password to open, Opus asks for it when you add them. Restrictions are removed without a password." />
          <Explainer text="Opus can't open a file whose password you don't know." />
        </>
      );
    default:
      return null;
  }
}

/** Text box for page numbers that stays in sync with the thumbnails. */
function TypedPages({ pageCount, selected, onChange }: { pageCount: number; selected: number[]; onChange: (p: number[]) => void }) {
  const [text, setText] = useState("");
  const [err, setErr] = useState("");
  const typing = useRef(false);
  useEffect(() => {
    if (typing.current) return;
    setText(compactRanges(selected));
    setErr("");
  }, [selected]);
  return (
    <Field label="Or type pages" hint={err ? undefined : "e.g. 1, 3-5"}>
      <input
        value={text}
        placeholder="1, 3-5"
        aria-label="Pages"
        aria-invalid={!!err}
        onFocus={() => (typing.current = true)}
        onBlur={() => (typing.current = false)}
        onChange={(e) => {
          setText(e.target.value);
          if (!e.target.value.trim()) {
            setErr("");
            onChange([]);
            return;
          }
          try {
            onChange([...new Set(parseRanges(e.target.value, pageCount || 1).flat())].sort((a, b) => a - b));
            setErr("");
          } catch (x) {
            setErr((x as Error).message);
            onChange([]);
          }
        }}
      />
      {err && <div className="form-error">{err}</div>}
    </Field>
  );
}

function compactRanges(pages: number[]): string {
  const out: string[] = [];
  for (let i = 0; i < pages.length; i++) {
    let j = i;
    while (j + 1 < pages.length && pages[j + 1] === pages[j] + 1) j++;
    out.push(i === j ? `${pages[i] + 1}` : `${pages[i] + 1}-${pages[j] + 1}`);
    i = j;
  }
  return out.join(", ");
}

/** Turns technical library errors into plain language. */
function friendly(e: unknown): string {
  const msg = (e as Error)?.message ?? String(e);
  if (/instance of|parse|offset=|Expected|undefined|Cannot read/i.test(msg)) {
    return "This file is damaged or not a real PDF, so Opus couldn't process it.";
  }
  return msg;
}

function Explainer({ text }: { text: string }) {
  return <p className="explainer">{text}</p>;
}

function ImagePick({ value, onChange }: { value?: Values["wmImage"]; onChange: (v: Values["wmImage"]) => void }) {
  const pickImage = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/webp";
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      const img = await prepareImage(new Uint8Array(await f.arrayBuffer()), f.name);
      onChange({ bytes: img.bytes, type: img.type, url: previewUrl(img.bytes), name: f.name });
    };
    input.click();
  };
  return (
    <button type="button" className="image-pick" onClick={pickImage}>
      {value ? <img src={value.url} alt="" /> : <Icon name="image-plus" size={22} />}
      <span>{value ? value.name : "Choose an image"}</span>
    </button>
  );
}

function splitSummary(v: Values, pageCount: number): string {
  try {
    const groups = v.splitMode === "ranges" ? parseRanges(v.ranges, pageCount) : chunkPages(pageCount, v.splitMode === "each" ? 1 : v.every);
    return `This makes ${groups.length} file${groups.length === 1 ? "" : "s"} from ${pageCount} pages.`;
  } catch (e) {
    return (e as Error).message;
  }
}

/** Grid of page thumbnails you click to select. */
function PagePicker({ source, selected, onChange, mode }: { source: Source; selected: number[]; onChange: (p: number[]) => void; mode: "remove" | "keep" }) {
  const set = useMemo(() => new Set(selected), [selected]);
  const anchor = useRef<number | null>(null);
  return (
    <div className="page-picker">
      {Array.from({ length: source.pageCount }, (_, i) => (
        <button
          key={i}
          className={`pick ${set.has(i) ? `on ${mode}` : ""}`}
          aria-pressed={set.has(i)}
          onClick={(e) => {
            const next = new Set(set);
            if (e.shiftKey && anchor.current !== null) {
              const [a, b] = [Math.min(anchor.current, i), Math.max(anchor.current, i)];
              for (let k = a; k <= b; k++) next.add(k);
            } else if (next.has(i)) next.delete(i);
            else next.add(i);
            anchor.current = i;
            onChange([...next].sort((a, b) => a - b));
          }}
        >
          <PageCanvas source={source} index={i} rotation={0} width={110} preload={300} />
          <span className="pick-mark"><Icon name={mode === "remove" ? "close" : "check"} size={14} /></span>
          <span className="pick-num">{i + 1}</span>
        </button>
      ))}
    </div>
  );
}

// ---------- execution ----------

async function execute(id: string, items: Item[], v: Values, progress: (s: string) => void): Promise<Output[]> {
  const pdfOut = (it: Item, bytes: Uint8Array, note?: string, good?: boolean): Output => ({
    name: `${baseName(it.name)}${SUFFIX[id] ? `-${SUFFIX[id]}` : ""}.pdf`, bytes, kind: "pdf", note, good, from: it,
  });
  const map = (s: Source) => new Map([[s.id, s]]);
  const each = async (fn: (it: Item, src: Source) => Promise<Output | Output[]>) => {
    const out: Output[] = [];
    for (let k = 0; k < items.length; k++) {
      const it = items[k];
      if (items.length > 1) progress(`${k + 1} of ${items.length}…`);
      try {
        if (!it.source) throw new Error("This file couldn't be read");
        const r = await fn(it, it.source);
        out.push(...(Array.isArray(r) ? r : [r]).map((o) => ({ ...o, from: o.from ?? it })));
      } catch (e) {
        // One bad file doesn't spoil the batch: report it and carry on.
        out.push({ name: it.name, bytes: new Uint8Array(), kind: "error", note: friendly(e) });
      }
    }
    return out;
  };

  switch (id) {
    case "merge": {
      const sources = new Map(items.map((i) => [i.source!.id, i.source!]));
      const pages = items.flatMap((i) => pagesOf(i.source!));
      return [{ name: `${baseName(items[0].name)}-merged.pdf`, bytes: await buildPdf(pages, sources), kind: "pdf", note: `${pages.length} pages` }];
    }
    case "split": {
      const it = items[0];
      const src = it.source!;
      const groups = v.splitMode === "ranges" ? parseRanges(v.ranges, src.pageCount) : chunkPages(src.pageCount, v.splitMode === "each" ? 1 : v.every);
      const all = pagesOf(src);
      const out: Output[] = [];
      for (let k = 0; k < groups.length; k++) {
        progress(`File ${k + 1} of ${groups.length}…`);
        out.push({ name: `${baseName(it.name)} - ${describeGroup(groups[k])}.pdf`, bytes: await buildPdf(groups[k].map((i) => ({ ...all[i], key: `${k}-${i}` })), map(src)), kind: "pdf", from: it });
      }
      return out;
    }
    case "remove":
    case "extract": {
      const it = items[0];
      const src = it.source!;
      const picked = new Set(v.pickedPages);
      if (!picked.size) throw new Error(id === "remove" ? "Click the pages you want to remove" : "Click the pages you want to keep");
      const all = pagesOf(src);
      const keep = all.filter((_, i) => (id === "remove" ? !picked.has(i) : picked.has(i)));
      if (!keep.length) throw new Error("You can't remove every page");
      if (id === "extract" && v.extractSeparate) {
        const out: Output[] = [];
        for (const p of keep) out.push({ name: `${baseName(it.name)} - page ${p.index + 1}.pdf`, bytes: await buildPdf([p], map(src)), kind: "pdf", from: it });
        return out;
      }
      return [pdfOut(it, await buildPdf(keep, map(src)), `${keep.length} pages`)];
    }
    case "rotate":
      return each(async (it, src) => {
        const pages: PageRef[] = pagesOf(src);
        const { PDFDocument } = await import("@cantoo/pdf-lib");
        const doc = await PDFDocument.load(src.bytes, { updateMetadata: false });
        let n = 0;
        doc.getPages().forEach((pg, i) => {
          const rot = normalizeRotation(src.baseRotations[i]);
          const { width, height } = pg.getSize();
          const visualLandscape = rot % 180 === 0 ? width > height : height > width;
          const match = v.rotateWhich === "all" || (v.rotateWhich === "landscape") === visualLandscape;
          if (match) {
            pages[i].rotation = v.angle;
            n++;
          }
        });
        if (n === 0) throw new Error(`No ${v.rotateWhich} pages in this file`);
        return pdfOut(it, await buildPdf(pages, map(src)), `${n} page${n === 1 ? "" : "s"} turned`);
      });
    case "blank":
      return each(async (it, src) => pdfOut(it, await T.insertBlank(src.bytes, v.blankWhere)));
    case "reverse":
      return each(async (it, src) => pdfOut(it, await T.reversePages(src.bytes)));
    case "compress":
      return each(async (it, src) => {
        const out = await native.compress(src.bytes, v.level);
        const before = it.size;
        if (out.length >= before * 0.98) return pdfOut(it, src.bytes, "Already as small as it gets");
        const pct = Math.round((1 - out.length / before) * 100);
        return pdfOut(it, out, `${pct}% smaller`, true);
      });
    case "repair": {
      const out: Output[] = [];
      for (const it of items) {
        const bytes = it.source?.bytes ?? it.raw!;
        try {
          if (bytes.length === 0) throw new Error("This file is empty — there is nothing to repair");
          if (!new TextDecoder("latin1").decode(bytes.subarray(0, 1024)).includes("%PDF")) throw new Error("This isn't a PDF file, so it can't be repaired");
          let fixed: Uint8Array;
          if (await native.hasEngine()) {
            fixed = await native.repair(bytes).catch(() => T.resave(bytes));
          } else fixed = await T.resave(bytes);
          out.push(pdfOut(it, fixed, "Rebuilt", true));
        } catch (e) {
          out.push({ name: it.name, bytes: new Uint8Array(), kind: "error", note: friendly(e) });
        }
      }
      return out;
    }
    case "grayscale":
      return each(async (it, src) => pdfOut(it, await native.grayscale(src.bytes)));
    case "flatten":
      return each(async (it, src) => pdfOut(it, await T.flattenForms(src.bytes)));
    case "metadata": {
      const it = items[0];
      if (!v.info) throw new Error("Properties are still loading");
      return [pdfOut(it, await T.writeInfo(it.source!.bytes, v.info))];
    }
    case "pdf-to-image":
      return each(async (it, src) => {
        const pages = Array.from({ length: src.pageCount }, (_, i) => i);
        const imgs = await pdfToImages(src, pages, { format: v.imgFormat, dpi: v.dpi, quality: v.quality }, baseName(it.name), (d, t) =>
          progress(items.length > 1 ? `${it.name}: page ${d} of ${t}` : `Page ${d} of ${t}…`),
        );
        return imgs.map((im) => ({ ...im, kind: "image" as const }));
      });
    case "image-to-pdf": {
      const imgs = items.map((i) => i.image!).filter(Boolean);
      progress("Building PDF…");
      const bytes = await T.imagesToPdf(imgs, { pageSize: v.pageSize, orientation: v.orientation, marginMm: v.margin });
      return [{ name: `${items[0].name.replace(/\.[a-z0-9]+$/i, "")}${imgs.length > 1 ? "-and-more" : ""}.pdf`, bytes, kind: "pdf", note: `${imgs.length} page${imgs.length === 1 ? "" : "s"}` }];
    }
    case "extract-images":
      return each(async (it, src) => {
        const imgs = await extractImages(src, baseName(it.name));
        if (!imgs.length) throw new Error(`${it.name} has no embedded images`);
        return imgs.map((im) => ({ ...im, kind: "image" as const }));
      });
    case "pdfa":
      return each(async (it, src) => pdfOut(it, await native.toPdfA(src.bytes, v.pdfaPart), `PDF/A-${v.pdfaPart}b`, true));
    case "page-numbers":
      return each(async (it, src) =>
        pdfOut(it, await T.addPageNumbers(src.bytes, {
          position: v.numPos, format: v.numFormat, start: v.numStart, size: v.numSize, marginMm: 10, color: v.color,
          pages: v.numSkipFirst ? "skip-first" : "all", font: v.numFont,
        })),
      );
    case "watermark":
      if (v.wmKind === "image" && !v.wmImage) throw new Error("Choose an image for the watermark");
      return each(async (it, src) =>
        pdfOut(it, await T.addWatermark(src.bytes, {
          kind: v.wmKind, text: v.wmText, image: v.wmImage && { bytes: v.wmImage.bytes, type: v.wmImage.type },
          imageScale: v.wmSize / 100, size: v.wmSize, color: v.color, opacity: v.wmOpacity, angle: v.wmAngle,
          layout: v.wmLayout, pages: "all", bold: v.wmBold,
        })),
      );
    case "crop":
      return each(async (it, src) => pdfOut(it, await T.cropPages(src.bytes, { ...v.crop, pages: "all" })));
    case "protect":
      if (!v.password) throw new Error("Type a password");
      if (v.password !== v.password2) throw new Error("The two passwords don't match");
      return each(async (it, src) => pdfOut(it, await buildPdf(pagesOf(src), map(src), { password: v.password }), "AES-256", true));
    case "unlock":
      return each(async (it, src) =>
        pdfOut(
          it,
          await buildPdf(pagesOf(src), map(src)),
          it.lock === "password" ? "Password removed" : it.lock === "restrictions" ? "Restrictions removed" : "Wasn't locked",
          it.lock !== "none",
        ),
      );
    default:
      throw new Error("This tool isn't available yet");
  }
}

// ---------- live preview ----------

const PREVIEWABLE = new Set(["page-numbers", "watermark", "crop", "rotate"]);

/** Applies the tool to the first page only and returns it ready to draw. */
function useLivePreview(toolId: string, src: Source | undefined, v: Values): Source | null {
  const [preview, setPreview] = useState<Source | null>(null);
  const key = JSON.stringify([toolId, src?.id, v.numPos, v.numFormat, v.numStart, v.numSize, v.numSkipFirst, v.numFont, v.color,
    v.wmKind, v.wmText, v.wmSize, v.wmOpacity, v.wmAngle, v.wmLayout, v.wmBold, v.wmImage?.name, v.crop, v.angle, v.rotateWhich]);
  useEffect(() => {
    if (!src || !PREVIEWABLE.has(toolId)) {
      setPreview(null);
      return;
    }
    let alive = true;
    const t = setTimeout(async () => {
      try {
        const first = pagesOf(src)[0];
        const one = await buildPdf([first], new Map([[src.id, src]]));
        let out = one;
        if (toolId === "page-numbers") {
          out = await T.addPageNumbers(one, { position: v.numPos, format: v.numFormat.replace("{total}", String(src.pageCount + v.numStart - 1)), start: v.numStart, size: v.numSize, marginMm: 10, color: v.color, pages: v.numSkipFirst ? [] : "all", font: v.numFont });
        } else if (toolId === "watermark") {
          if (v.wmKind === "image" && !v.wmImage) out = one;
          else out = await T.addWatermark(one, { kind: v.wmKind, text: v.wmText, image: v.wmImage && { bytes: v.wmImage.bytes, type: v.wmImage.type }, imageScale: v.wmSize / 100, size: v.wmSize, color: v.color, opacity: v.wmOpacity, angle: v.wmAngle, layout: v.wmLayout, pages: "all", bold: v.wmBold });
        } else if (toolId === "crop") {
          out = await T.cropPages(one, { ...v.crop, pages: "all" });
        } else if (toolId === "rotate") {
          const s1 = await loadSource(one, "p.pdf");
          const p = pagesOf(s1);
          p[0].rotation = v.angle;
          out = await buildPdf(p, new Map([[s1.id, s1]]));
        }
        const loaded = await loadSource(out, "preview.pdf");
        if (alive) {
          setPreview((old) => {
            if (old) setTimeout(() => closeSource(old.id), 1000);
            return loaded;
          });
        }
      } catch {
        if (alive) setPreview(null);
      }
    }, 220);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return preview;
}
