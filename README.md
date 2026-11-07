# Lykin

A personal, offline office suite for Windows. No ads, no account — files never leave the PC.

| App | Replaces | Colour | Status |
|---|---|---|---|
| **Opus** | Adobe Acrobat (PDF) | Red | v0.3 — 25 tools + editor |
| **Prose** | Microsoft Word | Blue | planned |
| **Ordo** | Microsoft Excel | Green | planned |
| **Podium** | Microsoft PowerPoint | Orange | planned |

## Getting the Opus installer

1. Open the **Actions** tab of this repository.
2. Click the latest **Build Opus for Windows** run with a green tick.
3. Under **Artifacts**, download **Opus-Windows-Installer**, unzip it, and run the `-setup.exe`.

Windows may show "Windows protected your PC" because the installer isn't signed yet:
click **More info → Run anyway**.

## Opus v0.2 features

- **Home:** type what you want ("compress", "password"…), or drop files anywhere for suggestions. Recent files, light/dark theme, `Ctrl+K` command bar.
- **Organize:** merge, split, organize pages (drag, rotate, delete), remove pages, extract pages, rotate, insert blank pages, reverse order
- **Optimize:** compress (3 levels), repair, grayscale, flatten forms, edit properties
- **Convert:** PDF to JPG/PNG, images to PDF (phone photos auto-rotated), extract images, PDF/A-1b/2b/3b
- **Edit:** page numbers, text or image watermark, crop — with live preview
- **Full editor:** add text, notes, freehand drawing, highlights, lines, arrows, rectangles, ellipses, images and signatures; fill form fields; **true redaction** that removes the hidden content, not just covers it
- **Protect:** password-protect (AES-256), unlock (known password, or print/copy/edit restrictions)
- Batch processing: most tools take many files at once
- Results from password-protected files stay protected
- Bundled Ghostscript engine (AGPL, source at https://ghostscript.com) — fully offline

## Known limitations (v0.1)

- Moving, deleting or combining pages can't yet keep bookmarks, fillable form fields or
  internal links — Opus asks before saving when that would happen.
- A file with separate open and owner passwords is saved with one password (no restrictions).
- PDFs dropped onto the window from Explorer open fine, but Save will ask where to save.
- Redaction flattens affected pages to images (so the hidden data is truly gone); other pages keep their text.
- Editor text uses built-in fonts: non-Latin letters show as "?".
- Not yet built: live text re-flow editing, OCR, compare, Word/Excel/PowerPoint conversion, AI.
- Watermarks and page numbers use built-in fonts: non-Latin letters print as "?".

## For developers

```
cd apps/opus
npm install
npm test            # PDF engine tests
npm run tauri dev   # run the desktop app
npm run tauri build # build the installer
```

Tech: Tauri 2 (Rust) + React + TypeScript, pdf.js for rendering, pdf-lib (@cantoo fork) for editing.
