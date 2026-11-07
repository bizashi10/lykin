// Offline OCR with Tesseract (WASM). Turns scanned pages into searchable PDFs
// (an invisible, selectable text layer over the page image) and extracts text.
// All assets are bundled under /tesseract, so nothing is downloaded.

import { createWorker, type Worker } from "tesseract.js";
import {
  PDFDocument, StandardFonts, beginText, endText, pushGraphicsState, popGraphicsState,
  setFontAndSize, setTextMatrix, showText, setTextRenderingMode, TextRenderingMode,
} from "@cantoo/pdf-lib";
import type { Source } from "./pdfops.ts";
import { getPage, pageText } from "./render.ts";

const BASE = `${import.meta.env.BASE_URL}tesseract/`;

let workerPromise: Promise<Worker> | null = null;
async function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    workerPromise = createWorker("eng", 1, {
      workerPath: `${BASE}worker.min.js`,
      corePath: BASE,
      langPath: BASE,
      gzip: true,
      cacheMethod: "none",
    });
  }
  return workerPromise;
}

export async function terminateOcr(): Promise<void> {
  if (workerPromise) {
    const w = await workerPromise.catch(() => null);
    workerPromise = null;
    await w?.terminate().catch(() => {});
  }
}

interface OcrWord {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
interface OcrPage {
  text: string;
  words: OcrWord[];
  width: number;
  height: number;
}

/** Runs OCR on a canvas, returning words with pixel bounding boxes. */
async function recognizeCanvas(canvas: HTMLCanvasElement): Promise<OcrPage> {
  const worker = await getWorker();
  const { data } = await worker.recognize(canvas, {}, { text: true, blocks: true });
  const words: OcrWord[] = [];
  for (const block of data.blocks ?? []) {
    for (const para of block.paragraphs ?? []) {
      for (const line of para.lines ?? []) {
        for (const w of line.words ?? []) {
          const t = w.text?.trim();
          if (t) words.push({ text: t, x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1 });
        }
      }
    }
  }
  return { text: data.text ?? "", words, width: canvas.width, height: canvas.height };
}

/** Replaces characters the built-in font can't encode so text never throws. */
function encodable(font: { encodeText(s: string): unknown }, text: string): string {
  let out = "";
  for (const ch of text) {
    try {
      font.encodeText(ch);
      out += ch;
    } catch {
      out += " ";
    }
  }
  return out;
}

export interface OcrResult {
  pdf: Uint8Array;
  text: string;
  /** Pages that were already text (kept as-is, not OCR'd). */
  skipped: number;
  ocred: number;
}

export interface OcrOptions {
  dpi?: number;
  /** Re-OCR pages that already contain text instead of keeping them. */
  force?: boolean;
  onProgress?: (done: number, total: number) => void;
}

/**
 * Builds a searchable PDF. Pages that already have real text are kept as-is;
 * scanned/image pages are rendered, OCR'd, and get an invisible text layer.
 */
export async function ocrToSearchablePdf(source: Source, opts: OcrOptions = {}): Promise<OcrResult> {
  const dpi = opts.dpi ?? 200;
  const scale = dpi / 72;
  const out = await PDFDocument.create();
  const font = await out.embedFont(StandardFonts.Helvetica);
  const srcDoc = await PDFDocument.load(source.bytes, { updateMetadata: false, throwOnInvalidObject: false });
  const texts: string[] = [];
  let ocred = 0;
  let skipped = 0;

  for (let i = 0; i < source.pageCount; i++) {
    opts.onProgress?.(i, source.pageCount);
    const existing = opts.force ? "" : (await pageText(source, i).catch(() => "")).replace(/\s+/g, " ").trim();
    if (existing.length > 16) {
      // Already has a text layer — keep the original page untouched.
      const [copied] = await out.copyPages(srcDoc, [i]);
      out.addPage(copied);
      texts.push(existing);
      skipped++;
      continue;
    }

    const page = await getPage(source, i);
    const rotation = (page.rotate % 360 + 360) % 360;
    const viewport = page.getViewport({ scale, rotation });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, viewport }).promise;

    const ocr = await recognizeCanvas(canvas);
    texts.push(ocr.text);

    // Output page at the visible size in points.
    const vw = viewport.width / scale;
    const vh = viewport.height / scale;
    const outPage = out.addPage([vw, vh]);
    const jpeg = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("render failed"))), "image/jpeg", 0.82));
    const img = await out.embedJpg(new Uint8Array(await jpeg.arrayBuffer()));
    outPage.drawImage(img, { x: 0, y: 0, width: vw, height: vh });
    canvas.width = canvas.height = 0;

    // Invisible, selectable text positioned over each recognised word.
    const key = outPage.node.newFontDictionary(font.name, font.ref);
    const sx = vw / ocr.width;
    const sy = vh / ocr.height;
    const ops = [pushGraphicsState(), beginText(), setTextRenderingMode(TextRenderingMode.Invisible)];
    for (const w of ocr.words) {
      const text = encodable(font, w.text);
      if (!text.trim()) continue;
      const h = Math.max(1, (w.y1 - w.y0) * sy);
      const wWidth = Math.max(1, (w.x1 - w.x0) * sx);
      const size = h * 0.92;
      const natural = font.widthOfTextAtSize(text, size) || wWidth;
      // Horizontal scale so the invisible text spans the word box (good selection).
      const hScale = Math.min(4, Math.max(0.1, wWidth / natural));
      const x = w.x0 * sx;
      const y = vh - w.y1 * sy + h * 0.15;
      ops.push(
        setFontAndSize(key, size),
        setTextMatrix(hScale, 0, 0, 1, x, y),
        showText(font.encodeText(text)),
      );
    }
    ops.push(endText(), popGraphicsState());
    outPage.pushOperators(...ops);
    ocred++;
  }

  out.setProducer("Opus by Lykin");
  out.setModificationDate(new Date());
  const pdf = await out.save({ useObjectStreams: true });
  return { pdf, text: texts.join("\n\n").trim(), skipped, ocred };
}
