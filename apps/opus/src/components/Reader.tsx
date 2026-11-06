// Reading view: page thumbnails on the left, scrolling pages on the right.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PageRef, Source } from "../lib/pdfops";
import { PageCanvas } from "./PageCanvas";

export type Zoom = "fit" | number;

interface Props {
  pages: PageRef[];
  sources: Map<string, Source>;
  zoom: Zoom;
  current: number;
  onCurrent: (i: number) => void;
  /** Bumped whenever the app wants to scroll to `current`. */
  jumpSignal: number;
  showThumbs: boolean;
  highlights?: Set<number>;
}

const BASE_WIDTH = 816; // 100% = a US-Letter page at 96 dpi
const GAP = 16;

export function Reader({ pages, sources, zoom, current, onCurrent, jumpSignal, showThumbs, highlights }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const thumbsRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(900);
  const suppressScroll = useRef(false);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setContainerWidth(el.clientWidth));
    ro.observe(el);
    setContainerWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const width =
    zoom === "fit"
      ? Math.max(200, Math.min(containerWidth - 64, 1100))
      : Math.round(BASE_WIDTH * zoom);

  const scrollToPage = useCallback((i: number, smooth = false) => {
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-reader-index="${i}"]`);
    if (!el || !scrollRef.current) return;
    suppressScroll.current = true;
    scrollRef.current.scrollTo({ top: el.offsetTop - GAP, behavior: smooth ? "smooth" : "auto" });
    setTimeout(() => (suppressScroll.current = false), smooth ? 500 : 50);
  }, []);

  useEffect(() => {
    scrollToPage(current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpSignal]);

  // Keep the same page in view when zooming.
  const lastWidth = useRef(width);
  useLayoutEffect(() => {
    if (lastWidth.current !== width) {
      lastWidth.current = width;
      requestAnimationFrame(() => scrollToPage(current));
    }
  }, [width, current, scrollToPage]);

  const onScroll = () => {
    if (suppressScroll.current) return;
    const el = scrollRef.current;
    if (!el) return;
    const mid = el.scrollTop + el.clientHeight * 0.35;
    const nodes = el.querySelectorAll<HTMLElement>("[data-reader-index]");
    let best = 0;
    for (const n of nodes) {
      if (n.offsetTop <= mid) best = Number(n.dataset.readerIndex);
      else break;
    }
    if (best !== current) onCurrent(best);
  };

  // Keep the active thumbnail visible.
  useEffect(() => {
    const t = thumbsRef.current?.querySelector<HTMLElement>(`[data-thumb-index="${current}"]`);
    t?.scrollIntoView({ block: "nearest" });
  }, [current]);

  return (
    <div className="reader">
      {showThumbs && (
        <div className="thumbs" ref={thumbsRef} aria-label="Pages">
          {pages.map((p, i) => (
            <button
              key={p.key}
              className={`thumb ${i === current ? "active" : ""} ${highlights?.has(i) ? "hit" : ""}`}
              data-thumb-index={i}
              onClick={() => {
                onCurrent(i);
                scrollToPage(i, false);
              }}
              title={`Page ${i + 1}`}
            >
              <PageCanvas source={sources.get(p.sourceId)!} index={p.index} rotation={p.rotation} width={112} preload={300} />
              <span>{i + 1}</span>
            </button>
          ))}
        </div>
      )}
      <div className="reader-scroll" ref={scrollRef} onScroll={onScroll} tabIndex={0}>
        <div className="reader-column" style={{ gap: GAP, paddingTop: GAP }}>
          {pages.map((p, i) => (
            <div key={p.key} data-reader-index={i} className="reader-page">
              <PageCanvas source={sources.get(p.sourceId)!} index={p.index} rotation={p.rotation} width={width} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
