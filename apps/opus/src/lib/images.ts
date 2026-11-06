// Image helpers that need a browser (canvas): decoding any image format,
// fixing phone-photo orientation, and rendering PDF pages to pictures.

import type { ImageInput } from "./tools";
import type { Source } from "./pdfops";
import { getPage } from "./render";

const IMAGE_RE = /\.(jpe?g|png|webp|gif|bmp|avif|tiff?|ico)$/i;
export const isImageName = (name: string) => IMAGE_RE.test(name);

function sniff(bytes: Uint8Array): "jpg" | "png" | "other" {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "jpg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  return "other";
}

function canvasToBytes(canvas: HTMLCanvasElement, type: "image/png" | "image/jpeg", quality = 0.92): Promise<Uint8Array> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? b.arrayBuffer().then((a) => resolve(new Uint8Array(a)), reject) : reject(new Error("Could not encode image"))),
      type,
      quality,
    ),
  );
}

/**
 * Turns any image the browser can read into PNG/JPEG bytes ready for a PDF,
 * applying the photo's orientation (so phone pictures aren't sideways).
 */
export async function prepareImage(bytes: Uint8Array, name: string): Promise<ImageInput & { name: string }> {
  const kind = sniff(bytes);
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([bytes as BlobPart]), { imageOrientation: "from-image" });
  } catch {
    throw new Error(`${name} is not an image Opus can read`);
  }
  const { width, height } = bitmap;
  // PNGs embed as-is (lossless). JPEGs embed as-is unless they need rotating.
  if (kind === "png") {
    bitmap.close();
    return { name, bytes, type: "png", width, height };
  }
  if (kind === "jpg") {
    // If the decoded size matches the raw size the photo needs no rotation.
    const raw = await createImageBitmap(new Blob([bytes as BlobPart]), { imageOrientation: "none" }).catch(() => null);
    const same = raw && raw.width === width && raw.height === height;
    raw?.close();
    if (same) {
      bitmap.close();
      return { name, bytes, type: "jpg", width, height };
    }
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  // Keep transparency for formats that may have it.
  const keepAlpha = kind !== "jpg" && /\.(png|webp|gif|avif|ico)$/i.test(name);
  const out = await canvasToBytes(canvas, keepAlpha ? "image/png" : "image/jpeg", 0.93);
  return { name, bytes: out, type: keepAlpha ? "png" : "jpg", width, height };
}

/** Small preview URL for an image file. */
export function previewUrl(bytes: Uint8Array): string {
  return URL.createObjectURL(new Blob([bytes as BlobPart]));
}

export interface RenderedImage {
  name: string;
  bytes: Uint8Array;
}

/** Renders PDF pages to JPG or PNG files at a chosen resolution. */
export async function pdfToImages(
  source: Source,
  pages: number[],
  opts: { format: "jpg" | "png"; dpi: number; quality: number },
  baseName: string,
  onProgress?: (done: number, total: number) => void,
): Promise<RenderedImage[]> {
  const out: RenderedImage[] = [];
  const pad = String(source.pageCount).length;
  for (let k = 0; k < pages.length; k++) {
    const i = pages[k];
    const page = await getPage(source, i);
    let scale = opts.dpi / 72;
    let vp = page.getViewport({ scale, rotation: page.rotate });
    // Browsers cap canvas size; scale down huge pages instead of failing.
    const maxPixels = 120_000_000;
    if (vp.width * vp.height > maxPixels) {
      scale *= Math.sqrt(maxPixels / (vp.width * vp.height));
      vp = page.getViewport({ scale, rotation: page.rotate });
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, viewport: vp }).promise;
    const bytes = await canvasToBytes(canvas, opts.format === "png" ? "image/png" : "image/jpeg", opts.quality);
    canvas.width = canvas.height = 0; // free memory right away
    out.push({ name: `${baseName}-page-${String(i + 1).padStart(pad, "0")}.${opts.format}`, bytes });
    onProgress?.(k + 1, pages.length);
  }
  return out;
}

/** Pulls out the images embedded in a PDF's pages (as PNG). */
export async function extractImages(source: Source, baseName: string): Promise<RenderedImage[]> {
  const out: RenderedImage[] = [];
  const pdfjs = await import("pdfjs-dist");
  for (let i = 0; i < source.pageCount; i++) {
    const page = await getPage(source, i);
    const ops = await page.getOperatorList();
    let n = 0;
    for (let k = 0; k < ops.fnArray.length; k++) {
      if (ops.fnArray[k] !== pdfjs.OPS.paintImageXObject) continue;
      const id = ops.argsArray[k][0] as string;
      const img = await new Promise<{ bitmap?: ImageBitmap; data?: Uint8ClampedArray; width: number; height: number } | null>((resolve) => {
        try {
          const objs = id.startsWith("g_") ? page.commonObjs : page.objs;
          objs.get(id, (v: unknown) => resolve(v as never));
        } catch {
          resolve(null);
        }
      });
      if (!img || img.width < 16 || img.height < 16) continue;
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d")!;
      if (img.bitmap) ctx.drawImage(img.bitmap, 0, 0);
      else if (img.data && img.data.length === img.width * img.height * 4) {
        ctx.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
      } else continue;
      n++;
      out.push({ name: `${baseName}-p${i + 1}-${n}.png`, bytes: await canvasToBytes(canvas, "image/png") });
    }
  }
  return out;
}
