// Renders PDF pages to images using pdf.js (fully offline).

import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { Source } from "./pdfops";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const ASSETS = `${import.meta.env.BASE_URL}pdfjs/`;
const docs = new Map<string, { promise: Promise<PDFDocumentProxy>; destroy: () => Promise<void> }>();

export function openForRendering(source: Source): Promise<PDFDocumentProxy> {
  let entry = docs.get(source.id);
  if (!entry) {
    const task = pdfjs.getDocument({
      // pdf.js takes ownership of the buffer it is given, so pass a copy.
      data: source.bytes.slice(),
      cMapUrl: `${ASSETS}cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${ASSETS}standard_fonts/`,
      wasmUrl: `${ASSETS}wasm/`,
      iccUrl: `${ASSETS}iccs/`,
      enableXfa: false,
    });
    entry = { promise: task.promise, destroy: () => task.destroy() };
    docs.set(source.id, entry);
  }
  return entry.promise;
}

export function closeSource(id: string) {
  const entry = docs.get(id);
  docs.delete(id);
  entry?.destroy().catch(() => {});
}

export async function getPage(source: Source, index: number): Promise<PDFPageProxy> {
  const doc = await openForRendering(source);
  return doc.getPage(index + 1);
}

/** Page size in PDF points after applying rotation. */
export async function pageSize(source: Source, index: number, extraRotation: number) {
  const page = await getPage(source, index);
  const vp = page.getViewport({ scale: 1, rotation: (page.rotate + extraRotation + 360) % 360 });
  return { width: vp.width, height: vp.height };
}

export interface RenderJob {
  cancel(): void;
  done: Promise<void>;
}

/** Draws a page into a canvas at `cssWidth` pixels wide (sharp on HiDPI screens). */
export function renderInto(
  canvas: HTMLCanvasElement,
  source: Source,
  index: number,
  extraRotation: number,
  cssWidth: number,
): RenderJob {
  let cancelled = false;
  let task: ReturnType<PDFPageProxy["render"]> | null = null;
  const done = (async () => {
    const page = await getPage(source, index);
    if (cancelled) return;
    const rotation = (page.rotate + extraRotation + 360) % 360;
    const base = page.getViewport({ scale: 1, rotation });
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const scale = (cssWidth / base.width) * dpr;
    const vp = page.getViewport({ scale, rotation });
    // Keep canvases to a sane size to protect memory on huge pages.
    const limit = 16_000_000;
    const shrink = Math.min(1, Math.sqrt(limit / (vp.width * vp.height)));
    const finalVp = shrink < 1 ? page.getViewport({ scale: scale * shrink, rotation }) : vp;
    const off = document.createElement("canvas");
    off.width = Math.floor(finalVp.width);
    off.height = Math.floor(finalVp.height);
    task = page.render({ canvas: off, viewport: finalVp });
    await task.promise;
    if (cancelled) return;
    canvas.width = off.width;
    canvas.height = off.height;
    canvas.getContext("2d")!.drawImage(off, 0, 0);
  })().catch((err) => {
    if (cancelled || err?.name === "RenderingCancelledException") return;
    throw err;
  });
  return {
    cancel() {
      cancelled = true;
      task?.cancel();
    },
    done,
  };
}

/** Pulls the text of a page (used by search). */
export async function pageText(source: Source, index: number): Promise<string> {
  const page = await getPage(source, index);
  const content = await page.getTextContent();
  return content.items.map((i) => ("str" in i ? i.str : "")).join(" ");
}
