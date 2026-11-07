// PDF → Excel. Reconstructs a table from the text on each page by grouping
// words into rows (shared baseline) and columns (shared x position), then
// writes one worksheet per page. Works best on real tables and grids; free-form
// prose comes out as rows of text. Scanned pages (no text) are reported.

import ExcelJS from "exceljs";
import type { Source } from "./pdfops";
import { getPage } from "./render";

interface Word {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface PageTable {
  rows: string[][];
  wordCount: number;
}

/** Pulls positioned words from a page (top-left origin, PDF points). */
async function pageWords(source: Source, index: number): Promise<{ words: Word[]; height: number }> {
  const page = await getPage(source, index);
  const vp = page.getViewport({ scale: 1, rotation: page.rotate });
  const content = await page.getTextContent();
  const words: Word[] = [];
  for (const item of content.items) {
    if (!("str" in item) || !item.str.trim()) continue;
    // transform = [a,b,c,d,e,f]; e,f is the text origin in PDF space.
    const [, , , , e, f] = item.transform as number[];
    const h = Math.abs(item.height) || Math.abs((item.transform as number[])[3]) || 10;
    // Convert to top-left origin using the (rotated) viewport.
    const [vx, vy] = vp.convertToViewportPoint(e, f);
    words.push({ text: item.str, x: vx, y: vy - h, w: item.width || item.str.length * h * 0.5, h });
  }
  return { words, height: vp.height };
}

/**
 * Finds column boundaries from vertical whitespace: the x positions where NO
 * word has ink across the whole page. This groups a column by the band it
 * occupies, so right-aligned number columns stay together (clustering by a
 * word's left edge splits them).
 */
function columnBoundaries(words: Word[], medianH: number): number[] {
  if (words.length < 2) return [];
  const minX = Math.min(...words.map((w) => w.x));
  const maxX = Math.max(...words.map((w) => w.x + w.w));
  const binW = Math.max(1.5, medianH * 0.25);
  const bins = Math.ceil((maxX - minX) / binW) + 1;
  const occ = new Array(bins).fill(false);
  for (const w of words) {
    const a = Math.max(0, Math.floor((w.x - minX) / binW));
    const b = Math.min(bins, Math.ceil((w.x + w.w - minX) / binW));
    for (let i = a; i < b; i++) occ[i] = true;
  }
  // A real column gap is wider than a normal inter-word space.
  const gapBins = Math.max(2, Math.round((medianH * 1.1) / binW));
  const boundaries: number[] = [];
  let i = 0;
  while (i < bins && !occ[i]) i++; // skip the left margin
  while (i < bins) {
    while (i < bins && occ[i]) i++; // walk through an occupied band
    let k = i;
    while (k < bins && !occ[k]) k++; // measure the gap
    if (k < bins && k - i >= gapBins) boundaries.push(minX + ((i + k) / 2) * binW);
    i = k;
  }
  return boundaries;
}

function buildTable(words: Word[]): PageTable {
  if (!words.length) return { rows: [], wordCount: 0 };
  const heights = [...words].map((w) => w.h).sort((a, b) => a - b);
  const medianH = heights[Math.floor(heights.length / 2)] || 10;

  // Rows: group by baseline (y), tolerance ~ 60% of text height.
  const rowTol = medianH * 0.6;
  const byY = [...words].sort((a, b) => a.y - b.y);
  const rows: Word[][] = [];
  for (const w of byY) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(w.y - row[0].y) <= rowTol) row.push(w);
    else rows.push([w]);
  }

  const boundaries = columnBoundaries(words, medianH);
  const columnOf = (w: Word) => {
    const cx = w.x + w.w / 2;
    let c = 0;
    for (const b of boundaries) if (cx > b) c++;
    return c;
  };

  const out: string[][] = [];
  for (const row of rows) {
    const cells: string[] = new Array(boundaries.length + 1).fill("");
    for (const w of row.sort((a, b) => a.x - b.x)) {
      const c = columnOf(w);
      cells[c] = cells[c] ? `${cells[c]} ${w.text}` : w.text;
    }
    let end = cells.length;
    while (end > 0 && cells[end - 1] === "") end--;
    out.push(cells.slice(0, end));
  }
  return { rows: out, wordCount: words.length };
}

/**
 * Turns a numeric-looking cell into a real number (so Excel can sum it), with a
 * display format so currency and percentages still look right.
 */
function asCell(text: string): { value: string | number; numFmt?: string } {
  const t = text.trim();
  // Optional leading currency symbol, thousands separators, decimals, trailing %.
  const m = t.match(/^([-+(]?)\s*([$€£¥]?)\s*([\d,]*\.?\d+)\s*(%?)\s*(\)?)$/);
  if (m && /\d/.test(t)) {
    let n = Number(m[3].replace(/,/g, ""));
    if (Number.isFinite(n)) {
      if (m[1] === "(" && m[5] === ")") n = -n; // (123) accounting negative
      else if (m[1] === "-") n = -n;
      if (m[4] === "%") return { value: n, numFmt: "0.##\\%" };
      if (m[2]) return { value: n, numFmt: `"${m[2]}"#,##0.00` };
      return { value: n };
    }
  }
  return { value: text };
}

export interface ExcelResult {
  bytes: Uint8Array;
  pagesWithText: number;
  emptyPages: number;
}

export async function pdfToExcel(
  source: Source,
  opts: { onProgress?: (done: number, total: number) => void } = {},
): Promise<ExcelResult> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Opus by Lykin";
  let pagesWithText = 0;
  let emptyPages = 0;

  for (let i = 0; i < source.pageCount; i++) {
    opts.onProgress?.(i + 1, source.pageCount);
    const { words } = await pageWords(source, i);
    const table = buildTable(words);
    const ws = wb.addWorksheet(`Page ${i + 1}`, { views: [{ state: "frozen", ySplit: 0 }] });
    if (!table.rows.length) {
      emptyPages++;
      continue;
    }
    pagesWithText++;
    let maxCols = 0;
    for (const row of table.rows) {
      const cells = row.map(asCell);
      const added = ws.addRow(cells.map((c) => c.value));
      cells.forEach((c, i) => {
        if (c.numFmt) added.getCell(i + 1).numFmt = c.numFmt;
      });
      maxCols = Math.max(maxCols, row.length);
    }
    // Rough column widths from the longest cell in each column.
    for (let c = 1; c <= maxCols; c++) {
      let width = 8;
      ws.getColumn(c).eachCell({ includeEmpty: false }, (cell) => {
        width = Math.max(width, Math.min(60, String(cell.value ?? "").length + 2));
      });
      ws.getColumn(c).width = width;
    }
  }
  if (source.pageCount === 0) throw new Error("This PDF has no pages");

  const buf = await wb.xlsx.writeBuffer();
  return { bytes: new Uint8Array(buf as ArrayBuffer), pagesWithText, emptyPages };
}
