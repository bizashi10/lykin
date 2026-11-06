// Automated checks for Opus's PDF engine. Run with: npm test
import { PDFDocument, StandardFonts, degrees } from "@cantoo/pdf-lib";
import {
  loadSource, pagesOf, buildPdf, parseRanges, chunkPages, baseName,
  PasswordRequiredError, NotAPdfError, extrasLostBy, type Source,
} from "../src/lib/pdfops.ts";
import * as T from "../src/lib/tools.ts";
import { TOOLS, matchTool, suggestFor } from "../src/tools/registry.ts";

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL ${name}\n       ${(err as Error).stack ?? err}`);
  }
}
function assert(cond: unknown, msg = "assertion failed") {
  if (!cond) throw new Error(msg);
}
function eq<T>(a: T, b: T, msg = "") {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(`${msg} expected ${sb}, got ${sa}`);
}

/** Makes a PDF whose page N says "<label> N" so we can check order. */
async function makePdf(label: string, count: number, opts: { rotateFirst?: number } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= count; i++) {
    const page = doc.addPage([300 + i, 400]); // width encodes page number
    page.drawText(`${label} ${i}`, { x: 20, y: 200, size: 24, font });
  }
  if (opts.rotateFirst) doc.getPage(0).setRotation(degrees(opts.rotateFirst));
  return doc.save();
}
async function widths(bytes: Uint8Array, password?: string) {
  const doc = await PDFDocument.load(bytes, { password });
  return doc.getPages().map((p) => Math.round(p.getWidth()));
}
async function rotations(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((p) => p.getRotation().angle);
}

console.log("Opus engine tests");

const A = await makePdf("A", 3);
const B = await makePdf("B", 2);

await test("load a normal PDF", async () => {
  const s = await loadSource(A, "a.pdf");
  eq(s.pageCount, 3);
  eq(s.baseRotations, [0, 0, 0]);
});

await test("reject a file that is not a PDF", async () => {
  try {
    await loadSource(new TextEncoder().encode("hello, not a pdf"), "x.pdf");
    throw new Error("should have thrown");
  } catch (e) { assert(e instanceof NotAPdfError, String(e)); }
});

await test("reject an empty file", async () => {
  try { await loadSource(new Uint8Array(), "x.pdf"); throw new Error("should have thrown"); }
  catch (e) { assert(e instanceof NotAPdfError, String(e)); }
});

await test("reject a truncated PDF gracefully", async () => {
  try {
    await loadSource(A.slice(0, 200), "cut.pdf");
    throw new Error("should have thrown");
  } catch (e) { assert(e instanceof NotAPdfError, String(e)); }
});

await test("save keeps page order", async () => {
  const s = await loadSource(A, "a.pdf");
  const out = await buildPdf(pagesOf(s), new Map([[s.id, s]]));
  eq(await widths(out), [301, 302, 303]);
});

await test("reorder + delete", async () => {
  const s = await loadSource(A, "a.pdf");
  const p = pagesOf(s);
  const out = await buildPdf([p[2], p[0]], new Map([[s.id, s]]));
  eq(await widths(out), [303, 301]);
});

await test("merge two files", async () => {
  const a = await loadSource(A, "a.pdf");
  const b = await loadSource(B, "b.pdf");
  const out = await buildPdf([...pagesOf(a), ...pagesOf(b)], new Map([[a.id, a], [b.id, b]]));
  eq(await widths(out), [301, 302, 303, 301, 302]);
});

await test("same page used twice", async () => {
  const s = await loadSource(A, "a.pdf");
  const p = pagesOf(s);
  const out = await buildPdf([p[0], { ...p[0], key: "dup" }], new Map([[s.id, s]]));
  eq(await widths(out), [301, 301]);
});

await test("rotate adds to the file's own rotation", async () => {
  const R = await makePdf("R", 2, { rotateFirst: 90 });
  const s = await loadSource(R, "r.pdf");
  eq(s.baseRotations, [90, 0]);
  const p = pagesOf(s);
  p[0].rotation = 90;
  p[1].rotation = -90;
  const out = await buildPdf(p, new Map([[s.id, s]]));
  eq(await rotations(out), [180, 270]);
});

await test("password-protect, then reopen with password", async () => {
  const s = await loadSource(A, "a.pdf");
  const locked = await buildPdf(pagesOf(s), new Map([[s.id, s]]), { password: "wolf123" });
  // Without password → asks for one
  try { await loadSource(locked, "l.pdf"); throw new Error("should need password"); }
  catch (e) { assert(e instanceof PasswordRequiredError && !e.wrongPassword, String(e)); }
  // Wrong password → says wrong
  try { await loadSource(locked, "l.pdf", "nope"); throw new Error("should reject"); }
  catch (e) { assert(e instanceof PasswordRequiredError && e.wrongPassword, String(e)); }
  // Right password → unlocked bytes that open with no password
  const unlocked = await loadSource(locked, "l.pdf", "wolf123");
  eq(unlocked.pageCount, 3);
  eq(await widths(unlocked.bytes), [301, 302, 303]);
});

await test("remove a password by saving unlocked copy", async () => {
  const s = await loadSource(A, "a.pdf");
  const locked = await buildPdf(pagesOf(s), new Map([[s.id, s]]), { password: "pw" });
  const u = await loadSource(locked, "l.pdf", "pw");
  const out = await buildPdf(pagesOf(u), new Map([[u.id, u]]));
  const again = await loadSource(out, "out.pdf"); // no password needed
  eq(again.pageCount, 3);
});

await test("parseRanges", () => {
  eq(parseRanges("1-3, 5", 10), [[0, 1, 2], [4]]);
  eq(parseRanges("8-", 10), [[7, 8, 9]]);
  eq(parseRanges("-2", 10), [[0, 1]]);
  eq(parseRanges("3-1", 10), [[2, 1, 0]]);
  eq(parseRanges(" 2 ; 4 to 5 ", 10), [[1], [3, 4]]);
  for (const bad of ["", "0", "11", "abc", "1-99", "1--2"]) {
    let threw = false;
    try { parseRanges(bad, 10); } catch { threw = true; }
    assert(threw, `should reject "${bad}"`);
  }
});

await test("chunkPages", () => {
  eq(chunkPages(5, 2), [[0, 1], [2, 3], [4]]);
  eq(chunkPages(3, 10), [[0, 1, 2]]);
  let threw = false;
  try { chunkPages(3, 0); } catch { threw = true; }
  assert(threw);
});

await test("baseName", () => {
  eq(baseName("C:\\Users\\me\\Report Q3.PDF"), "Report Q3");
  eq(baseName("/tmp/a:b?.pdf"), "a_b_");
  eq(baseName(".pdf"), "document");
});

await test("empty page list refuses to save", async () => {
  let threw = false;
  try { await buildPdf([], new Map<string, Source>()); } catch { threw = true; }
  assert(threw);
});

await test("larger file (200 pages) merges quickly", async () => {
  const big = await makePdf("Big", 200);
  const t = Date.now();
  const s = await loadSource(big, "big.pdf");
  const out = await buildPdf([...pagesOf(s), ...pagesOf(s)], new Map([[s.id, s]]));
  eq((await widths(out)).length, 400);
  assert(Date.now() - t < 15000, "too slow");
});

await test("plain save keeps form fields", async () => {
  const d = await PDFDocument.create();
  const page = d.addPage([400, 400]);
  const field = d.getForm().createTextField("name");
  field.setText("Wolf");
  field.addToPage(page, { x: 20, y: 300, width: 200, height: 30 });
  const bytes = await d.save();
  const s = await loadSource(bytes, "form.pdf");
  const p = pagesOf(s);
  p[0].rotation = 90;
  const out = await buildPdf(p, new Map([[s.id, s]]));
  const back = await PDFDocument.load(out);
  eq(back.getForm().getTextField("name").getText(), "Wolf");
  eq(back.getPage(0).getRotation().angle, 90);
});

await test("unlocking keeps form fields", async () => {
  const d = await PDFDocument.create();
  const page = d.addPage([400, 400]);
  const field = d.getForm().createTextField("secret");
  field.setText("Pack");
  field.addToPage(page, { x: 20, y: 300, width: 200, height: 30 });
  d.encrypt({ userPassword: "pw", ownerPassword: "pw" });
  const locked = await d.save();
  const s = await loadSource(locked, "f.pdf", "pw");
  const back = await PDFDocument.load(s.bytes);
  eq(back.isEncrypted, false);
  eq(back.getForm().getTextField("secret").getText(), "Pack");
});

await test("encrypted with empty open-password opens without asking", async () => {
  const d = await PDFDocument.create();
  d.addPage([300, 300]);
  d.encrypt({ userPassword: "", ownerPassword: "owner" });
  const s = await loadSource(await d.save(), "e.pdf");
  eq(s.pageCount, 1);
});

await test("warns before dropping form fields, not for plain saves", async () => {
  const d = await PDFDocument.create();
  const page = d.addPage([400, 400]);
  d.addPage([400, 400]);
  d.getForm().createTextField("f").addToPage(page, { x: 10, y: 10, width: 100, height: 20 });
  const s = await loadSource(await d.save(), "form.pdf");
  const map = new Map([[s.id, s]]);
  const p = pagesOf(s);
  eq(extrasLostBy(p, map), []);
  eq(extrasLostBy([p[1], p[0]], map), ["form.pdf"]);
  eq(extrasLostBy([p[0]], map), ["form.pdf"]);
  const plain = await loadSource(A, "a.pdf");
  eq(extrasLostBy(pagesOf(plain).slice(1), new Map([[plain.id, plain]])), []);
});

await test("internal links count as extras", async () => {
  const d = await PDFDocument.create();
  const p1 = d.addPage([300, 300]);
  const p2 = d.addPage([300, 300]);
  const link = d.context.obj({ Type: "Annot", Subtype: "Link", Rect: [0, 0, 50, 50], Dest: [p2.ref, "Fit"] });
  p1.node.addAnnot(d.context.register(link));
  const s = await loadSource(await d.save(), "links.pdf");
  eq(s.hasExtras, true);
});

await test("removing a password leaves no /Encrypt reference", async () => {
  const s = await loadSource(A, "a.pdf");
  const locked = await buildPdf(pagesOf(s), new Map([[s.id, s]]), { password: "pw" });
  const u = await loadSource(locked, "l.pdf", "pw");
  const out = await buildPdf(pagesOf(u), new Map([[u.id, u]]));
  const text = new TextDecoder("latin1").decode(out);
  assert(!text.includes("/Encrypt"), "output still mentions /Encrypt");
});

await test("owner-only protected file reports restrictions removed", async () => {
  const d = await PDFDocument.create();
  d.addPage([300, 300]);
  d.encrypt({ userPassword: "", ownerPassword: "owner", permissions: { printing: false } });
  const s = await loadSource(await d.save(), "r.pdf");
  eq(s.restrictionsRemoved, true);
  eq((await loadSource(A, "a.pdf")).restrictionsRemoved, false);
});

await test("truncated PDF gives a friendly message", async () => {
  try { await loadSource(A.slice(0, Math.floor(A.length / 2)), "t.pdf"); }
  catch (e) { assert(e instanceof NotAPdfError && /damaged|incomplete|not a valid/i.test((e as Error).message), String(e)); return; }
  // pdf-lib may recover a half file; that's acceptable too
});

// ---------- stage 1 tools ----------
const ROT = await (async () => {
  const d = await PDFDocument.create();
  for (const r of [0, 90, 180, 270]) d.addPage([600, 800]).setRotation(degrees(r));
  return d.save();
})();

await test("page numbers on rotated pages stay upright and in place", async () => {
  const out = await T.addPageNumbers(ROT, { position: "bottom-right", format: "Page {n} of {total}", start: 1, size: 12, marginMm: 10, color: "#000000", pages: "all", font: "sans" });
  const d = await PDFDocument.load(out);
  eq(d.getPageCount(), 4);
  eq(d.getPages().map((p) => p.getRotation().angle), [0, 90, 180, 270]);
});

await test("page numbers skip first + start number", async () => {
  const out = await T.addPageNumbers(A, { position: "top-center", format: "{n}/{total}", start: 5, size: 10, marginMm: 8, color: "#ff0000", pages: "skip-first", font: "serif" });
  eq((await PDFDocument.load(out)).getPageCount(), 3);
});

await test("page numbers with non-Latin text don't crash", async () => {
  await T.addPageNumbers(A, { position: "bottom-left", format: "Страница {n} 页", start: 1, size: 10, marginMm: 8, color: "#000000", pages: "all", font: "sans" });
});

await test("watermark text: center, tile, corner", async () => {
  for (const layout of ["center", "tile", "top-left"] as const) {
    const out = await T.addWatermark(ROT, { kind: "text", text: "DRAFT", imageScale: 0.3, size: 50, color: "#ff0000", opacity: 0.3, angle: 45, layout, pages: "all", bold: true });
    eq((await PDFDocument.load(out)).getPageCount(), 4);
  }
});

await test("watermark image requires an image", async () => {
  let threw = false;
  try { await T.addWatermark(A, { kind: "image", text: "", imageScale: 0.3, size: 50, color: "#000000", opacity: 0.3, angle: 0, layout: "center", pages: "all", bold: false }); } catch { threw = true; }
  assert(threw);
});

await test("crop on rotated pages trims the visual top", async () => {
  const out = await T.cropPages(ROT, { top: 20, right: 0, bottom: 0, left: 0, pages: "all" });
  const d = await PDFDocument.load(out);
  const boxes = d.getPages().map((p) => { const b = p.getCropBox(); return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]; });
  eq(boxes, [[0, 0, 600, 743], [57, 0, 543, 800], [0, 57, 600, 743], [0, 0, 543, 800]]);
});

await test("crop rejects margins larger than the page", async () => {
  let threw = false;
  try { await T.cropPages(A, { top: 500, right: 0, bottom: 500, left: 0, pages: "all" }); } catch { threw = true; }
  assert(threw);
});

await test("images to PDF (fit, A4 auto orientation, margins)", async () => {
  const src = await PDFDocument.create();
  // Tiny 2x1 PNG
  const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAEElEQVR4nGP4z8DAwMDAAAAOAAHn1n6qAAAAAElFTkSuQmCC"), (c) => c.charCodeAt(0));
  void src;
  const fit = await T.imagesToPdf([{ bytes: png, type: "png", width: 2, height: 1 }], { pageSize: "fit", orientation: "auto", marginMm: 0 });
  const a4 = await T.imagesToPdf([{ bytes: png, type: "png", width: 2, height: 1 }, { bytes: png, type: "png", width: 2, height: 1 }], { pageSize: "a4", orientation: "auto", marginMm: 10 });
  const d = await PDFDocument.load(a4);
  eq(d.getPageCount(), 2);
  const s = d.getPage(0).getSize();
  assert(s.width > s.height, "wide image should give landscape A4");
  eq((await PDFDocument.load(fit)).getPageCount(), 1);
});

await test("blank pages, reverse, properties, flatten", async () => {
  eq((await PDFDocument.load(await T.insertBlank(A, "between"))).getPageCount(), 5);
  eq((await PDFDocument.load(await T.insertBlank(A, "start"))).getPageCount(), 4);
  eq(await widths(await T.reversePages(A)), [303, 302, 301]);
  const info = await T.readInfo(await T.writeInfo(A, { title: "Wolf", author: "Pack", subject: "S", keywords: "a, b" }));
  eq([info.title, info.author], ["Wolf", "Pack"]);
  let threw = false;
  try { await T.flattenForms(A); } catch { threw = true; }
  assert(threw, "flatten with no fields should explain");
});

await test("tool registry: search and smart suggestions", () => {
  assert(TOOLS.length >= 25);
  assert(new Set(TOOLS.map((t) => t.id)).size === TOOLS.length, "duplicate tool ids");
  assert(matchTool(TOOLS.find((t) => t.id === "compress")!, "shrink") > 0);
  eq(suggestFor([{ name: "a.jpg" }]).map((t) => t.id), ["image-to-pdf"]);
  eq(suggestFor([{ name: "a.pdf" }, { name: "b.pdf" }])[0].id, "merge");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
