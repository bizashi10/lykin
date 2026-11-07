// Every tool Opus offers, as shown on the home screen and in Ctrl+K.

export type Category = "organize" | "optimize" | "convert" | "edit" | "secure";

export interface ToolDef {
  id: string;
  name: string;
  /** One line, plain words: what it does. */
  blurb: string;
  category: Category;
  icon: string;
  /** What the tool takes. */
  input: "pdf" | "images" | "office";
  /** Many files at once? (each processed separately, or combined) */
  multiple: boolean;
  /** "batch" = one result per file; "combine" = one result from all; "editor" = opens the page editor. */
  mode: "batch" | "combine" | "editor" | "single";
  /** Needs the bundled PDF engine (desktop app). */
  engine?: boolean;
  /** Needs the bundled document converter (LibreOffice, desktop app). */
  office?: boolean;
  /** Not built yet: shown as coming soon. */
  soon?: boolean;
  keywords?: string;
}

export const CATEGORIES: { id: Category; name: string; hint: string }[] = [
  { id: "organize", name: "Organize", hint: "Combine, split and arrange pages" },
  { id: "optimize", name: "Optimize", hint: "Smaller, cleaner, sturdier files" },
  { id: "convert", name: "Convert", hint: "Between PDF, images and archive formats" },
  { id: "edit", name: "Edit & mark", hint: "Stamp, number, crop and annotate" },
  { id: "secure", name: "Protect & sign", hint: "Passwords, signatures and redaction" },
];

export const TOOLS: ToolDef[] = [
  // Organize
  { id: "merge", name: "Merge PDFs", blurb: "Combine several PDFs into one, in the order you choose.", category: "organize", icon: "merge", input: "pdf", multiple: true, mode: "combine", keywords: "combine join append" },
  { id: "split", name: "Split PDF", blurb: "Cut a PDF into separate files by ranges or page count.", category: "organize", icon: "split", input: "pdf", multiple: false, mode: "single", keywords: "separate divide break extract" },
  { id: "organize", name: "Organize pages", blurb: "Drag pages into order, rotate, delete or duplicate them.", category: "organize", icon: "grid", input: "pdf", multiple: false, mode: "editor", keywords: "reorder sort arrange move delete remove pages" },
  { id: "remove", name: "Remove pages", blurb: "Pick the pages you don't need and drop them.", category: "organize", icon: "trash", input: "pdf", multiple: false, mode: "single", keywords: "delete pages" },
  { id: "extract", name: "Extract pages", blurb: "Save just the pages you pick as a new PDF.", category: "organize", icon: "extract", input: "pdf", multiple: false, mode: "single", keywords: "select copy pages" },
  { id: "rotate", name: "Rotate PDF", blurb: "Turn every page, or only portrait or landscape ones.", category: "organize", icon: "rotate-right", input: "pdf", multiple: true, mode: "batch", keywords: "turn orientation" },
  { id: "blank", name: "Insert blank pages", blurb: "Add empty pages at the start, the end or between pages.", category: "organize", icon: "plus", input: "pdf", multiple: true, mode: "batch", keywords: "empty add page" },
  { id: "reverse", name: "Reverse order", blurb: "Flip the page order, last page first.", category: "organize", icon: "reverse", input: "pdf", multiple: true, mode: "batch", keywords: "backwards invert" },

  // Optimize
  { id: "compress", name: "Compress PDF", blurb: "Make files smaller while keeping them readable.", category: "optimize", icon: "compress", input: "pdf", multiple: true, mode: "batch", engine: true, keywords: "reduce shrink size smaller optimize" },
  { id: "repair", name: "Repair PDF", blurb: "Rebuild damaged files that won't open properly.", category: "optimize", icon: "repair", input: "pdf", multiple: true, mode: "batch", keywords: "fix broken corrupt recover" },
  { id: "grayscale", name: "Grayscale", blurb: "Turn colours to shades of grey for cheaper printing.", category: "optimize", icon: "contrast", input: "pdf", multiple: true, mode: "batch", engine: true, keywords: "black white grey gray monochrome" },
  { id: "flatten", name: "Flatten forms", blurb: "Lock filled-in form fields so they can't be edited.", category: "optimize", icon: "layers", input: "pdf", multiple: true, mode: "batch", keywords: "form fields lock" },
  { id: "metadata", name: "Edit properties", blurb: "Change the title, author, subject and keywords.", category: "optimize", icon: "tag", input: "pdf", multiple: false, mode: "single", keywords: "metadata info title author" },

  // Convert
  { id: "pdf-to-image", name: "PDF to images", blurb: "Save each page as a JPG or PNG picture.", category: "convert", icon: "image", input: "pdf", multiple: true, mode: "batch", keywords: "jpg jpeg png picture export" },
  { id: "image-to-pdf", name: "Images to PDF", blurb: "Turn photos, scans and screenshots into one PDF.", category: "convert", icon: "image-plus", input: "images", multiple: true, mode: "combine", keywords: "jpg jpeg png photo picture scan" },
  { id: "extract-images", name: "Extract images", blurb: "Pull out every picture embedded in a PDF.", category: "convert", icon: "images", input: "pdf", multiple: true, mode: "batch", keywords: "pictures photos get" },
  { id: "pdfa", name: "PDF to PDF/A", blurb: "Convert to the long-term archive standard.", category: "convert", icon: "archive", input: "pdf", multiple: true, mode: "batch", engine: true, keywords: "archive iso long term" },
  { id: "pdf-to-word", name: "PDF to Word", blurb: "Editable Word document from a PDF (layout approximate).", category: "convert", icon: "file", input: "pdf", multiple: true, mode: "batch", office: true, keywords: "docx doc word" },
  { id: "pdf-to-excel", name: "PDF to Excel", blurb: "Pull tables into a spreadsheet.", category: "convert", icon: "table", input: "pdf", multiple: true, mode: "batch", soon: true, keywords: "xlsx table" },
  { id: "office-to-pdf", name: "Office to PDF", blurb: "Word, Excel, PowerPoint and OpenDocument files to PDF.", category: "convert", icon: "file", input: "office", multiple: true, mode: "batch", office: true, keywords: "docx xlsx pptx word excel powerpoint odt convert" },
  { id: "pdf-to-powerpoint", name: "PDF to PowerPoint", blurb: "One editable slide per PDF page (layout approximate).", category: "convert", icon: "slides", input: "pdf", multiple: true, mode: "batch", office: true, keywords: "pptx powerpoint slides" },
  { id: "ocr", name: "OCR scans", blurb: "Make scanned pages searchable and copyable, offline.", category: "convert", icon: "scan", input: "pdf", multiple: true, mode: "batch", keywords: "text recognition scanned searchable tesseract extract" },

  // Edit
  { id: "page-numbers", name: "Page numbers", blurb: "Number pages, with the style and position you want.", category: "edit", icon: "hash", input: "pdf", multiple: true, mode: "batch", keywords: "numbering footer header" },
  { id: "watermark", name: "Watermark", blurb: "Stamp text or a logo over your pages.", category: "edit", icon: "stamp", input: "pdf", multiple: true, mode: "batch", keywords: "stamp draft confidential logo" },
  { id: "crop", name: "Crop pages", blurb: "Trim margins off every page.", category: "edit", icon: "crop", input: "pdf", multiple: true, mode: "batch", keywords: "trim margin cut" },
  { id: "edit", name: "Edit PDF", blurb: "Add text, images, shapes, highlights and drawings.", category: "edit", icon: "pen", input: "pdf", multiple: false, mode: "editor", keywords: "annotate text write draw shape markup comment note" },
  { id: "compare", name: "Compare PDFs", blurb: "See what changed between two versions, side by side.", category: "edit", icon: "compare", input: "pdf", multiple: true, mode: "combine", keywords: "diff difference changes versions" },

  // Secure
  { id: "protect", name: "Protect PDF", blurb: "Lock files with a password and AES-256 encryption.", category: "secure", icon: "lock", input: "pdf", multiple: true, mode: "batch", keywords: "password encrypt secure" },
  { id: "unlock", name: "Unlock PDF", blurb: "Remove a known password or print, copy and edit restrictions.", category: "secure", icon: "unlock", input: "pdf", multiple: true, mode: "batch", keywords: "remove password decrypt locked restrictions permissions owner print copy edit secured" },
  { id: "sign", name: "Sign PDF", blurb: "Draw, type or upload your signature, then place it.", category: "secure", icon: "signature", input: "pdf", multiple: false, mode: "editor", keywords: "signature initials fill form" },
  { id: "redact", name: "Redact", blurb: "Permanently black out and remove private text.", category: "secure", icon: "redact", input: "pdf", multiple: false, mode: "editor", keywords: "censor hide black out remove confidential" },
  { id: "fillsign", name: "Fill & sign", blurb: "Type into form fields and add your signature.", category: "secure", icon: "text", input: "pdf", multiple: false, mode: "editor", keywords: "form fields fill checkbox sign" },
];

