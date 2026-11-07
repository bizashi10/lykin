// Talks to Windows (through Tauri) to open and save files.
// When running in a normal browser (for development/testing) it falls back to
// browser file pickers and downloads, so the UI can be tried without Tauri.

import { invoke } from "@tauri-apps/api/core";
import { open, save, ask } from "@tauri-apps/plugin-dialog";

export const isDesktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export interface PickedFile {
  name: string;
  /** Full path on disk (desktop only). */
  path?: string;
  bytes: Uint8Array;
}

const PDF_FILTER = [{ name: "PDF documents", extensions: ["pdf"] }];

export function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export async function readPath(path: string): Promise<PickedFile> {
  const buf = await invoke<ArrayBuffer>("read_file", { path });
  return { name: fileNameOf(path), path, bytes: new Uint8Array(buf) };
}

/** Lets the person choose one or more PDFs to open. */
export async function pickPdfs(multiple: boolean): Promise<PickedFile[]> {
  if (isDesktop) {
    const chosen = await open({ multiple, filters: PDF_FILTER, title: multiple ? "Choose PDFs" : "Open PDF" });
    if (!chosen) return [];
    const paths = Array.isArray(chosen) ? chosen : [chosen];
    return Promise.all(paths.map(readPath));
  }
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/pdf,.pdf";
    input.multiple = multiple;
    input.onchange = async () => {
      const files = Array.from(input.files ?? []);
      resolve(await Promise.all(files.map(fromBrowserFile)));
    };
    input.oncancel = () => resolve([]);
    input.click();
  });
}

export async function fromBrowserFile(file: File): Promise<PickedFile> {
  return { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
}

async function writePath(path: string, bytes: Uint8Array): Promise<void> {
  await invoke("write_file", bytes, { headers: { "x-path": encodeURIComponent(path) } });
}

function typeOf(name: string): { mime: string; ext: string; filter: { name: string; extensions: string[] }[] } {
  const ext = (name.match(/\.([a-z0-9]+)$/i)?.[1] ?? "pdf").toLowerCase();
  if (ext === "jpg" || ext === "jpeg") return { mime: "image/jpeg", ext: "jpg", filter: [{ name: "JPEG image", extensions: ["jpg", "jpeg"] }] };
  if (ext === "png") return { mime: "image/png", ext: "png", filter: [{ name: "PNG image", extensions: ["png"] }] };
  if (ext === "txt") return { mime: "text/plain", ext: "txt", filter: [{ name: "Text file", extensions: ["txt"] }] };
  const office: Record<string, string> = { docx: "Word document", pptx: "PowerPoint", xlsx: "Excel workbook" };
  if (office[ext]) return { mime: "application/octet-stream", ext, filter: [{ name: office[ext], extensions: [ext] }] };
  return { mime: "application/pdf", ext: "pdf", filter: PDF_FILTER };
}

function download(bytes: Uint8Array, name: string) {
  const blob = new Blob([bytes as BlobPart], { type: typeOf(name).mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Saves bytes. If `path` is given (desktop), writes straight there;
 * otherwise asks where to save. Returns the chosen path, or null if cancelled.
 */
export async function saveBytes(
  bytes: Uint8Array,
  suggestedName: string,
  path?: string,
): Promise<string | null> {
  if (isDesktop) {
    let target = path ?? null;
    if (!target) {
      const t = typeOf(suggestedName);
      target = await save({ defaultPath: suggestedName, filters: t.filter, title: t.ext === "pdf" ? "Save PDF" : "Save image" });
      if (!target) return null;
      if (!t.filter[0].extensions.some((e) => target!.toLowerCase().endsWith(`.${e}`))) target += `.${t.ext}`;
    }
    await writePath(target, bytes);
    return target;
  }
  download(bytes, suggestedName);
  return suggestedName;
}

/** Lets the person choose a folder (desktop) for writing several files. */
export async function pickFolder(): Promise<string | null> {
  if (!isDesktop) return "(downloads)";
  const chosen = await open({ directory: true, title: "Choose a folder for the new files" });
  return typeof chosen === "string" ? chosen : null;
}

/** Writes several files into a folder, never overwriting existing ones. */
export async function saveManyToFolder(
  folder: string,
  files: { name: string; bytes: Uint8Array }[],
): Promise<string[]> {
  if (!isDesktop) {
    files.forEach((f, i) => setTimeout(() => download(f.bytes, f.name), i * 300));
    return files.map((f) => f.name);
  }
  const written: string[] = [];
  for (const f of files) {
    const path = await invoke<string>("unique_path", { folder, name: f.name });
    await writePath(path, f.bytes);
    written.push(path);
  }
  return written;
}

/** PDFs passed on the command line (e.g. double-clicking a PDF in Explorer). */
export async function startupFiles(): Promise<string[]> {
  if (!isDesktop) return [];
  try {
    return await invoke<string[]>("startup_files");
  } catch {
    return [];
  }
}

export async function confirm(message: string, title = "Opus"): Promise<boolean> {
  if (isDesktop) return ask(message, { title, kind: "warning", okLabel: "Yes", cancelLabel: "No" });
  return window.confirm(message);
}

export async function showInFolder(path: string): Promise<void> {
  if (isDesktop) await invoke("show_in_folder", { path }).catch(() => {});
}
