// Compares two PDFs and builds a side-by-side report with the changed areas
// highlighted, plus a short text summary of what changed. Fully offline.

import { PDFDocument, rgb, StandardFonts } from "@cantoo/pdf-lib";
import type { Source } from "./pdfops.ts";
import { getPage, pageText } from "./render.ts";

const DPI = 110;
const SCALE = DPI / 72;
const THRESHOLD = 44; // per-channel difference that counts as a change

interface Rendered {
  canvas: HTMLCanvasElement;
  wPt: number;
  hPt: number;
}

async function renderPage(source: Source, index: number): Promise<Rendered> {
  const page = await getPage(source, index);
  const rotation = (page.rotate % 360 + 360) % 360;
  const vp = page.getViewport({ scale: SCALE, rotation });
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, viewport: vp }).promise;
  return { canvas, wPt: vp.width / SCALE, hPt: vp.height / SCALE };
}

/**
 * Tints pixels that differ between A and B onto fresh copies of each, and
 * returns how many pixels changed. Both are compared on a shared grid.
 */
function diffInto(a: HTMLCanvasElement, b: HTMLCanvasElement): { aOut: HTMLCanvasElement; bOut: HTMLCanvasElement; changed: number } {
  const w = Math.max(a.width, b.width);
  const h = Math.max(a.height, b.height);
  const grid = (src: HTMLCanvasElement) => {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const cx = c.getContext("2d")!;
    cx.fillStyle = "#fff";
    cx.fillRect(0, 0, w, h);
    cx.drawImage(src, 0, 0);
    return c;
  };
  const ca = grid(a), cb = grid(b);
  const xa = ca.getContext("2d")!, xb = cb.getContext("2d")!;
  const da = xa.getImageData(0, 0, w, h), db = xb.getImageData(0, 0, w, h);
  const pa = da.data, pb = db.data;
  let changed = 0;
  const inky = (p: Uint8ClampedArray, i: number) => p[i] + p[i + 1] + p[i + 2] < 3 * 200;
  for (let i = 0; i < pa.length; i += 4) {
    if (Math.abs(pa[i] - pb[i]) > THRESHOLD || Math.abs(pa[i + 1] - pb[i + 1]) > THRESHOLD || Math.abs(pa[i + 2] - pb[i + 2]) > THRESHOLD) {
      changed++;
      // On each side: paint the side's own ink red where it differs; where the
      // change is only on the OTHER side, lay a faint yellow highlight so the
      // area is marked without inventing text that isn't there.
      if (inky(pa, i)) { pa[i] = 224; pa[i + 1] = 48; pa[i + 2] = 48; }
      else { pa[i] = 255; pa[i + 1] = 238; pa[i + 2] = 150; }
      if (inky(pb, i)) { pb[i] = 224; pb[i + 1] = 48; pb[i + 2] = 48; }
      else { pb[i] = 255; pb[i + 1] = 238; pb[i + 2] = 150; }
    }
  }
  xa.putImageData(da, 0, 0);
  xb.putImageData(db, 0, 0);
  return { aOut: ca, bOut: cb, changed };
}

async function toJpeg(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob>((res, rej) => canvas.toBlob((x) => (x ? res(x) : rej(new Error("render failed"))), "image/jpeg", 0.85));
  return new Uint8Array(await blob.arrayBuffer());
}

export interface CompareResult {
  pdf: Uint8Array;
  summary: string;
  changedPages: number;
}

export interface CompareOptions {
  nameA?: string;
  nameB?: string;
  onProgress?: (done: number, total: number) => void;
}