export const toolById = (id: string) => TOOLS.find((t) => t.id === id);

/** Scores a tool against a search query (0 = no match). */
export function matchTool(t: ToolDef, q: string): number {
  const query = q.trim().toLowerCase();
  if (!query) return 1;
  const name = t.name.toLowerCase();
  const nameWords = name.split(/[^a-z0-9/]+/);
  const keyWords = `${t.keywords ?? ""} ${t.blurb.toLowerCase()}`.split(/[^a-z0-9/]+/);
  let score = 0;
  for (const w of query.split(/\s+/)) {
    if (nameWords.some((x) => x === w)) score += 8; // whole word in the name
    else if (nameWords.some((x) => x.startsWith(w))) score += 6;
    else if (keyWords.some((x) => x === w)) score += 4; // whole keyword
    else if (keyWords.some((x) => x.startsWith(w))) score += 2;
    else if (name.includes(w)) score += 1;
    else return 0;
  }
  return score;
}

/** Tools that make sense for the files someone dropped, best first. */
export function suggestFor(files: { name: string }[]): ToolDef[] {
  const pdfs = files.filter((f) => /\.pdf$/i.test(f.name)).length;
  const images = files.length - pdfs;
  const ids =
    images && !pdfs
      ? ["image-to-pdf"]
      : pdfs > 1
        ? ["merge", "compress", "protect", "page-numbers", "watermark", "pdf-to-image"]
        : ["organize", "compress", "split", "protect", "page-numbers", "watermark", "pdf-to-image", "pdfa"];
  return ids.map(toolById).filter((t): t is ToolDef => !!t && !t.soon);
}
