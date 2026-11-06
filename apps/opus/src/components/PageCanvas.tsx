// Shows one PDF page. Only draws it once it scrolls into view, and redraws
// when the width or rotation changes.
import { useEffect, useRef, useState } from "react";
import type { Source } from "../lib/pdfops";
import { pageSize, renderInto } from "../lib/render";

interface Props {
  source: Source;
  index: number;
  rotation: number;
  width: number;
  className?: string;
  /** Pixels of margin around the viewport in which to start rendering early. */
  preload?: number;
}

const sizeCache = new Map<string, { width: number; height: number }>();

export function usePageAspect(source: Source, index: number, rotation: number) {
  const key = `${source.id}:${index}:${rotation}`;
  const [size, setSize] = useState(() => sizeCache.get(key));
  useEffect(() => {
    const cached = sizeCache.get(key);
    if (cached) {
      setSize(cached);
      return;
    }
    let alive = true;
    pageSize(source, index, rotation)
      .then((s) => {
        sizeCache.set(key, s);
        if (alive) setSize(s);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [key, source, index, rotation]);
  return size ? size.height / size.width : 1.294;
}

export function PageCanvas({ source, index, rotation, width, className, preload = 600 }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const [state, setState] = useState<"idle" | "ready" | "error">("idle");
  const aspect = usePageAspect(source, index, rotation);
  const height = Math.round(width * aspect);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => entries.forEach((e) => setVisible(e.isIntersecting)),
      { rootMargin: `${preload}px 0px` },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [preload]);

  useEffect(() => {
    if (!visible || !canvasRef.current || width < 8) return;
    // Wait a moment so fast scrolling/zooming doesn't render every frame.
    let job: ReturnType<typeof renderInto> | null = null;
    const t = setTimeout(() => {
      job = renderInto(canvasRef.current!, source, index, rotation, width);
      job.done.then(() => setState("ready")).catch(() => setState("error"));
    }, 60);
    return () => {
      clearTimeout(t);
      job?.cancel();
    };
  }, [visible, source, index, rotation, width]);

  return (
    <div
      ref={wrapRef}
      className={`page-canvas ${className ?? ""} ${state}`}
      style={{ width, height }}
      data-page-index={index}
    >
      <canvas ref={canvasRef} style={{ width, height }} />
      {state === "error" && <div className="page-error">This page could not be displayed</div>}
    </div>
  );
}