export async function comparePdfs(a: Source, b: Source, opts: CompareOptions = {}): Promise<CompareResult> {
  const out = await PDFDocument.create();
  const font = await out.embedFont(StandardFonts.Helvetica);
  const bold = await out.embedFont(StandardFonts.HelveticaBold);
  const pages = Math.max(a.pageCount, b.pageCount);
  const gap = 24, margin = 28, header = 46;
  let changedPages = 0;
  let changedText = 0;

  for (let i = 0; i < pages; i++) {
    opts.onProgress?.(i, pages);
    const hasA = i < a.pageCount, hasB = i < b.pageCount;

    // Text-level change detection for the summary.
    const [ta, tb] = await Promise.all([
      hasA ? pageText(a, i).catch(() => "") : Promise.resolve(""),
      hasB ? pageText(b, i).catch(() => "") : Promise.resolve(""),
    ]);
    if (ta.replace(/\s+/g, " ").trim() !== tb.replace(/\s+/g, " ").trim()) changedText++;

    const ra = hasA ? await renderPage(a, i) : null;
    const rb = hasB ? await renderPage(b, i) : null;

    let leftImg: Uint8Array, rightImg: Uint8Array, lw: number, lh: number, rw: number, rh: number;
    let note = "";
    if (ra && rb) {
      const { aOut, bOut, changed } = diffInto(ra.canvas, rb.canvas);
      if (changed > 0) changedPages++;
      leftImg = await toJpeg(aOut); rightImg = await toJpeg(bOut);
      lw = ra.wPt; lh = ra.hPt; rw = rb.wPt; rh = rb.hPt;
      note = changed > 0 ? `${((changed / (aOut.width * aOut.height)) * 100).toFixed(1)}% of the page changed` : "No visual differences";
    } else if (ra) {
      leftImg = await toJpeg(ra.canvas); rightImg = leftImg; lw = rw = ra.wPt; lh = rh = ra.hPt;
      changedPages++; note = "Only in the first PDF";
    } else {
      rightImg = await toJpeg(rb!.canvas); leftImg = rightImg; lw = rw = rb!.wPt; lh = rh = rb!.hPt;
      changedPages++; note = "Only in the second PDF";
    }

    // Lay the two pages side by side on a landscape sheet.
    const colW = Math.max(lw, rw);
    const sheetW = margin * 2 + colW * 2 + gap;
    const sheetH = header + margin + Math.max(lh, rh);
    const sheet = out.addPage([sheetW, sheetH]);
    sheet.drawText(`Page ${i + 1}`, { x: margin, y: sheetH - 30, size: 15, font: bold });
    sheet.drawText(note, { x: margin + 70, y: sheetH - 29, size: 11, font, color: note.includes("No visual") ? rgb(0.3, 0.6, 0.4) : rgb(0.8, 0.2, 0.2) });
    sheet.drawText(opts.nameA ?? "First", { x: margin, y: sheetH - header + 2, size: 9, font, color: rgb(0.45, 0.45, 0.5) });
    sheet.drawText(opts.nameB ?? "Second", { x: margin + colW + gap, y: sheetH - header + 2, size: 9, font, color: rgb(0.45, 0.45, 0.5) });

    const top = sheetH - header;
    if (hasA || !hasB) {
      const img = await out.embedJpg(leftImg);
      sheet.drawImage(img, { x: margin, y: top - lh, width: lw, height: lh, opacity: hasA ? 1 : 0.25 });
    }
    if (hasB || !hasA) {
      const img = await out.embedJpg(rightImg);
      sheet.drawImage(img, { x: margin + colW + gap, y: top - rh, width: rw, height: rh, opacity: hasB ? 1 : 0.25 });
    }
    // divider
    sheet.drawLine({ start: { x: margin + colW + gap / 2, y: 10 }, end: { x: margin + colW + gap / 2, y: top }, thickness: 0.5, color: rgb(0.8, 0.8, 0.82) });
  }

  out.setProducer("Opus by Lykin");
  const pdf = await out.save({ useObjectStreams: true });
  const parts: string[] = [];
  if (a.pageCount !== b.pageCount) parts.push(`page count differs (${a.pageCount} vs ${b.pageCount})`);
  parts.push(`${changedPages} of ${pages} page${pages === 1 ? "" : "s"} changed visually`);
  if (changedText) parts.push(`${changedText} with text changes`);
  return { pdf, summary: parts.join("; "), changedPages };
}
