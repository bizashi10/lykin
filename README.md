# Lykin

A personal, offline office suite for Windows. No ads, no account — files never leave the PC.

| App | Replaces | Colour | Status |
|---|---|---|---|
| **Opus** | Adobe Acrobat (PDF) | Red | v0.1 in progress |
| **Prose** | Microsoft Word | Blue | planned |
| **Ordo** | Microsoft Excel | Green | planned |
| **Podium** | Microsoft PowerPoint | Orange | planned |

## Getting the Opus installer

1. Open the **Actions** tab of this repository.
2. Click the latest **Build Opus for Windows** run with a green tick.
3. Under **Artifacts**, download **Opus-Windows-Installer**, unzip it, and run the `-setup.exe`.

Windows may show "Windows protected your PC" because the installer isn't signed yet:
click **More info → Run anyway**.

## Opus v0.1 features

- View PDFs (page sidebar, zoom, go to page, find text)
- Organize: drag to reorder, rotate, delete pages, undo/redo
- Merge several PDFs; add pages from another PDF
- Split by ranges, every N pages, or one file per page
- Extract selected pages to a new PDF
- Password-protect (AES-256), change or remove a password
- `Ctrl+K` command bar
- Opens PDFs double-clicked in Explorer

## Known limitations (v0.1)

- Moving, deleting or combining pages can't yet keep bookmarks, fillable form fields or
  internal links — Opus asks before saving when that would happen.
- A file with separate open and owner passwords is saved with one password (no restrictions).
- PDFs dropped onto the window from Explorer open fine, but Save will ask where to save.
- Not yet built: compress, OCR, annotations, fill & sign, redaction, conversion, AI.

## For developers

```
cd apps/opus
npm install
npm test            # PDF engine tests
npm run tauri dev   # run the desktop app
npm run tauri build # build the installer
```

Tech: Tauri 2 (Rust) + React + TypeScript, pdf.js for rendering, pdf-lib (@cantoo fork) for editing.
