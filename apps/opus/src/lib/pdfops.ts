// Core PDF operations for Opus. Pure functions: no UI, no file system.
// Everything here can be unit-tested in Node (see tests/run.ts).

import { PDFDocument, PDFDict, PDFName, PDFRawStream, degrees } from "@cantoo/pdf-lib";

/** One page in the working document, pointing back at the file it came from. */
export interface PageRef {
  /** Unique id for this page slot (stable across reorders; used as React key). */
  key: string;
  /** Which loaded source file the page comes from. */
  sourceId: string;
  /** 0-based page index inside that source. */
  index: number;
  /** Extra rotation applied by the user, in degrees (0, 90, 180, 270). */
  rotation: number;
}

export interface Source {
  id: string;
  name: string;
  /** Unencrypted bytes of the file (already decrypted if it had a password). */
  bytes: Uint8Array;
  pageCount: number;
  /** The original rotation stored in the file for each page. */
  baseRotations: number[];
}

export class PasswordRequiredError extends Error {
  wrongPassword: boolean;
  constructor(wrongPassword: boolean) {
    super(wrongPassword ? "Incorrect password" : "This PDF is password-protected");
    this.wrongPassword = wrongPassword;
    this.name = "PasswordRequiredError";
  }
}

export class NotAPdfError extends Error {
  constructor(message = "This file is not a valid PDF") {
    super(message);
    this.name = "NotAPdfError";
  }
}

let counter = 0;
export function newId(prefix: string): string {
  counter += 1;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function normalizeRotation(deg: number): number {
  return (((Math.round(deg / 90) * 90) % 360) + 360) % 360;
}

function looksLikePdf(bytes: Uint8Array): boolean {
  // The "%PDF-" header must appear within the first 1024 bytes.
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  return head.includes("%PDF-");
}

function isPasswordError(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err).toLowerCase();
  return msg.includes("password") || msg.includes("encrypt") || msg.includes("decrypt");
}

/**
 * Loads a PDF file. If it is password-protected, `password` must be given;
 * the returned bytes are always the decrypted (unlocked) version.
 */
export async function loadSource(
  bytes: Uint8Array,
  name: string,
  password?: string,
): Promise<Source> {
  if (!looksLikePdf(bytes)) throw new NotAPdfError();

  const base = { updateMetadata: false, throwOnInvalidObject: false } as const;
  let doc: PDFDocument;
  try {
    // First pass: just parse the file structure, without decrypting.
    doc = await PDFDocument.load(bytes, { ...base, ignoreEncryption: true });
  } catch (err) {
    throw new NotAPdfError(`Could not read this PDF: ${(err as Error).message ?? err}`);
  }

  let clean = bytes;
  if (doc.isEncrypted) {
    // Many "protected" PDFs use an empty open-password (they open without
    // asking but restrict editing). Try that first when no password is given.
    let decrypted: PDFDocument;
    try {
      decrypted = await PDFDocument.load(bytes, { ...base, password: password ?? "" });
    } catch (err) {
      if (password === undefined || isPasswordError(err)) {
        throw new PasswordRequiredError(password !== undefined);
      }
      throw new NotAPdfError(`Could not unlock this PDF: ${(err as Error).message ?? err}`);
    }
    clean = await saveDecrypted(decrypted, doc).catch(() => copyIntoFresh(decrypted));
    doc = await PDFDocument.load(clean, base);
  }

  const pages = doc.getPages();
  if (pages.length === 0) throw new NotAPdfError("This PDF has no pages");

  return {
    id: newId("s"),
    name,
    bytes: clean,
    pageCount: pages.length,
    baseRotations: pages.map((p) => normalizeRotation(p.getRotation().angle)),
  };
}

/**
 * Saves a decrypted document without its encryption, keeping everything
 * else (bookmarks, links, forms). `raw` is the same file parsed without decrypting.
 */
async function saveDecrypted(decrypted: PDFDocument, raw: PDFDocument): Promise<Uint8Array> {
  const encRef = raw.context.trailerInfo.Encrypt;
  for (const [ref, obj] of decrypted.context.enumerateIndirectObjects()) {
    // Old cross-reference streams still mention the encryption; drop them
    // (they are rebuilt on save).
    const dict = obj instanceof PDFRawStream ? obj.dict : obj instanceof PDFDict ? obj : null;
    if (dict?.get(PDFName.of("Type")) === PDFName.of("XRef")) decrypted.context.delete(ref);
  }
  if (encRef && "objectNumber" in (encRef as object)) decrypted.context.delete(encRef as never);
  const out = await decrypted.save({ useObjectStreams: true });
  const check = await PDFDocument.load(out, { updateMetadata: false });
  if (check.isEncrypted || check.getPageCount() !== decrypted.getPageCount()) throw new Error("decrypt check failed");
  return out;
}

/** Fallback: copy just the pages into a brand-new unencrypted document. */
async function copyIntoFresh(decrypted: PDFDocument): Promise<Uint8Array> {
  const fresh = await PDFDocument.create();
  const copied = await fresh.copyPages(decrypted, decrypted.getPageIndices());
  copied.forEach((p) => fresh.addPage(p));
  const title = decrypted.getTitle();
  const author = decrypted.getAuthor();
  if (title) fresh.setTitle(title);
  if (author) fresh.setAuthor(author);
  return fresh.save({ useObjectStreams: true });
}

/** Creates page refs for every page of a source, in order. */
export function pagesOf(source: Source): PageRef[] {
  return Array.from({ length: source.pageCount }, (_, i) => ({
    key: newId("p"),
    sourceId: source.id,
    index: i,
    rotation: 0,
  }));
}

