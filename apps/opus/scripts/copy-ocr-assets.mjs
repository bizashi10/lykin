// Assembles the offline OCR assets into public/tesseract so Opus runs Tesseract
// fully offline: the WASM core + worker come from the installed package, the
// English language data is committed (gzipped) under vendor/.
import { cpSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dest = join(root, "public", "tesseract");
mkdirSync(dest, { recursive: true });

const core = join(root, "node_modules", "tesseract.js-core");
for (const base of ["tesseract-core-lstm", "tesseract-core-simd-lstm", "tesseract-core-relaxedsimd-lstm"]) {
  for (const ext of [".js", ".wasm", ".wasm.js"]) copyFileSync(join(core, base + ext), join(dest, base + ext));
}
copyFileSync(join(root, "node_modules", "tesseract.js", "dist", "worker.min.js"), join(dest, "worker.min.js"));
cpSync(join(root, "vendor", "tesseract", "eng.traineddata.gz"), join(dest, "eng.traineddata.gz"));
console.log("OCR assets copied to public/tesseract");
