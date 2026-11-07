// Saves an edited PDF: page operations + annotations, with true redaction.
//
// Two paths:
//  - No redaction anywhere → build the PDF normally (keeping text, bookmarks and
//    form fields) and draw the annotations on top.
//  - Any redaction → rebuild page by page; redacted pages are rendered to an
//    image with the hidden areas painted out, so the content is truly gone, not
//    just covered. (This makes those pages pictures, which is the price of a
//    guaranteed redaction.)

import { PDFDocument, degrees } from "@cantoo/pdf-lib";
import { buildPdf, normalizeRotation, type PageRef, type Source } from "./pdfops.ts";
import { drawAnnotations, embedFonts, hasRedaction, type Anno, type ImageStore } from "./annots.ts";
import { applyFormValues } from "./forms.ts";

export interface EditExport {
  password?: string;
  /** Values to write into existing form fields (overlay path only). */
  fieldValues?: Record<string, string>;
  /** Make filled form fields non-editable in the output. */
  flattenForm?: boolean;
}

/** True when any page carries annotations (so we must go beyond a plain save). */
export function hasAnyAnnotations(byKey: Record<string, Anno[]>): boolean {
  return Object.values(byKey).some((l) => l && l.length > 0);
}

async function encryptIfNeeded(doc: PDFDocument, password?: string) {
  if (password) {
    doc.encrypt({
      userPassword: password, ownerPassword: password,
      permissions: { printing: "highResolution", modifying: true, copying: true, annotating: true, fillingForms: true, contentAccessibility: true, documentAssembly: true },
    });
  }
}

export async function exportEdited(
  pages: PageRef[],
  sources: Map<string, Source>,
  byKey: Record<string, Anno[]>,
  images: ImageStore,
  options: EditExport = {},
): Promise<Uint8Array> {
  const anyRedaction = pages.some((p) => hasRedaction(byKey[p.key]));

  if (!anyRedaction) {
    // Overlay path: keep everything, just draw on top.
    const base = await buildPdf(pages, sources);
    const doc = await PDFDocument.load(base, { updateMetadata: false, throwOnInvalidObject: false });
    // Fill form fields first (needs the form, which buildPdf keeps when pages
    // are unchanged). Then optionally flatten so the values can't be edited.
    if (options.fieldValues && Object.keys(options.fieldValues).length) {
      try {
        applyFormValues(doc, options.fieldValues);
        if (options.flattenForm) doc.getForm().flatten();
      } catch { /* no form survived the page edits */ }
    }
    const fonts = await embedFonts(doc);
    const outPages = doc.getPages();
    for (let i = 0; i < pages.length; i++) {
      const list = byKey[pages[i].key];
      if (list?.length) await drawAnnotations(doc, outPages[i], list, fonts, images);
    }
    doc.setProducer("Opus by Lykin");
    doc.setModificationDate(new Date());
    await encryptIfNeeded(doc, options.password);
    return doc.save({ useObjectStreams: true });
  }

  // Redaction path: rebuild page by page.
  const out = await PDFDocument.create();
  const fonts = await embedFonts(out);
  const loaded = new Map<string, PDFDocument>();
  const getDoc = async (id: string) => {
    let d = loaded.get(id);
    if (!d) {
      d = await PDFDocument.load(sources.get(id)!.bytes, { updateMetadata: false, throwOnInvalidObject: false });
      loaded.set(id, d);
    }
    return d;
  };

  for (const ref of pages) {
    const source = sources.get(ref.sourceId)!;
    const list = byKey[ref.key] ?? [];
    const effRot = normalizeRotation(source.baseRotations[ref.index] + ref.rotation);

    if (hasRedaction(list)) {
      const { bytes, vw, vh, type } = await rasterizeRedacted(source, ref.index, effRot, list);
      const page = out.addPage([vw, vh]);
      const img = await out.embedJpg(bytes);
      void type;
      page.drawImage(img, { x: 0, y: 0, width: vw, height: vh });
      const overlay = list.filter((a) => a.type !== "redact");
      if (overlay.length) await drawAnnotations(out, page, overlay, fonts, images);
    } else {
      const doc = await getDoc(ref.sourceId);
      const [copied] = await out.copyPages(doc, [ref.index]);
      copied.setRotation(degrees(effRot));
      out.addPage(copied);
      if (list.length) await drawAnnotations(out, copied, list, fonts, images);
    }
  }

  out.setProducer("Opus by Lykin");
  out.setModificationDate(new Date());
  await encryptIfNeeded(out, options.password);
  return out.save({ useObjectStreams: true });
}

/**
 * Renders a page to an image at the given rotation with the redaction areas
 * filled solid, so the hidden content is not present in the output at all.
 */
async function rasterizeRedacted(
  source: Source, index: number, rotation: number, list: Anno[],
): Promise<{ bytes: Uint8Array; vw: number; vh: number; type: "jpg" }> {
  const DPI = 150;
  const scale = DPI / 72;
  const { getPage } = await import("./render");
  const page = await getPage(source, index);
  const base = page.getViewport({ scale: 1, rotation });
  const vw = base.width, vh = base.height;
  const vp = page.getViewport({ scale, rotation });
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, viewport: vp }).promise;

  // Paint the redaction boxes (view points → canvas pixels).
  ctx.fillStyle = "#000000";
  for (const a of list) {
    if (a.type !== "redact") continue;
    ctx.fillRect(a.x * scale, a.y * scale, a.w * scale, a.h * scale);
  }

  const blob = await new Promise<Blob>((res, rej) =>
    canvas.toBlob((b) => (b ? res(b) : rej(new Error("Could not render the redacted page"))), "image/jpeg", 0.9),
  );
  const bytes = new Uint8Array(await blob.arrayBuffer());
  canvas.width = canvas.height = 0;
  return { bytes, vw, vh, type: "jpg" };
}
