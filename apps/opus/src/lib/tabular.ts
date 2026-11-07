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

/** Clusters numbers that are within `tol` of each other into ordered groups. */
function cluster(values: number[], tol: number): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const centers: number[] = [];
  for (const v of sorted) {
    const last = centers[centers.length - 1];
    if (last === undefined || v - last > tol) centers.push(v);
    else centers[centers.length - 1] = (last + v) / 2;
  }
  return centers;
}

function buildTable(words: Word[]): PageTable {
  if (!words.length) return { rows: [], wordCount: 0 };
  const medianH = [...words].map((w) => w.h).sort((a, b) => a - b)[Math.floor(words.length / 2)] || 10;

  // Rows: group by baseline (y), tolerance ~ 60% of text height.
  const rowTol = medianH * 0.6;
  const byY = [...words].sort((a, b) => a.y - b.y);
  const rows: Word[][] = [];
  for (const w of byY) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(w.y - row[0].y) <= rowTol) row.push(w);
    else rows.push([w]);
  }

  // Columns: cluster the left edge of every word across the whole page.
  const colTol = medianH * 1.4;
  const colStarts = cluster(words.map((w) => w.x), colTol);
  const columnOf = (x: number) => {
    let best = 0, bestD = Infinity;
    for (let i = 0; i < colStarts.length; i++) {
      const d = Math.abs(x - colStarts[i]);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  };

  const out: string[][] = [];
  for (const row of rows) {
    const cells: string[] = new Array(colStarts.length).fill("");
    for (const w of row.sort((a, b) => a.x - b.x)) {
      const c = columnOf(w.x);
      cells[c] = cells[c] ? `${cells[c]} ${w.text}` : w.text;
    }
    // Trim trailing empty columns.
    let end = cells.length;
    while (end > 0 && cells[end - 1] === "") end--;
    out.push(cells.slice(0, end));
  }
  return { rows: out, wordCount: words.length };
}

/** If a cell is a plain number, store it as a number so Excel can sum it. */
function asCell(text: string): string | number {
  const t = text.trim();
  // e.g. 1,234.50  $1,234  (optional currency / thousands separators)
  if (/^[-+]?\$?[\d,]*\.?\d+%?$/.test(t) && /\d/.test(t)) {
    const n = Number(t.replace(/[$,%]/g, ""));
    if (Number.isFinite(n) && !t.endsWith("%") && !t.startsWith("$")) return n;
  }
  return text;
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
      ws.addRow(row.map(asCell));
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
