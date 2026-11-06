// Pure PDF tool engines (no UI, no disk). Each takes bytes in, gives bytes out.
// Tested in Node by tests/run.ts.

import {
  PDFDocument, PDFPage, StandardFonts, degrees, rgb, type PDFFont, type PDFImage,
} from "@cantoo/pdf-lib";
import { normalizeRotation } from "./pdfops.ts";

// ---------- coordinates on rotated pages ----------
// People think in the page as they see it ("bottom right"), but a page can be
// stored rotated. These helpers convert "as seen" coordinates to the page's own.

interface Frame {
  /** Visible size as seen on screen. */
  vw: number;
  vh: number;
  rotation: number;
  toPage(vx: number, vy: number): [number, number];
}

export function frameOf(page: PDFPage): Frame {
  const box = page.getCropBox();
  const r = normalizeRotation(page.getRotation().angle);
  const { x: ox, y: oy, width: W, height: H } = box;
  const swap = r === 90 || r === 270;
  return {
    vw: swap ? H : W,
    vh: swap ? W : H,
    rotation: r,
    toPage(vx, vy) {
      switch (r) {
        case 90: return [ox + W - vy, oy + vx];
        case 180: return [ox + W - vx, oy + H - vy];
        case 270: return [ox + vy, oy + H - vx];
        default: return [ox + vx, oy + vy];
      }
    },
  };
}

function rotate([x, y]: [number, number], deg: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];
}

interface TextOpts {
  font: PDFFont;
  size: number;
  color: [number, number, number];
  opacity?: number;
  /** Counter-clockwise rotation as seen, in degrees. */
  angle?: number;
}

/** Draws text centered on a visual point, upright as seen by the reader. */
function drawTextCentered(page: PDFPage, f: Frame, text: string, cx: number, cy: number, o: TextOpts) {
  const w = o.font.widthOfTextAtSize(text, o.size);
  const h = o.font.heightAtSize(o.size, { descender: false });
  const angle = o.angle ?? 0;
  const [dx, dy] = rotate([w / 2, h / 2], angle);
  const [x, y] = f.toPage(cx - dx, cy - dy);
  page.drawText(text, {
    x, y, size: o.size, font: o.font,
    color: rgb(...o.color),
    opacity: o.opacity ?? 1,
    rotate: degrees(angle + f.rotation),
  });
}

function drawImageCentered(
  page: PDFPage, f: Frame, img: PDFImage, cx: number, cy: number, w: number, h: number, angle: number, opacity: number,
) {
  const [dx, dy] = rotate([w / 2, h / 2], angle);
  const [x, y] = f.toPage(cx - dx, cy - dy);
  page.drawImage(img, { x, y, width: w, height: h, rotate: degrees(angle + f.rotation), opacity });
}

const load = (bytes: Uint8Array) => PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: false });
const saveDoc = (doc: PDFDocument) => {
  doc.setProducer("Opus by Lykin");
  doc.setModificationDate(new Date());
  return doc.save({ useObjectStreams: true });
};

export function hexToRgb(hex: string): [number, number, number] {
  const m = hex.replace("#", "").match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return [0, 0, 0];
  return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255];
}

/** Which pages (0-based) a "pages" option selects. */
export function selectPages(count: number, which: "all" | "odd" | "even" | "skip-first" | number[]): number[] {
  const all = Array.from({ length: count }, (_, i) => i);
  if (Array.isArray(which)) return which.filter((i) => i >= 0 && i < count);
  if (which === "odd") return all.filter((i) => i % 2 === 0);
  if (which === "even") return all.filter((i) => i % 2 === 1);
  if (which === "skip-first") return all.slice(1);
  return all;
}

// ---------- page numbers ----------

export type Position = "top-left" | "top-center" | "top-right" | "bottom-left" | "bottom-center" | "bottom-right";

export interface PageNumberOptions {
  position: Position;
  /** Use {n} for the number and {total} for the page count. */
  format: string;
  start: number;
  size: number;
  marginMm: number;
  color: string;
  pages: "all" | "skip-first" | number[];
  font: "sans" | "serif" | "mono";
}

const FONT_MAP = {
  sans: StandardFonts.Helvetica,
  serif: StandardFonts.TimesRoman,
  mono: StandardFonts.Courier,
} as const;

const MM = 72 / 25.4;

/** Standard PDF fonts can only draw Latin-1 text; replace anything else. */
function safeText(font: PDFFont, text: string): string {
  return [...text]
    .map((ch) => {
      try {
        font.encodeText(ch);
        return ch;
      } catch {
        return "?";
      }
    })
    .join("");
}

