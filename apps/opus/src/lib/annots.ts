// Annotations the editor can place on a page, and how they're drawn into the PDF.
//
// Geometry is stored in "view space": origin at the page's top-left as the
// reader sees it, x to the right, y downward, measured in PDF points where the
// visible page is `vw` x `vh`. frameOf() maps that onto the real (possibly
// rotated) page, so a drawing stays put and upright whatever the page rotation.

import {
  PDFDocument, PDFFont, PDFPage, StandardFonts, degrees, rgb, LineCapStyle, BlendMode,
} from "@cantoo/pdf-lib";
import { frameOf } from "./tools.ts";
import { normalizeRotation } from "./pdfops.ts";
import { hexToRgb } from "./tools.ts";

export type AnnoType = "text" | "note" | "draw" | "line" | "rect" | "ellipse" | "highlight" | "image" | "redact";

export interface Point {
  x: number;
  y: number;
}

interface Base {
  id: string;
  type: AnnoType;
}
export interface BoxAnno extends Base {
  type: "text" | "note" | "rect" | "ellipse" | "highlight" | "image" | "redact";
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface TextAnno extends BoxAnno {
  type: "text" | "note";
  text: string;
  size: number;
  color: string;
  align: "left" | "center" | "right";
  bold: boolean;
  italic: boolean;
}
export interface ShapeAnno extends BoxAnno {
  type: "rect" | "ellipse";
  stroke: string;
  fill: string | null;
  width: number;
}
export interface MarkAnno extends BoxAnno {
  type: "highlight" | "redact";
  color?: string;
}
export interface ImageAnno extends BoxAnno {
  type: "image";
  imageId: string;
}
export interface DrawAnno extends Base {
  type: "draw";
  points: Point[];
  color: string;
  width: number;
}
export interface LineAnno extends Base {
  type: "line";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  width: number;
  arrow: boolean;
}
export type Anno = TextAnno | ShapeAnno | MarkAnno | ImageAnno | DrawAnno | LineAnno;

/** Image bytes referenced by image annotations, shared across a document. */
export interface ImageStore {
  [id: string]: { bytes: Uint8Array; type: "png" | "jpg" };
}

let counter = 0;
export function newAnnoId(): string {
  counter += 1;
  return `a${Date.now().toString(36)}${counter.toString(36)}`;
}

export function annoBox(a: Anno): { x: number; y: number; w: number; h: number } {
  if (a.type === "draw") {
    const xs = a.points.map((p) => p.x);
    const ys = a.points.map((p) => p.y);
    const x = Math.min(...xs), y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  }
  if (a.type === "line") {
    const x = Math.min(a.x1, a.x2), y = Math.min(a.y1, a.y2);
    return { x, y, w: Math.abs(a.x2 - a.x1), h: Math.abs(a.y2 - a.y1) };
  }
  return { x: a.x, y: a.y, w: a.w, h: a.h };
}

/** True when the page shows anything that must truly remove content (redaction). */
export function hasRedaction(list: Anno[] | undefined): boolean {
  return !!list?.some((a) => a.type === "redact");
}

// ---------- drawing onto a PDF page ----------

const STD = {
  reg: StandardFonts.Helvetica, bold: StandardFonts.HelveticaBold,
  italic: StandardFonts.HelveticaOblique, boldItalic: StandardFonts.HelveticaBoldOblique,
};

export interface FontSet {
  reg: PDFFont;
  bold: PDFFont;
  italic: PDFFont;
  boldItalic: PDFFont;
}

export async function embedFonts(doc: PDFDocument): Promise<FontSet> {
  const [reg, bold, italic, boldItalic] = await Promise.all([
    doc.embedFont(STD.reg), doc.embedFont(STD.bold), doc.embedFont(STD.italic), doc.embedFont(STD.boldItalic),
  ]);
  return { reg, bold, italic, boldItalic };
}

/** Replaces characters the standard fonts can't draw so text never throws. */
function safe(font: PDFFont, text: string): string {
  let out = "";
  for (const ch of text) {
    try {
      font.encodeText(ch);
      out += ch;
    } catch {
      out += ch === "\n" ? "\n" : "?";
    }
  }
  return out;
}

/** Wraps text to a width, honouring explicit line breaks. */
export function wrapText(font: PDFFont, text: string, size: number, maxWidth: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    if (para === "") {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of para.split(/(\s+)/)) {
      const test = line + word;
      if (line && font.widthOfTextAtSize(test, size) > maxWidth) {
        out.push(line.trimEnd());
        line = word.trimStart();
      } else {
        line = test;
      }
    }
    // Hard-break any single word that is still too wide.
    let rest = line;
    while (font.widthOfTextAtSize(rest, size) > maxWidth && rest.length > 1) {
      let cut = rest.length;
      while (cut > 1 && font.widthOfTextAtSize(rest.slice(0, cut), size) > maxWidth) cut--;
      out.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    out.push(rest);
  }
  return out;
}

export interface Frame {
  vw: number;
  vh: number;
  rotation: number;
  toPage(vx: number, vy: number): [number, number];
}

/** Maps a top-left-origin view point to PDF coordinates. */
function pt(f: Frame, vx: number, vyTop: number): [number, number] {
  return f.toPage(vx, f.vh - vyTop);
}

function col(hex: string) {
  const [r, g, b] = hexToRgb(hex);
  return rgb(r, g, b);
}

/** Draws every annotation of a page onto the (already rotated) PDF page. */
export async function drawAnnotations(
  doc: PDFDocument,
  page: PDFPage,
  list: Anno[],
  fonts: FontSet,
  images: ImageStore,
): Promise<void> {
  const f = frameOf(page) as Frame;
  const rot = degrees(f.rotation);

  for (const a of list) {
    switch (a.type) {
      case "highlight":
        drawAxisRect(page, f, a.x, a.y, a.w, a.h, {
          color: col(a.color ?? "#ffd54a"), opacity: 0.4, blendMode: BlendMode.Multiply,
        });
        break;
      case "rect":
        drawAxisRect(page, f, a.x, a.y, a.w, a.h, {
          borderColor: col(a.stroke), borderWidth: a.width,
          color: a.fill ? col(a.fill) : undefined, opacity: a.fill ? 1 : undefined,
        });
        break;
      case "ellipse": {
        const cx = a.x + a.w / 2, cy = a.y + a.h / 2;
        const [px, py] = pt(f, cx, cy);
        const swap = f.rotation === 90 || f.rotation === 270;
        page.drawEllipse({
          x: px, y: py,
          xScale: (swap ? a.h : a.w) / 2, yScale: (swap ? a.w : a.h) / 2,
          borderColor: col(a.stroke), borderWidth: a.width,
          color: a.fill ? col(a.fill) : undefined,
        });
        break;
      }
      case "line": {
        const [sx, sy] = pt(f, a.x1, a.y1);
        const [ex, ey] = pt(f, a.x2, a.y2);
        page.drawLine({ start: { x: sx, y: sy }, end: { x: ex, y: ey }, thickness: a.width, color: col(a.color), lineCap: LineCapStyle.Round });
        if (a.arrow) drawArrowHead(page, sx, sy, ex, ey, a.width, col(a.color));
        break;
      }
      case "draw": {
        if (a.points.length < 2) break;
        // A chain of straight segments — reliable at any page rotation, and a
        // dense point stream reads as a smooth stroke.
        const mapped = a.points.map((p) => pt(f, p.x, p.y));
        const color = col(a.color);
        for (let i = 1; i < mapped.length; i++) {
          page.drawLine({
            start: { x: mapped[i - 1][0], y: mapped[i - 1][1] },
            end: { x: mapped[i][0], y: mapped[i][1] },
            thickness: a.width, color, lineCap: LineCapStyle.Round,
          });
        }
        break;
      }
      case "image": {
        const img = images[a.imageId];
        if (!img) break;
        const embedded = img.type === "png" ? await doc.embedPng(img.bytes) : await doc.embedJpg(img.bytes);
        drawCentered(page, f, a.x + a.w / 2, a.y + a.h / 2, a.w, a.h, rot, (cx, cy, w, h) =>
          page.drawImage(embedded, { x: cx, y: cy, width: w, height: h, rotate: rot }),
        );
        break;
      }
      case "redact":
        // The real removal happens by rasterizing the page elsewhere; this is
        // the visible black box, drawn opaque so it's correct even if raster is skipped.
        drawAxisRect(page, f, a.x, a.y, a.w, a.h, { color: rgb(0, 0, 0), opacity: 1 });
        break;
      case "text":
      case "note":
        drawTextBox(page, f, a, fonts, rot);
        break;
    }
  }
}

/** Draws an axis-aligned (in view space) rectangle, mapped onto the page. */
function drawAxisRect(
  page: PDFPage, f: Frame, vx: number, vy: number, vw: number, vh: number,
  opts: { color?: ReturnType<typeof rgb>; opacity?: number; borderColor?: ReturnType<typeof rgb>; borderWidth?: number; blendMode?: BlendMode },
) {
  // Map two opposite corners; on 90/270 rotation width/height swap.
  const [ax, ay] = pt(f, vx, vy + vh);
  const [bx, by] = pt(f, vx + vw, vy);
  page.drawRectangle({
    x: Math.min(ax, bx), y: Math.min(ay, by), width: Math.abs(bx - ax), height: Math.abs(by - ay),
    color: opts.color, opacity: opts.opacity, borderColor: opts.borderColor, borderWidth: opts.borderWidth,
    borderOpacity: opts.borderColor ? 1 : undefined, blendMode: opts.blendMode,
  });
}

/** Positions a centered, upright item (text/image) accounting for rotation. */
function drawCentered(
  _page: PDFPage, f: Frame, cxView: number, cyView: number, w: number, h: number, _rot: ReturnType<typeof degrees>,
  draw: (x: number, y: number, w: number, h: number) => void,
) {
  const rad = (f.rotation * Math.PI) / 180;
  const [pcx, pcy] = pt(f, cxView, cyView);
  // Bottom-left corner of the upright box, rotated about its center.
  const hx = -w / 2, hy = -h / 2;
  const rx = hx * Math.cos(rad) - hy * Math.sin(rad);
  const ry = hx * Math.sin(rad) + hy * Math.cos(rad);
  draw(pcx + rx, pcy + ry, w, h);
}

function drawTextBox(page: PDFPage, f: Frame, a: TextAnno, fonts: FontSet, rot: ReturnType<typeof degrees>) {
  const font = a.bold && a.italic ? fonts.boldItalic : a.bold ? fonts.bold : a.italic ? fonts.italic : fonts.reg;
  const pad = a.type === "note" ? 8 : 2;
  if (a.type === "note") {
    drawAxisRect(page, f, a.x, a.y, a.w, a.h, { color: col(a.color ? tint(a.color) : "#fff4c2"), opacity: 0.95 });
    drawAxisRect(page, f, a.x, a.y, a.w, a.h, { borderColor: col(a.color ?? "#d8b062"), borderWidth: 1 });
  }
  const text = safe(font, a.text);
  const lineH = a.size * 1.2;
  const maxW = Math.max(4, a.w - pad * 2);
  const lines = wrapText(font, text, a.size, maxW);
  lines.forEach((line, i) => {
    const lw = font.widthOfTextAtSize(line, a.size);
    const offX = a.align === "center" ? (maxW - lw) / 2 : a.align === "right" ? maxW - lw : 0;
    // Baseline of this line, top-down, in view space.
    const vxLeft = a.x + pad + offX;
    const vyBase = a.y + pad + i * lineH + a.size;
    drawCentered(page, f, vxLeft + lw / 2, vyBase - a.size * 0.72, lw, a.size, rot, (x, y) =>
      page.drawText(line, { x, y, size: a.size, font, color: col(a.color === "#fff4c2" ? "#333333" : a.type === "note" ? "#333333" : a.color), rotate: rot }),
    );
  });
}

function tint(hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  const m = (c: number) => Math.round((c * 255 * 0.25 + 255 * 0.75));
  return `#${[m(r), m(g), m(b)].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

function drawArrowHead(page: PDFPage, sx: number, sy: number, ex: number, ey: number, width: number, color: ReturnType<typeof rgb>) {
  const ang = Math.atan2(ey - sy, ex - sx);
  const len = 8 + width * 2.2;
  const spread = 0.42;
  for (const s of [spread, -spread]) {
    page.drawLine({
      start: { x: ex, y: ey },
      end: { x: ex - len * Math.cos(ang - s), y: ey - len * Math.sin(ang - s) },
      thickness: width, color, lineCap: LineCapStyle.Round,
    });
  }
}

export { normalizeRotation };
