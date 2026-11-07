// Heavy-duty PDF processing through the bundled Ghostscript engine.
// Desktop only: in a plain browser these tools report that they need the app.

import { invoke } from "@tauri-apps/api/core";
import { isDesktop } from "./platform";

let available: boolean | null = null;
export async function hasEngine(): Promise<boolean> {
  if (!isDesktop) return false;
  if (available === null) available = await invoke<boolean>("has_ghostscript").catch(() => false);
  return available;
}

async function run(input: Uint8Array, args: string[], files: Record<string, string> = {}): Promise<Uint8Array> {
  if (!(await hasEngine())) {
    throw new Error(isDesktop ? "The PDF engine is missing. Reinstall Opus." : "This tool works in the installed Opus app.");
  }
  const buf = await invoke<ArrayBuffer>("run_ghostscript", input, {
    headers: {
      "x-args": encodeURIComponent(JSON.stringify(args)),
      "x-files": encodeURIComponent(JSON.stringify(files)),
    },
  });
  const out = new Uint8Array(buf);
  if (out.length < 8) throw new Error("The PDF engine returned an empty file");
  return out;
}

export type CompressLevel = "extreme" | "recommended" | "light";

const PRESETS: Record<CompressLevel, string[]> = {
  // Smallest files: images at 72-100 dpi, fine on screens.
  extreme: [
    "-dPDFSETTINGS=/screen",
    "-dColorImageResolution=100", "-dGrayImageResolution=100", "-dMonoImageResolution=200",
  ],
  // Good balance for sharing: 150 dpi images.
  recommended: ["-dPDFSETTINGS=/ebook"],
  // Print quality: keeps 300 dpi, removes waste.
  light: ["-dPDFSETTINGS=/printer"],
};

export async function compress(input: Uint8Array, level: CompressLevel): Promise<Uint8Array> {
  return run(input, [
    "-dCompatibilityLevel=1.7",
    ...PRESETS[level],
    "-dDetectDuplicateImages=true",
    "-dCompressFonts=true",
    "-dSubsetFonts=true",
    "-dAutoRotatePages=/None",
  ]);
}

export async function grayscale(input: Uint8Array): Promise<Uint8Array> {
  return run(input, [
    "-dCompatibilityLevel=1.7",
    "-sColorConversionStrategy=Gray",
    "-dProcessColorModel=/DeviceGray",
    "-dAutoRotatePages=/None",
  ]);
}

/** Rewrites the whole file through Ghostscript: fixes many broken PDFs. */
export async function repair(input: Uint8Array): Promise<Uint8Array> {
  return run(input, ["-dCompatibilityLevel=1.7", "-dAutoRotatePages=/None", "-dPDFSTOPONERROR=false"]);
}

const PDFA_DEF = `%!
% Opus: PDF/A output intent (sRGB)
/ICCProfile <{icchex}> def
[/_objdef {icc_PDFA} /type /stream /OBJ pdfmark
[{icc_PDFA} << /N 3 >> /PUT pdfmark
[{icc_PDFA} ICCProfile (r) file /PUT pdfmark
[/_objdef {OutputIntent_PDFA} /type /dict /OBJ pdfmark
[{OutputIntent_PDFA} << /Type /OutputIntent /S /GTS_PDFA1 /DestOutputProfile {icc_PDFA} /OutputConditionIdentifier (sRGB IEC61966-2.1) /Info (sRGB) >> /PUT pdfmark
[{Catalog} << /OutputIntents [ {OutputIntent_PDFA} ] >> /PUT pdfmark
`;

/** Converts to PDF/A (archival format) — part 1, 2 or 3, level B. */
export async function toPdfA(input: Uint8Array, part: 1 | 2 | 3 = 2): Promise<Uint8Array> {
  return run(
    input,
    [
      `-dPDFA=${part}`,
      "-dPDFACompatibilityPolicy=1",
      "-sColorConversionStrategy=RGB",
      "-dAutoRotatePages=/None",
      "--permit-file-read={iccdir}",
      "{dir}/opus_pdfa.ps",
    ],
    { "opus_pdfa.ps": PDFA_DEF },
  );
}
