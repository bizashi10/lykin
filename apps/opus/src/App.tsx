import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildPdf, loadSource, extrasLostBy, pagesOf, parseRanges, chunkPages, baseName, describeGroup, normalizeRotation,
  PasswordRequiredError, type PageRef, type Source,
} from "./lib/pdfops";
import { useHistory } from "./lib/history";
import * as platform from "./lib/platform";
import { pageText, closeSource } from "./lib/render";
import { Reader, type Zoom } from "./components/Reader";
import { Organizer } from "./components/Organizer";
import { CommandBar, type Command } from "./components/CommandBar";
import { PasswordDialog, ProtectDialog, SplitDialog, GotoDialog, type SplitMode } from "./components/Dialogs";
import { Icon } from "./components/Icon";

interface Doc {
  pages: PageRef[];
  /** Password applied when saving; null = no protection. */
  password: string | null;
}
interface Meta {
  name: string;
  path?: string;
}
type View = "read" | "organize";
type Dialog =
  | { kind: "password"; fileName: string; wrong: boolean; resolve: (pw: string | null) => void }
  | { kind: "protect" }
  | { kind: "split" }
  | { kind: "goto" }
  | null;
interface Toast {
  id: number;
  text: string;
  tone: "info" | "error" | "success";
  action?: { label: string; run: () => void };
}

const EMPTY: Doc = { pages: [], password: null };
const ZOOMS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];