export async function addPageNumbers(bytes: Uint8Array, o: PageNumberOptions): Promise<Uint8Array> {
  const doc = await load(bytes);
  const font = await doc.embedFont(FONT_MAP[o.font]);
  const pages = doc.getPages();
  const chosen = new Set(selectPages(pages.length, o.pages));
  const total = chosen.size;
  let n = o.start;
  pages.forEach((page, i) => {
    if (!chosen.has(i)) return;
    const f = frameOf(page);
    const label = safeText(font, o.format.replace(/\{n\}/g, String(n)).replace(/\{total\}/g, String(total + o.start - 1)));
    n++;
    const m = o.marginMm * MM;
    const w = font.widthOfTextAtSize(label, o.size);
    const [v, h] = o.position.split("-") as ["top" | "bottom", "left" | "center" | "right"];
    const cy = v === "top" ? f.vh - m - o.size / 2 : m + o.size / 2;
    const cx = h === "left" ? m + w / 2 : h === "right" ? f.vw - m - w / 2 : f.vw / 2;
    drawTextCentered(page, f, label, cx, cy, { font, size: o.size, color: hexToRgb(o.color) });
  });
  return saveDoc(doc);
}

// ---------- watermark ----------

export interface WatermarkOptions {
  kind: "text" | "image";
  text: string;
  image?: { bytes: Uint8Array; type: "png" | "jpg" };
  /** Image width as a fraction of page width (0.05–1). */
  imageScale: number;
  size: number;
  color: string;
  opacity: number;
  angle: number;
  layout: "center" | "tile" | Position;
  pages: "all" | "odd" | "even" | "skip-first" | number[];
  bold: boolean;
}

export async function addWatermark(bytes: Uint8Array, o: WatermarkOptions): Promise<Uint8Array> {
  const doc = await load(bytes);
  const font = await doc.embedFont(o.bold ? StandardFonts.HelveticaBold : StandardFonts.Helvetica);
  let img: PDFImage | undefined;
  if (o.kind === "image") {
    if (!o.image) throw new Error("Choose an image for the watermark");
    img = o.image.type === "png" ? await doc.embedPng(o.image.bytes) : await doc.embedJpg(o.image.bytes);
  }
  const text = safeText(font, o.text.trim() || "CONFIDENTIAL");
  const pages = doc.getPages();
  for (const i of selectPages(pages.length, o.pages)) {
    const page = pages[i];
    const f = frameOf(page);
    let w: number, h: number;
    if (img) {
      w = f.vw * o.imageScale;
      h = (w * img.height) / img.width;
    } else {
      w = font.widthOfTextAtSize(text, o.size);
      h = o.size;
    }
    const draw = (cx: number, cy: number) =>
      img
        ? drawImageCentered(page, f, img, cx, cy, w, h, o.angle, o.opacity)
        : drawTextCentered(page, f, text, cx, cy, { font, size: o.size, color: hexToRgb(o.color), opacity: o.opacity, angle: o.angle });

    if (o.layout === "center") draw(f.vw / 2, f.vh / 2);
    else if (o.layout === "tile") {
      // Lay copies out in rows that follow the text's own direction, then
      // rotate that grid onto the page. Rows never overlap at any angle.
      const du = w + Math.max(40, h * 1.5);
      const dv = h * 3.2;
      const diag = Math.hypot(f.vw, f.vh) / 2 + w;
      const [ux, uy] = rotate([1, 0], o.angle);
      const [vx, vy] = rotate([0, 1], o.angle);
      for (let row = -Math.ceil(diag / dv); row <= Math.ceil(diag / dv); row++) {
        const shift = (row % 2) * du * 0.5;
        for (let col = -Math.ceil(diag / du) - 1; col <= Math.ceil(diag / du) + 1; col++) {
          const u = col * du + shift, v = row * dv;
          const cx = f.vw / 2 + u * ux + v * vx;
          const cy = f.vh / 2 + u * uy + v * vy;
          if (cx < -w / 2 || cx > f.vw + w / 2 || cy < -w / 2 || cy > f.vh + w / 2) continue;
          draw(cx, cy);
        }
      }
    } else {
      const m = 30;
      const [v, hz] = o.layout.split("-");
      const cy = v === "top" ? f.vh - m - h / 2 : m + h / 2;
      const cx = hz === "left" ? m + w / 2 : hz === "right" ? f.vw - m - w / 2 : f.vw / 2;
      draw(cx, cy);
    }
  }
  return saveDoc(doc);
}

// ---------- crop ----------

export interface CropOptions {
  /** Margins to cut off, in millimetres, as the page is seen. */
  top: number;
  right: number;
  bottom: number;
  left: number;
  pages: "all" | "odd" | "even" | "skip-first" | number[];
}

