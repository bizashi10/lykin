// Reading and filling AcroForm fields (the interactive boxes in a PDF form).

import {
  PDFDocument, PDFPage, PDFTextField, PDFCheckBox, PDFDropdown, PDFRadioGroup, PDFOptionList,
  type PDFWidgetAnnotation,
} from "@cantoo/pdf-lib";
import { frameOf } from "./tools.ts";
import { normalizeRotation } from "./pdfops.ts";
import type { Source } from "./pdfops.ts";

export type FieldKind = "text" | "checkbox" | "radio" | "dropdown" | "list";

export interface FieldWidget {
  name: string;
  kind: FieldKind;
  /** Page index (in the source file) the widget sits on. */
  page: number;
  /** Position in that page's view space (top-left origin, points). */
  rect: { x: number; y: number; w: number; h: number };
  options?: string[];
  /** For a radio widget: the value this particular button selects. */
  exportValue?: string;
  multiline?: boolean;
}

export interface FormInfo {
  fields: FieldWidget[];
  values: Record<string, string>;
}

/** Inverse of frameOf: PDF point → view (top-left) point on that page. */
function toView(page: PDFPage, px: number, py: number): { vx: number; vy: number } {
  const f = frameOf(page);
  const { x: ox, y: oy, width: W, height: H } = page.getCropBox();
  let vx: number, vyBottom: number;
  switch (normalizeRotation(page.getRotation().angle)) {
    case 90: vx = py - oy; vyBottom = ox + W - px; break;
    case 180: vx = ox + W - px; vyBottom = oy + H - py; break;
    case 270: vx = oy + H - py; vyBottom = px - ox; break;
    default: vx = px - ox; vyBottom = py - oy;
  }
  return { vx, vy: f.vh - vyBottom };
}

function widgetPage(doc: PDFDocument, pages: PDFPage[], byTag: Map<string, number>, widget: PDFWidgetAnnotation): number {
  const p = widget.P();
  if (p && byTag.has(p.tag)) return byTag.get(p.tag)!;
  // Fallback: the page whose Annots array holds this widget's dict.
  for (let i = 0; i < pages.length; i++) {
    const annots = pages[i].node.Annots();
    if (!annots) continue;
    for (let k = 0; k < annots.size(); k++) {
      if (doc.context.lookup(annots.get(k)) === widget.dict) return i;
    }
  }
  return -1;
}

export async function readForm(source: Source): Promise<FormInfo> {
  const doc = await PDFDocument.load(source.bytes, { updateMetadata: false, throwOnInvalidObject: false });
  const form = doc.getForm();
  const pages = doc.getPages();
  const byTag = new Map(pages.map((p, i) => [p.ref.tag, i]));
  const fields: FieldWidget[] = [];
  const values: Record<string, string> = {};

  for (const field of form.getFields()) {
    const name = field.getName();
    let kind: FieldKind = "text";
    let options: string[] | undefined;
    let multiline = false;
    if (field instanceof PDFTextField) {
      kind = "text"; multiline = field.isMultiline(); values[name] = field.getText() ?? "";
    } else if (field instanceof PDFCheckBox) {
      kind = "checkbox"; values[name] = field.isChecked() ? "on" : "";
    } else if (field instanceof PDFRadioGroup) {
      kind = "radio"; options = field.getOptions(); values[name] = field.getSelected() ?? "";
    } else if (field instanceof PDFDropdown) {
      kind = "dropdown"; options = field.getOptions(); values[name] = field.getSelected()[0] ?? "";
    } else if (field instanceof PDFOptionList) {
      kind = "list"; options = field.getOptions(); values[name] = field.getSelected()[0] ?? "";
    } else {
      continue;
    }

    const widgets = field.acroField.getWidgets();
    widgets.forEach((widget, wi) => {
      const pIdx = widgetPage(doc, pages, byTag, widget);
      if (pIdx < 0) return;
      const r = widget.getRectangle();
      const a = toView(pages[pIdx], r.x, r.y);
      const b = toView(pages[pIdx], r.x + r.width, r.y + r.height);
      fields.push({
        name, kind, page: pIdx,
        rect: { x: Math.min(a.vx, b.vx), y: Math.min(a.vy, b.vy), w: Math.abs(b.vx - a.vx), h: Math.abs(b.vy - a.vy) },
        options, multiline,
        // Use the option this widget selects (same namespace getSelected/select
        // use), so a radio shows as checked and saves correctly.
        exportValue: kind === "radio" ? options?.[wi] : undefined,
      });
    });
  }
  return { fields, values };
}

/** Applies field values to a document's form. Returns how many were set. */
export function applyFormValues(doc: PDFDocument, values: Record<string, string>): number {
  const form = doc.getForm();
  let applied = 0;
  for (const [name, value] of Object.entries(values)) {
    const field = form.getFieldMaybe(name);
    if (!field) continue;
    try {
      if (field instanceof PDFTextField) field.setText(value || undefined);
      else if (field instanceof PDFCheckBox) value ? field.check() : field.uncheck();
      else if (field instanceof PDFRadioGroup) {
        if (!value) field.clear();
        else {
          const opts = field.getOptions();
          // Match the stored value against the field's options; fall back to a
          // widget on-state name if that's what we were given.
          const target = opts.includes(value)
            ? value
            : opts[field.acroField.getWidgets().findIndex((w) => w.getOnValue()?.toString().replace(/^\//, "") === value)];
          if (target != null) field.select(target);
        }
      }
      else if (field instanceof PDFDropdown) value ? field.select(value) : field.clear();
      else if (field instanceof PDFOptionList) value ? field.select(value) : field.clear();
      else continue;
      applied++;
    } catch {
      /* leave fields we can't set */
    }
  }
  try {
    form.updateFieldAppearances();
  } catch { /* appearances best-effort */ }
  return applied;
}
