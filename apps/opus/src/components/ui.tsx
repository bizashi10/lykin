// Small shared form controls with a consistent look.
import type { ReactNode } from "react";

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="field">
      <div className="field-label">{label}</div>
      {children}
      {hint && <div className="field-hint">{hint}</div>}
    </div>
  );
}

export function Segmented<T extends string | number>({
  value, options, onChange, label,
}: { value: T; options: { value: T; label: ReactNode; title?: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="segmented-control" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className={o.value === value ? "on" : ""}
          onClick={() => onChange(o.value)}
          title={o.title}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Slider({
  value, min, max, step = 1, onChange, format, label,
}: { value: number; min: number; max: number; step?: number; onChange: (v: number) => void; format?: (v: number) => string; label: string }) {
  return (
    <div className="slider-row">
      <input type="range" min={min} max={max} step={step} value={value} aria-label={label} onChange={(e) => onChange(Number(e.target.value))} />
      <output>{format ? format(value) : value}</output>
    </div>
  );
}

const SWATCHES = ["#1b1f27", "#5b6577", "#c62f2f", "#cf8a1c", "#2f7d4f", "#2a5bd7", "#7a3fd1"];

export function ColorPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="swatches" role="radiogroup" aria-label="Colour">
      {SWATCHES.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value.toLowerCase() === c}
          aria-label={c}
          className={`swatch ${value.toLowerCase() === c ? "on" : ""}`}
          style={{ background: c }}
          onClick={() => onChange(c)}
        />
      ))}
      <label className="swatch custom" title="Custom colour">
        <input type="color" value={value} onChange={(e) => onChange(e.target.value)} aria-label="Custom colour" />
      </label>
    </div>
  );
}

/** A 3×2 grid to pick a spot on the page. */
export function PositionPicker<T extends string>({ value, onChange, allowCenter }: { value: T; onChange: (v: T) => void; allowCenter?: boolean }) {
  const spots = ["top-left", "top-center", "top-right", ...(allowCenter ? ["center"] : []), "bottom-left", "bottom-center", "bottom-right"];
  return (
    <div className={`position-picker ${allowCenter ? "with-center" : ""}`} role="radiogroup" aria-label="Position">
      <div className="pp-page">
        {spots.map((s) => (
          <button
            key={s}
            type="button"
            role="radio"
            aria-checked={value === s}
            aria-label={s.replace("-", " ")}
            title={s.replace("-", " ")}
            className={`pp-spot pp-${s} ${value === s ? "on" : ""}`}
            onClick={() => onChange(s as T)}
          />
        ))}
      </div>
    </div>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-track" aria-hidden="true" />
      <span>{label}</span>
    </label>
  );
}