export async function cropPages(bytes: Uint8Array, o: CropOptions): Promise<Uint8Array> {
  const doc = await load(bytes);
  const pages = doc.getPages();
  for (const i of selectPages(pages.length, o.pages)) {
    const page = pages[i];
    const f = frameOf(page);
    const l = o.left * MM, r = o.right * MM, t = o.top * MM, b = o.bottom * MM;
    if (l + r >= f.vw - 10 || t + b >= f.vh - 10) {
      throw new Error(`The margins are larger than page ${i + 1}`);
    }
    const [x1, y1] = f.toPage(l, b);
    const [x2, y2] = f.toPage(f.vw - r, f.vh - t);
    const box = { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
    page.setCropBox(box.x, box.y, box.w, box.h);
    page.setTrimBox(box.x, box.y, box.w, box.h);
  }
  return saveDoc(doc);
}

// ---------- images → PDF ----------

export interface ImageInput {
  bytes: Uint8Array;
  type: "png" | "jpg";
  width: number;
  height: number;
}

export interface ImagesToPdfOptions {
  pageSize: "fit" | "a4" | "letter";
  orientation: "auto" | "portrait" | "landscape";
  marginMm: number;
}

const SIZES = { a4: [595.28, 841.89], letter: [612, 792] } as const;

export async function imagesToPdf(images: ImageInput[], o: ImagesToPdfOptions): Promise<Uint8Array> {
  if (!images.length) throw new Error("Add at least one image");
  const doc = await PDFDocument.create();
  for (const im of images) {
    const img = im.type === "png" ? await doc.embedPng(im.bytes) : await doc.embedJpg(im.bytes);
    const m = o.marginMm * MM;
    let pw: number, ph: number;
    if (o.pageSize === "fit") {
      // 1 image pixel = 0.75 pt (96 dpi), so photos print at a sensible size.
      pw = img.width * 0.75 + 2 * m;
      ph = img.height * 0.75 + 2 * m;
    } else {
      [pw, ph] = SIZES[o.pageSize];
      const landscape = o.orientation === "landscape" || (o.orientation === "auto" && img.width > img.height);
      if (landscape) [pw, ph] = [ph, pw];
    }
    const page = doc.addPage([pw, ph]);
    const scale = Math.min((pw - 2 * m) / img.width, (ph - 2 * m) / img.height);
    const w = img.width * scale, h = img.height * scale;
    page.drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
  }
  return saveDoc(doc);
}

// ---------- simple whole-document tools ----------

/** Re-saves a PDF through pdf-lib's tolerant parser (fixes many broken files). */
export async function resave(bytes: Uint8Array): Promise<Uint8Array> {
  const doc = await load(bytes);
  if (doc.getPageCount() === 0) throw new Error("No readable pages were found in this file");
  return saveDoc(doc);
}

export interface DocInfo {
  title: string;
  author: string;
  subject: string;
  keywords: string;
}

export async function readInfo(bytes: Uint8Array): Promise<DocInfo> {
  const doc = await load(bytes);
  return {
    title: doc.getTitle() ?? "",
    author: doc.getAuthor() ?? "",
    subject: doc.getSubject() ?? "",
    keywords: doc.getKeywords() ?? "",
  };
}

export async function writeInfo(bytes: Uint8Array, info: DocInfo): Promise<Uint8Array> {
  const doc = await load(bytes);
  doc.setTitle(info.title);
  doc.setAuthor(info.author);
  doc.setSubject(info.subject);
  doc.setKeywords(info.keywords.split(",").map((k) => k.trim()).filter(Boolean));
  return saveDoc(doc);
}

/** Flattens fillable form fields into plain page content. */
export async function flattenForms(bytes: Uint8Array): Promise<Uint8Array> {
  const doc = await load(bytes);
  const form = doc.getForm();
  if (form.getFields().length === 0) throw new Error("This PDF has no form fields to flatten");
  form.flatten();
  return saveDoc(doc);
}

/** Adds blank pages: after every page, or at the end. */
export async function insertBlank(bytes: Uint8Array, where: "end" | "start" | "between"): Promise<Uint8Array> {
  const doc = await load(bytes);
  const size = doc.getPage(0).getSize();
  if (where === "end") doc.addPage([size.width, size.height]);
  else if (where === "start") doc.insertPage(0, [size.width, size.height]);
  else {
    const n = doc.getPageCount();
    for (let i = n - 1; i > 0; i--) {
      const s = doc.getPage(i - 1).getSize();
      doc.insertPage(i, [s.width, s.height]);
    }
  }
  return saveDoc(doc);
}

/** Reverses page order. */
export async function reversePages(bytes: Uint8Array): Promise<Uint8Array> {
  const src = await load(bytes);
  const out = await PDFDocument.create();
  const pages = await out.copyPages(src, src.getPageIndices().reverse());
  pages.forEach((p) => out.addPage(p));
  return saveDoc(out);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 2 : 1)} MB`;
}