export default function App() {
  const history = useHistory<Doc>(EMPTY);
  const doc = history.present;
  const [sources, setSources] = useState<Map<string, Source>>(new Map());
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;
  const [meta, setMeta] = useState<Meta | null>(null);
  const savedDoc = useRef<Doc>(EMPTY);
  const [view, setView] = useState<View>("read");
  const [zoom, setZoom] = useState<Zoom>("fit");
  const [current, setCurrent] = useState(0);
  const [jumpSignal, setJumpSignal] = useState(0);
  const [showThumbs, setShowThumbs] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [thumbWidth, setThumbWidth] = useState(170);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [commandOpen, setCommandOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findHits, setFindHits] = useState<number[] | null>(null);
  const [findPos, setFindPos] = useState(0);
  const [dragOver, setDragOver] = useState(false);

  const hasDoc = meta !== null && doc.pages.length > 0;
  const dirty = hasDoc && doc !== savedDoc.current;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  // ---------- helpers ----------
  const toast = useCallback((text: string, tone: Toast["tone"] = "info", action?: Toast["action"]) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, text, tone, action }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === "error" ? 8000 : 5000);
  }, []);

  const withBusy = useCallback(
    async <T,>(label: string, fn: () => Promise<T>): Promise<T | undefined> => {
      setBusy(label);
      // Let the spinner paint before heavy work starts.
      await new Promise((r) => setTimeout(r, 30));
      try {
        return await fn();
      } catch (err) {
        console.error(err);
        toast((err as Error).message || String(err), "error");
        return undefined;
      } finally {
        setBusy(null);
      }
    },
    [toast],
  );

  const askPassword = (fileName: string, wrong: boolean) =>
    new Promise<string | null>((resolve) => setDialog({ kind: "password", fileName, wrong, resolve }));

  /** Loads files, asking for passwords when needed. Skips files that fail. */
  const loadPicked = useCallback(
    async (picked: platform.PickedFile[]) => {
      const loaded: { source: Source; password?: string; file: platform.PickedFile }[] = [];
      for (const file of picked) {
        let password: string | undefined;
        for (;;) {
          try {
            setBusy(`Opening ${file.name}…`);
            const source = await loadSource(file.bytes, file.name, password);
            loaded.push({ source, password, file });
            break;
          } catch (err) {
            setBusy(null);
            if (err instanceof PasswordRequiredError) {
              const pw = await askPassword(file.name, err.wrongPassword);
              setDialog(null);
              if (pw === null) break; // cancelled
              password = pw;
              continue;
            }
            toast(`${file.name}: ${(err as Error).message}`, "error");
            break;
          }
        }
      }
      setBusy(null);
      for (const l of loaded) {
        if (l.source.restrictionsRemoved) {
          toast(`${l.file.name} had editing restrictions. Opus removes them; use Protect to add a password when saving.`);
        }
      }
      if (loaded.length) {
        setSources((prev) => {
          const next = new Map(prev);
          loaded.forEach((l) => next.set(l.source.id, l.source));
          sourcesRef.current = next;
          return next;
        });
      }
      return loaded;
    },
    [toast],
  );

  const confirmDiscard = useCallback(async () => {
    if (!dirtyRef.current) return true;
    return platform.confirm("You have unsaved changes. Discard them?");
  }, []);

  /** Asks before a save that would drop bookmarks or form fields. */
  const confirmExtrasLoss = useCallback(async (pages: PageRef[]) => {
    const names = extrasLostBy(pages, sourcesRef.current);
    if (!names.length) return true;
    return platform.confirm(
      `${names.join(", ")} has bookmarks or fillable form fields.\n\n` +
        "Because pages were moved, removed or combined, this version of Opus can't keep them " +
        "(the page contents themselves are kept). Your original file is not changed unless you save over it.\n\nContinue?",
    );
  }, []);

  // ---------- open / merge / insert ----------
  const openFiles = useCallback(
    async (picked: platform.PickedFile[]) => {
      if (!picked.length) return;
      if (!(await confirmDiscard())) return;
      const loaded = await loadPicked(picked);
      if (!loaded.length) return;
      const pages = loaded.flatMap((l) => pagesOf(l.source));
      const single = loaded.length === 1;
      const next: Doc = { pages, password: single ? (loaded[0].password ?? null) : null };
      history.reset(next);
      savedDoc.current = single ? next : EMPTY; // a fresh merge counts as unsaved
      setMeta(single ? { name: loaded[0].file.name, path: loaded[0].file.path } : { name: "Merged.pdf" });
      setSelected(new Set());
      setCurrent(0);
      setJumpSignal((n) => n + 1);
      setFindHits(null);
      if (!single) {
        setView("organize");
        toast(`Merged ${loaded.length} files (${pages.length} pages). Drag pages to reorder, then save.`, "success");
      }
    },
    [confirmDiscard, loadPicked, history, toast],
  );

  const openDialog = useCallback(async () => {
    const picked = await platform.pickPdfs(false).catch((e) => (toast(String(e), "error"), []));
    await openFiles(picked);
  }, [openFiles, toast]);

  const mergeDialog = useCallback(async () => {
    const picked = await platform.pickPdfs(true).catch((e) => (toast(String(e), "error"), []));
    if (picked.length === 1 && !hasDoc) return openFiles(picked);
    if (picked.length) await openFiles(picked);
  }, [openFiles, hasDoc, toast]);

  /** Adds pages from other PDFs into the open document. */
  const insertFiles = useCallback(
    async (picked: platform.PickedFile[], at?: number) => {
      if (!picked.length) return;
      if (!hasDoc) return openFiles(picked);
      const loaded = await loadPicked(picked);
      if (!loaded.length) return;
      const added = loaded.flatMap((l) => pagesOf(l.source));
      let index = at;
      if (index === undefined) {
        const selIdx = doc.pages.map((p, i) => (selected.has(p.key) ? i : -1)).filter((i) => i >= 0);
        index = view === "organize" && selIdx.length ? Math.max(...selIdx) + 1 : doc.pages.length;
      }
      const insertAt = index;
      history.commit((d) => ({ ...d, pages: [...d.pages.slice(0, insertAt), ...added, ...d.pages.slice(insertAt)] }));
      setSelected(new Set(added.map((p) => p.key)));
      toast(`Added ${added.length} page${added.length === 1 ? "" : "s"} from ${loaded.map((l) => l.file.name).join(", ")}`, "success");
    },
    [hasDoc, openFiles, loadPicked, doc.pages, selected, view, history, toast],
  );

  const addDialog = useCallback(async () => {
    const picked = await platform.pickPdfs(true).catch(() => []);
    await insertFiles(picked);
  }, [insertFiles]);

  // ---------- save ----------
  const save = useCallback(
    async (saveAs: boolean) => {
      if (!hasDoc || !meta) return;
      const snapshot = doc;
      if (!(await confirmExtrasLoss(snapshot.pages))) return;
      await withBusy("Saving…", async () => {
        const bytes = await buildPdf(snapshot.pages, sourcesRef.current, { password: snapshot.password ?? undefined });
        const target = await platform.saveBytes(bytes, meta.name, saveAs ? undefined : meta.path);
        if (!target) return;
        savedDoc.current = snapshot;
        setMeta({ name: platform.fileNameOf(target), path: platform.isDesktop ? target : undefined });
        toast(`Saved ${platform.fileNameOf(target)}${snapshot.password ? " (password-protected)" : ""}`, "success");
      });
    },
    [hasDoc, meta, doc, withBusy, toast, confirmExtrasLoss],
  );

  // ---------- page operations ----------
  const selectedKeys = useMemo(() => doc.pages.filter((p) => selected.has(p.key)).map((p) => p.key), [doc.pages, selected]);
  /** In organize view: the selection. In read view: the current page. */
  const targetKeys = useCallback(
    () => (view === "organize" ? selectedKeys : doc.pages[current] ? [doc.pages[current].key] : []),
    [view, selectedKeys, doc.pages, current],
  );

  const rotate = useCallback(
    (keys: string[], delta: number) => {
      if (!keys.length) return toast("Select pages first (click a page; Ctrl+click for more)");
      const set = new Set(keys);
      history.commit((d) => ({
        ...d,
        pages: d.pages.map((p) => (set.has(p.key) ? { ...p, rotation: normalizeRotation(p.rotation + delta) } : p)),
      }));
    },
    [history, toast],
  );

  const remove = useCallback(
    (keys: string[]) => {
      if (!keys.length) return toast("Select pages first (click a page; Ctrl+click for more)");
      if (keys.length >= doc.pages.length) return toast("A PDF needs at least one page — you can't delete them all.", "error");
      const set = new Set(keys);
      history.commit((d) => ({ ...d, pages: d.pages.filter((p) => !set.has(p.key)) }));
      setSelected(new Set());
      setCurrent((c) => Math.min(c, doc.pages.length - keys.length - 1));
      toast(`Deleted ${keys.length} page${keys.length === 1 ? "" : "s"}`, "info", { label: "Undo", run: () => history.undo() });
    },
    [doc.pages.length, history, toast],
  );

  const move = useCallback(
    (keys: string[], toIndex: number) => {
      history.commit((d) => {
        const set = new Set(keys);
        const moving = d.pages.filter((p) => set.has(p.key));
        const before = d.pages.slice(0, toIndex).filter((p) => !set.has(p.key));
        const after = d.pages.slice(toIndex).filter((p) => !set.has(p.key));
        const pages = [...before, ...moving, ...after];
        return pages.every((p, i) => p === d.pages[i]) ? d : { ...d, pages };
      });
    },
    [history],
  );

  const extractSelected = useCallback(async () => {
    const keys = targetKeys();
    if (!keys.length) return toast("Select the pages to extract first");
    const set = new Set(keys);
    const pages = doc.pages.filter((p) => set.has(p.key));
    const idx = doc.pages.map((p, i) => (set.has(p.key) ? i : -1)).filter((i) => i >= 0);
    if (!(await confirmExtrasLoss(pages))) return;
    await withBusy("Extracting pages…", async () => {
      const bytes = await buildPdf(pages, sourcesRef.current);
      const name = `${baseName(meta?.name ?? "document")} - ${describeGroup(idx)}.pdf`;
      const target = await platform.saveBytes(bytes, name);
      if (target) toast(`Saved ${pages.length} page${pages.length === 1 ? "" : "s"} to ${platform.fileNameOf(target)}`, "success");
    });
  }, [targetKeys, doc.pages, meta, withBusy, toast, confirmExtrasLoss]);

  const runSplit = useCallback(
    async (mode: SplitMode, value: string) => {
      const count = doc.pages.length;
      let groups: number[][];
      try {
        groups =
          mode === "ranges" ? parseRanges(value, count) : mode === "every" ? chunkPages(count, parseInt(value, 10)) : chunkPages(count, 1);
      } catch (err) {
        toast((err as Error).message, "error");
        return;
      }
      setDialog(null);
      const lossy = groups.find((g) => extrasLostBy(g.map((i) => doc.pages[i]), sourcesRef.current).length);
      if (lossy && !(await confirmExtrasLoss(lossy.map((i) => doc.pages[i])))) return;
      const folder = await platform.pickFolder();
      if (!folder) return;
      await withBusy(`Splitting into ${groups.length} files…`, async () => {
        const stem = baseName(meta?.name ?? "document");
        const files = [];
        for (const g of groups) {
          const bytes = await buildPdf(g.map((i) => doc.pages[i]), sourcesRef.current, { password: doc.password ?? undefined });
          files.push({ name: `${stem} - ${describeGroup(g)}.pdf`, bytes });
        }
        const written = await platform.saveManyToFolder(folder, files);
        toast(
          `Created ${written.length} PDF${written.length === 1 ? "" : "s"}`,
          "success",
          platform.isDesktop && written[0] ? { label: "Show", run: () => platform.showInFolder(written[0]) } : undefined,
        );
      });
    },
    [doc, meta, withBusy, toast, confirmExtrasLoss],
  );

  const closeDoc = useCallback(async () => {
    if (!(await confirmDiscard())) return;
    history.reset(EMPTY);
    savedDoc.current = EMPTY;
    setMeta(null);
    sourcesRef.current.forEach((_, id) => closeSource(id));
    setSources(new Map());
    setSelected(new Set());
    setFindHits(null);
    setFindOpen(false);
  }, [confirmDiscard, history]);

  // ---------- zoom ----------
  const zoomStep = useCallback(
    (dir: 1 | -1) => {
      setView("read");
      setZoom((z) => {
        const cur = z === "fit" ? 1 : z;
        const next = dir > 0 ? ZOOMS.find((v) => v > cur + 0.001) : [...ZOOMS].reverse().find((v) => v < cur - 0.001);
        return next ?? cur;
      });
    },
    [],
  );

  // ---------- find ----------
  const textCache = useRef(new Map<string, string>());
  const runFind = useCallback(
    async (q: string) => {
      const query = q.trim().toLowerCase();
      if (!query) return setFindHits(null);
      const hits: number[] = [];
      setBusy("Searching…");
      try {
        for (let i = 0; i < doc.pages.length; i++) {
          const p = doc.pages[i];
          const key = `${p.sourceId}:${p.index}`;
          let text = textCache.current.get(key);
          if (text === undefined) {
            text = (await pageText(sourcesRef.current.get(p.sourceId)!, p.index).catch(() => "")).toLowerCase();
            textCache.current.set(key, text);
          }
          if (text.replace(/\s+/g, " ").includes(query)) hits.push(i);
        }
      } finally {
        setBusy(null);
      }
      setFindHits(hits);
      setFindPos(0);
      if (hits.length) {
        setView("read");
        setCurrent(hits[0]);
        setJumpSignal((n) => n + 1);
      }
    },
    [doc.pages],
  );
  const findStep = (dir: 1 | -1) => {
    if (!findHits?.length) return;
    const pos = (findPos + dir + findHits.length) % findHits.length;
    setFindPos(pos);
    setCurrent(findHits[pos]);
    setJumpSignal((n) => n + 1);
  };

  const goTo = (i: number) => {
    setView("read");
    setCurrent(Math.max(0, Math.min(i, doc.pages.length - 1)));
    setJumpSignal((n) => n + 1);
  };

  // ---------- commands ----------
  const commands: Command[] = [
    { id: "open", title: "Open PDF…", shortcut: "Ctrl+O", keywords: "file load", run: openDialog },
    { id: "merge", title: "Merge PDFs into a new file…", keywords: "combine join several", run: mergeDialog },
    { id: "add", title: "Add pages from another PDF…", keywords: "insert merge append combine", enabled: hasDoc, run: addDialog },
    { id: "save", title: "Save", shortcut: "Ctrl+S", enabled: hasDoc, run: () => save(false) },
    { id: "saveas", title: "Save as…", shortcut: "Ctrl+Shift+S", keywords: "copy export", enabled: hasDoc, run: () => save(true) },
    { id: "protect", title: doc.password ? "Change password…" : "Protect with password…", keywords: "lock encrypt secure security", enabled: hasDoc, run: () => setDialog({ kind: "protect" }) },
    {
      id: "unprotect", title: "Remove password", keywords: "unlock decrypt", enabled: hasDoc && !!doc.password,
      run: () => {
        history.commit((d) => ({ ...d, password: null }));
        toast("Password will be removed when you save");
      },
    },
    { id: "split", title: "Split into several PDFs…", keywords: "separate divide break", enabled: hasDoc, run: () => setDialog({ kind: "split" }) },
    { id: "extract", title: "Extract selected pages to a new PDF…", keywords: "save pages copy", enabled: hasDoc, run: extractSelected },
    { id: "rotl", title: "Rotate left", shortcut: "Ctrl+L", keywords: "turn counterclockwise", enabled: hasDoc, run: () => rotate(targetKeys(), -90) },
    { id: "rotr", title: "Rotate right", shortcut: "Ctrl+R", keywords: "turn clockwise", enabled: hasDoc, run: () => rotate(targetKeys(), 90) },
    { id: "delete", title: "Delete page(s)", shortcut: "Del", keywords: "remove", enabled: hasDoc, run: () => remove(targetKeys()) },
    {
      id: "selall", title: "Select all pages", shortcut: "Ctrl+A", enabled: hasDoc,
      run: () => { setView("organize"); setSelected(new Set(doc.pages.map((p) => p.key))); },
    },
    { id: "undo", title: "Undo", shortcut: "Ctrl+Z", enabled: history.canUndo, run: history.undo },
    { id: "redo", title: "Redo", shortcut: "Ctrl+Y", enabled: history.canRedo, run: history.redo },
    { id: "read", title: "Reading view", shortcut: "Ctrl+1", keywords: "view", enabled: hasDoc, run: () => setView("read") },
    { id: "organize", title: "Organize pages view", shortcut: "Ctrl+2", keywords: "reorder grid arrange", enabled: hasDoc, run: () => setView("organize") },
    { id: "find", title: "Find text…", shortcut: "Ctrl+F", keywords: "search", enabled: hasDoc, run: () => setFindOpen(true) },
    { id: "goto", title: "Go to page…", shortcut: "Ctrl+G", keywords: "jump number", enabled: hasDoc, run: () => setDialog({ kind: "goto" }) },
    { id: "zin", title: "Zoom in", shortcut: "Ctrl++", enabled: hasDoc, run: () => zoomStep(1) },
    { id: "zout", title: "Zoom out", shortcut: "Ctrl+-", enabled: hasDoc, run: () => zoomStep(-1) },
    { id: "zfit", title: "Fit to width", shortcut: "Ctrl+0", keywords: "zoom", enabled: hasDoc, run: () => { setView("read"); setZoom("fit"); } },
    { id: "z100", title: "Actual size (100%)", keywords: "zoom", enabled: hasDoc, run: () => { setView("read"); setZoom(1); } },
    { id: "thumbs", title: showThumbs ? "Hide page sidebar" : "Show page sidebar", keywords: "thumbnails", enabled: hasDoc, run: () => setShowThumbs((s) => !s) },
    { id: "close", title: "Close document", shortcut: "Ctrl+W", enabled: hasDoc, run: closeDoc },
  ];
  const commandsRef = useRef(commands);
  commandsRef.current = commands;

  // ---------- keyboard ----------
  useEffect(() => {
    // Browser shortcuts that would reload the window (and lose unsaved work) or print it.
    const blockBrowserKeys = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      const ctrl = e.ctrlKey || e.metaKey;
      if (e.key === "F5" || (ctrl && (k === "r" || k === "p" || k === "u")) || e.key === "F7" || (ctrl && e.shiftKey && k === "i")) {
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", blockBrowserKeys, true);
    const onUnload = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current) e.preventDefault();
    };
    window.addEventListener("beforeunload", onUnload);
    const onKey = (e: KeyboardEvent) => {
      if (busyRef.current) {
        if (e.ctrlKey || e.metaKey) e.preventDefault();
        return;
      }
      const typing = (e.target as HTMLElement)?.closest?.("input, textarea, [contenteditable]");
      const ctrl = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      const run = (id: string) => {
        const c = commandsRef.current.find((x) => x.id === id);
        if (c && c.enabled !== false) {
          e.preventDefault();
          c.run();
        } else if (ctrl) e.preventDefault();
      };
      if (ctrl && k === "k") { e.preventDefault(); setCommandOpen((o) => !o); return; }
      if (dialogRef.current || commandOpenRef.current) return;
      if (ctrl && k === "o") return run("open");
      if (ctrl && k === "s") return run(e.shiftKey ? "saveas" : "save");
      if (ctrl && k === "w") return run("close");
      if (ctrl && k === "f") return run("find");
      if (ctrl && k === "g") return run("goto");
      if (ctrl && (k === "=" || k === "+")) return run("zin");
      if (ctrl && k === "-") return run("zout");
      if (ctrl && k === "0") return run("zfit");
      if (ctrl && k === "1") return run("read");
      if (ctrl && k === "2") return run("organize");
      if (typing) return;
      if (ctrl && k === "z" && !e.shiftKey) return run("undo");
      if (ctrl && (k === "y" || (k === "z" && e.shiftKey))) return run("redo");
      if (ctrl && k === "l") return run("rotl");
      if (ctrl && k === "r") return run("rotr");
      if (ctrl && k === "a" && viewRef.current === "organize") return run("selall");
      if ((e.key === "Delete" || e.key === "Backspace") && viewRef.current === "organize") return run("delete");
      if (e.key === "Escape" && viewRef.current === "organize") setSelected(new Set());
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keydown", blockBrowserKeys, true);
      window.removeEventListener("beforeunload", onUnload);
    };
  }, []);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const dialogRef = useRef(dialog);
  dialogRef.current = dialog;
  const commandOpenRef = useRef(commandOpen);
  commandOpenRef.current = commandOpen;
  const viewRef = useRef(view);
  viewRef.current = view;

  // ---------- desktop integration ----------
  const openFilesRef = useRef(openFiles);
  openFilesRef.current = openFiles;
  useEffect(() => {
    if (!platform.isDesktop) return;
    let unlistenOpen: (() => void) | undefined;
    let unlistenClose: (() => void) | undefined;
    const openPaths = async (paths: string[]) => {
      try {
        openFilesRef.current(await Promise.all(paths.map(platform.readPath)));
      } catch (err) {
        toast(String((err as Error)?.message ?? err), "error");
      }
    };
    (async () => {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      unlistenClose = await getCurrentWindow().onCloseRequested(async (ev) => {
        if (dirtyRef.current && !(await platform.confirm("You have unsaved changes. Close Opus anyway?"))) ev.preventDefault();
      });
      const { listen } = await import("@tauri-apps/api/event");
      unlistenOpen = await listen<string[]>("open-files", (e) => openPaths(e.payload));
      const files = await platform.startupFiles();
      if (files.length) await openPaths(files);
    })().catch(console.error);
    return () => {
      unlistenOpen?.();
      unlistenClose?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const title = meta ? `${dirty ? "• " : ""}${meta.name} — Opus` : "Opus — by Lykin";
    document.title = title;
    if (platform.isDesktop) {
      import("@tauri-apps/api/window").then(({ getCurrentWindow }) => getCurrentWindow().setTitle(title)).catch(() => {});
    }
  }, [meta, dirty]);

  // Files dragged in from Explorer onto the window.
  const onWindowDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files).filter((f) => /\.pdf$/i.test(f.name) || f.type === "application/pdf");
    if (!files.length) {
      if (e.dataTransfer.files.length) toast("Only PDF files can be opened here", "error");
      return;
    }
    const picked = await Promise.all(files.map(platform.fromBrowserFile));
    if (hasDoc) await insertFiles(picked);
    else await openFiles(picked);
  };

  // ---------- render ----------
  const pageCount = doc.pages.length;
  const zoomLabel = zoom === "fit" ? "Fit" : `${Math.round(zoom * 100)}%`;
  const findHitSet = useMemo(() => new Set(findHits ?? []), [findHits]);

  return (
    <div
      className={`app ${dragOver ? "drag-over" : ""}`}
      onDragOver={(e) => {
        if (Array.from(e.dataTransfer.types).includes("Files")) {
          e.preventDefault();
          if (view !== "organize" || !hasDoc) setDragOver(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target || !e.relatedTarget) setDragOver(false);
      }}
      onDrop={onWindowDrop}
    >
      <header className="toolbar">
        <div className="brand" title="Opus — by Lykin">
          <span className="brand-mark">O</span>
          <span className="brand-name">Opus</span>
        </div>
        <div className="tool-group">
          <button onClick={openDialog} title="Open (Ctrl+O)"><Icon name="open" /><span>Open</span></button>
          <button onClick={hasDoc ? addDialog : mergeDialog} title={hasDoc ? "Add pages from other PDFs" : "Merge several PDFs"}>
            <Icon name="merge" /><span>{hasDoc ? "Add PDF" : "Merge"}</span>
          </button>
          <button onClick={() => save(false)} disabled={!hasDoc} title="Save (Ctrl+S)" className={dirty ? "attention" : ""}>
            <Icon name="save" /><span>Save</span>
          </button>
        </div>
        {hasDoc && (
          <>
            <div className="tool-group segmented" role="tablist">
              <button className={view === "read" ? "on" : ""} onClick={() => setView("read")} title="Reading view (Ctrl+1)">
                <Icon name="read" /><span>Read</span>
              </button>
              <button className={view === "organize" ? "on" : ""} onClick={() => setView("organize")} title="Organize pages (Ctrl+2)">
                <Icon name="grid" /><span>Organize</span>
              </button>
            </div>
            <div className="tool-group">
              <button onClick={() => rotate(targetKeys(), -90)} title="Rotate left (Ctrl+L)" className="icon-only"><Icon name="rotate-left" /></button>
              <button onClick={() => rotate(targetKeys(), 90)} title="Rotate right (Ctrl+R)" className="icon-only"><Icon name="rotate-right" /></button>
              <button onClick={() => remove(targetKeys())} title="Delete page(s) (Del)" className="icon-only"><Icon name="trash" /></button>
              <button onClick={extractSelected} title="Extract to new PDF" className="icon-only"><Icon name="extract" /></button>
              <button onClick={() => setDialog({ kind: "split" })} title="Split into several PDFs"><Icon name="split" /><span>Split</span></button>
              <button onClick={() => setDialog({ kind: "protect" })} title={doc.password ? "Password protected — change or remove" : "Protect with a password"} className={doc.password ? "locked" : ""}>
                <Icon name={doc.password ? "lock" : "unlock"} /><span>{doc.password ? "Protected" : "Protect"}</span>
              </button>
            </div>
            <div className="tool-group">
              <button onClick={history.undo} disabled={!history.canUndo} title="Undo (Ctrl+Z)" className="icon-only"><Icon name="undo" /></button>
              <button onClick={history.redo} disabled={!history.canRedo} title="Redo (Ctrl+Y)" className="icon-only"><Icon name="redo" /></button>
            </div>
          </>
        )}
        <span className="spacer" />
        <button className="command-hint" onClick={() => setCommandOpen(true)} title="All commands">
          <Icon name="search" size={15} /> <span>Commands</span> <kbd>Ctrl K</kbd>
        </button>
      </header>

      {findOpen && hasDoc && (
        <div className="findbar">
          <Icon name="search" size={16} />
          <input
            autoFocus
            value={findQuery}
            placeholder="Find text in this PDF"
            aria-label="Find text"
            onChange={(e) => { setFindQuery(e.target.value); setFindHits(null); }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (findHits) findStep(e.shiftKey ? -1 : 1);
                else runFind(findQuery);
              }
              if (e.key === "Escape") { setFindOpen(false); setFindHits(null); }
            }}
          />
          <span className="find-status">
            {findHits === null ? "Press Enter" : findHits.length === 0 ? "No matches" : `Page ${findHits[findPos] + 1} · ${findPos + 1} of ${findHits.length} pages`}
          </span>
          <button onClick={() => findStep(-1)} disabled={!findHits?.length} title="Previous (Shift+Enter)">↑</button>
          <button onClick={() => findStep(1)} disabled={!findHits?.length} title="Next (Enter)">↓</button>
          <button onClick={() => { setFindOpen(false); setFindHits(null); }} title="Close (Esc)" className="icon-only"><Icon name="close" size={16} /></button>
        </div>
      )}

      <main className="workspace">
        {!hasDoc ? (
          <StartScreen onOpen={openDialog} onMerge={mergeDialog} />
        ) : view === "read" ? (
          <Reader
            pages={doc.pages}
            sources={sources}
            zoom={zoom}
            current={Math.min(current, pageCount - 1)}
            onCurrent={setCurrent}
            jumpSignal={jumpSignal}
            showThumbs={showThumbs}
            highlights={findHitSet}
          />
        ) : (
          <Organizer
            pages={doc.pages}
            sources={sources}
            selected={selected}
            onSelect={setSelected}
            onMove={move}
            onRotate={rotate}
            onDelete={remove}
            onOpenPage={goTo}
            onDropFiles={async (files, at) => {
              const pdfs = files.filter((f) => /\.pdf$/i.test(f.name) || f.type === "application/pdf");
              if (!pdfs.length) return toast("Only PDF files can be added", "error");
              await insertFiles(await Promise.all(pdfs.map(platform.fromBrowserFile)), at);
            }}
            thumbWidth={thumbWidth}
          />
        )}
      </main>

      {hasDoc && (
        <footer className="statusbar">
          <span className="file-name" title={meta?.path ?? meta?.name}>
            {dirty && <span className="dot" title="Unsaved changes">●</span>}
            {meta?.name}
          </span>
          {doc.password && <span className="badge"><Icon name="lock" size={12} /> Password-protected</span>}
          <span className="spacer" />
          {view === "organize" ? (
            <>
              <span>{selected.size ? `${selected.size} of ${pageCount} selected` : `${pageCount} pages · click to select, drag to reorder`}</span>
              <label className="slider">
                Size
                <input type="range" min={90} max={320} value={thumbWidth} onChange={(e) => setThumbWidth(Number(e.target.value))} aria-label="Thumbnail size" />
              </label>
            </>
          ) : (
            <>
              <button className="link" onClick={() => setDialog({ kind: "goto" })} title="Go to page (Ctrl+G)">
                Page {Math.min(current, pageCount - 1) + 1} of {pageCount}
              </button>
              <button className="icon-only" onClick={() => zoomStep(-1)} title="Zoom out (Ctrl+-)"><Icon name="zoom-out" size={16} /></button>
              <button className="link zoom-label" onClick={() => setZoom((z) => (z === "fit" ? 1 : "fit"))} title="Toggle fit width / 100%">{zoomLabel}</button>
              <button className="icon-only" onClick={() => zoomStep(1)} title="Zoom in (Ctrl++)"><Icon name="zoom-in" size={16} /></button>
            </>
          )}
        </footer>
      )}

      {dragOver && (
        <div className="drop-hint">
          <div>{hasDoc ? "Drop PDFs to add their pages" : "Drop PDFs to open"}</div>
        </div>
      )}

      {busy && (
        <div className="busy" role="status">
          <div className="spinner" />
          <span>{busy}</span>
        </div>
      )}

      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.tone}`}>
            <span>{t.text}</span>
            {t.action && (
              <button onClick={() => { t.action!.run(); setToasts((x) => x.filter((y) => y.id !== t.id)); }}>{t.action.label}</button>
            )}
          </div>
        ))}
      </div>

      {commandOpen && <CommandBar commands={commands} onClose={() => setCommandOpen(false)} />}

      {dialog?.kind === "password" && (
        <PasswordDialog
          fileName={dialog.fileName}
          wrong={dialog.wrong}
          onSubmit={(pw) => dialog.resolve(pw)}
          onCancel={() => { dialog.resolve(null); setDialog(null); }}
        />
      )}
      {dialog?.kind === "protect" && (
        <ProtectDialog
          hasPassword={!!doc.password}
          onCancel={() => setDialog(null)}
          onSubmit={(pw) => {
            history.commit((d) => ({ ...d, password: pw }));
            setDialog(null);
            toast("Password set. Save to apply it to the file.", "success", { label: "Save now", run: () => save(false) });
          }}
          onRemove={() => {
            history.commit((d) => ({ ...d, password: null }));
            setDialog(null);
            toast("Password will be removed when you save.");
          }}
        />
      )}
      {dialog?.kind === "split" && <SplitDialog pageCount={pageCount} onCancel={() => setDialog(null)} onSubmit={runSplit} />}
      {dialog?.kind === "goto" && (
        <GotoDialog pageCount={pageCount} onCancel={() => setDialog(null)} onSubmit={(i) => { setDialog(null); goTo(i); }} />
      )}
    </div>
  );
}

function StartScreen({ onOpen, onMerge }: { onOpen: () => void; onMerge: () => void }) {
  return (
    <div className="start">
      <div className="start-card">
        <div className="start-mark">O</div>
        <h1>Opus</h1>
        <p className="tagline">by Lykin · your PDFs, finished</p>
        <div className="start-actions">
          <button className="primary big" onClick={onOpen}>
            <Icon name="open" size={20} /> Open a PDF
          </button>
          <button className="big" onClick={onMerge}>
            <Icon name="merge" size={20} /> Merge PDFs
          </button>
        </div>
        <p className="drop-note">or drag PDF files anywhere onto this window</p>
        <p className="private-note">
          <Icon name="lock" size={13} /> Everything stays on this PC. No account, no upload.
        </p>
        <p className="kbd-note">
          Press <kbd>Ctrl</kbd> + <kbd>K</kbd> any time to find a command
        </p>
      </div>
    </div>
  );
}