export interface BuildOptions {
  /** If set, the output is encrypted (AES-256) with this password. */
  password?: string;
  title?: string;
}

/**
 * Builds a brand-new PDF from a list of pages taken from any loaded sources.
 * This is used for Save, Merge, Split and Extract alike.
 */
export async function buildPdf(
  pages: PageRef[],
  sources: Map<string, Source>,
  options: BuildOptions = {},
): Promise<Uint8Array> {
  if (pages.length === 0) throw new Error("There are no pages to save");

  // If the pages are exactly the original file's pages in their original
  // order, edit that file directly. This keeps bookmarks, links and form
  // fields, which are lost when pages are copied into a new file.
  const first = sources.get(pages[0].sourceId);
  if (first && pages.length === first.pageCount && pages.every((p, i) => p.sourceId === first.id && p.index === i)) {
    const doc = await PDFDocument.load(first.bytes, { updateMetadata: false, throwOnInvalidObject: false });
    doc.getPages().forEach((page, i) => {
      page.setRotation(degrees(normalizeRotation(first.baseRotations[i] + pages[i].rotation)));
    });
    return finish(doc, options);
  }

  const out = await PDFDocument.create();
  const loaded = new Map<string, PDFDocument>();

  // Copy pages grouped by source for speed, but keep the final order.
  const copied = new Map<string, Awaited<ReturnType<PDFDocument["copyPages"]>>[number]>();
  const bySource = new Map<string, number[]>();
  for (const p of pages) {
    const list = bySource.get(p.sourceId) ?? [];
    if (!list.includes(p.index)) list.push(p.index);
    bySource.set(p.sourceId, list);
  }
  for (const [sourceId, indices] of bySource) {
    const source = sources.get(sourceId);
    if (!source) throw new Error("A page refers to a file that is no longer open");
    let doc = loaded.get(sourceId);
    if (!doc) {
      doc = await PDFDocument.load(source.bytes, { updateMetadata: false, throwOnInvalidObject: false });
      loaded.set(sourceId, doc);
    }
    const result = await out.copyPages(doc, indices);
    indices.forEach((idx, i) => copied.set(`${sourceId}:${idx}`, result[i]));
  }

  // A page used twice must be copied twice (a PDF page object can appear only once).
  const used = new Set<string>();
  for (const p of pages) {
    const id = `${p.sourceId}:${p.index}`;
    let page = copied.get(id)!;
    if (used.has(id)) {
      const doc = loaded.get(p.sourceId)!;
      [page] = await out.copyPages(doc, [p.index]);
    }
    used.add(id);
    const base = sources.get(p.sourceId)!.baseRotations[p.index] ?? 0;
    page.setRotation(degrees(normalizeRotation(base + p.rotation)));
    out.addPage(page);
  }

  return finish(out, options);
}

async function finish(out: PDFDocument, options: BuildOptions): Promise<Uint8Array> {
  if (options.title) out.setTitle(options.title);
  out.setProducer("Opus by Lykin");
  out.setModificationDate(new Date());

  if (options.password) {
    out.encrypt({
      userPassword: options.password,
      ownerPassword: options.password,
      permissions: {
        printing: "highResolution",
        modifying: true,
        copying: true,
        annotating: true,
        fillingForms: true,
        contentAccessibility: true,
        documentAssembly: true,
      },
    });
  }

  return out.save({ useObjectStreams: true });
}

/**
 * Parses page ranges typed by a person, e.g. "1-3, 5, 8-" (1-based).
 * Each comma-separated part becomes one group (one output file when splitting).
 * Returns 0-based indices. Throws a friendly error on bad input.
 */
export function parseRanges(text: string, pageCount: number): number[][] {
  const groups: number[][] = [];
  const parts = text.split(/[,;]+/).map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) throw new Error("Type at least one page or range, like 1-3, 5");

  for (const part of parts) {
    const m = part.match(/^(\d*)\s*(?:-|–|to)\s*(\d*)$/i);
    let start: number;
    let end: number;
    if (m) {
      start = m[1] ? parseInt(m[1], 10) : 1;
      end = m[2] ? parseInt(m[2], 10) : pageCount;
    } else if (/^\d+$/.test(part)) {
      start = end = parseInt(part, 10);
    } else {
      throw new Error(`"${part}" is not a page or range`);
    }
    if (start < 1 || end < 1 || start > pageCount || end > pageCount) {
      throw new Error(`"${part}" is outside this document (pages 1–${pageCount})`);
    }
    const group: number[] = [];
    const step = start <= end ? 1 : -1;
    for (let i = start; step > 0 ? i <= end : i >= end; i += step) group.push(i - 1);
    groups.push(group);
  }
  return groups;
}

/** Splits [0..pageCount) into chunks of `size` pages. */
export function chunkPages(pageCount: number, size: number): number[][] {
  if (!Number.isFinite(size) || size < 1) throw new Error("Pages per file must be 1 or more");
  const groups: number[][] = [];
  for (let i = 0; i < pageCount; i += size) {
    groups.push(Array.from({ length: Math.min(size, pageCount - i) }, (_, k) => i + k));
  }
  return groups;
}

/** Makes a file name safe for Windows and strips a trailing .pdf. */
export function baseName(name: string): string {
  const just = name.split(/[\\/]/).pop() ?? name;
  return just.replace(/\.pdf$/i, "").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim() || "document";
}

/** Formats page groups as a human label: "pages 1-3". */
export function describeGroup(group: number[]): string {
  if (group.length === 1) return `page ${group[0] + 1}`;
  const contiguous = group.every((v, i) => i === 0 || v === group[i - 1] + 1);
  return contiguous ? `pages ${group[0] + 1}-${group[group.length - 1] + 1}` : `${group.length} pages`;
}
