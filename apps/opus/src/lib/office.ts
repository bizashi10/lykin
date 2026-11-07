// Document conversion through the bundled LibreOffice engine (desktop only).

import { invoke } from "@tauri-apps/api/core";
import { isDesktop } from "./platform";

let available: boolean | null = null;
export async function hasOffice(): Promise<boolean> {
  if (!isDesktop) return false;
  if (available === null) available = await invoke<boolean>("has_soffice").catch(() => false);
  return available;
}

interface Spec {
  in_ext: string;
  out_ext: string;
  convert_to: string;
  infilter?: string;
}

async function convert(bytes: Uint8Array, spec: Spec): Promise<Uint8Array> {
  if (!(await hasOffice())) {
    throw new Error(isDesktop ? "The document converter (LibreOffice) is missing. Reinstall Opus." : "This tool works in the installed Opus app.");
  }
  const buf = await invoke<ArrayBuffer>("run_soffice", bytes, { headers: { "x-op": JSON.stringify(spec) } });
  const out = new Uint8Array(buf);
  if (out.length < 8) throw new Error("The converter produced an empty file");
  return out;
}

export const OFFICE_EXTS = ["doc", "docx", "odt", "rtf", "txt", "xls", "xlsx", "ods", "csv", "ppt", "pptx", "odp"];
export const isOfficeName = (name: string) => OFFICE_EXTS.includes((name.match(/\.([a-z0-9]+)$/i)?.[1] ?? "").toLowerCase());

/** Word / Excel / PowerPoint (and OpenDocument, RTF, CSV…) → PDF. */
export async function officeToPdf(bytes: Uint8Array, name: string): Promise<Uint8Array> {
  const ext = (name.match(/\.([a-z0-9]+)$/i)?.[1] ?? "docx").toLowerCase();
  return convert(bytes, { in_ext: ext, out_ext: "pdf", convert_to: "pdf" });
}

/** PDF → editable Word document (layout is approximate). */
export async function pdfToWord(bytes: Uint8Array): Promise<Uint8Array> {
  return convert(bytes, { in_ext: "pdf", out_ext: "docx", convert_to: "docx:MS Word 2007 XML", infilter: "writer_pdf_import" });
}

/** PDF → PowerPoint, one slide per page (layout is approximate). */
export async function pdfToPowerpoint(bytes: Uint8Array): Promise<Uint8Array> {
  return convert(bytes, { in_ext: "pdf", out_ext: "pptx", convert_to: "pptx:Impress MS PowerPoint 2007 XML", infilter: "impress_pdf_import" });
}
