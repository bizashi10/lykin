// Organize view: a grid of pages you can select, drag to reorder, rotate and delete.
import { useRef, useState } from "react";
import type { PageRef, Source } from "../lib/pdfops";
import { PageCanvas } from "./PageCanvas";
import { Icon } from "./Icon";

interface Props {
  pages: PageRef[];
  sources: Map<string, Source>;
  selected: Set<string>;
  onSelect: (keys: Set<string>) => void;
  onMove: (keys: string[], toIndex: number) => void;
  onRotate: (keys: string[], delta: number) => void;
  onDelete: (keys: string[]) => void;
  onOpenPage: (index: number) => void;
  onDropFiles: (files: File[], atIndex: number) => void;
  thumbWidth: number;
}

export function Organizer(props: Props) {
  const { pages, sources, selected, onSelect, thumbWidth } = props;
  const anchor = useRef<number | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const dragKeys = useRef<string[] | null>(null);

  const click = (e: React.MouseEvent, i: number) => {
    const key = pages[i].key;
    if (e.shiftKey && anchor.current !== null) {
      const [a, b] = [Math.min(anchor.current, i), Math.max(anchor.current, i)];
      const next = new Set(e.ctrlKey || e.metaKey ? selected : []);
      for (let k = a; k <= b; k++) next.add(pages[k].key);
      onSelect(next);
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(selected);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      onSelect(next);
    } else {
      onSelect(new Set([key]));
    }
    anchor.current = i;
  };

  const indexFromEvent = (e: React.DragEvent, i: number) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return e.clientX < rect.left + rect.width / 2 ? i : i + 1;
  };

  const isFileDrag = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes("Files");

  return (
    <div
      className="organizer"
      onClick={(e) => {
        if (e.target === e.currentTarget) onSelect(new Set());
      }}
      onDragOver={(e) => {
        if (dragKeys.current || isFileDrag(e)) {
          e.preventDefault();
          if (e.target === e.currentTarget) setDropAt(pages.length);
        }
      }}
      onDragLeave={(e) => {
        if (e.target === e.currentTarget) setDropAt(null);
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const at = dropAt ?? pages.length;
        setDropAt(null);
        if (dragKeys.current) props.onMove(dragKeys.current, at);
        else if (e.dataTransfer.files.length) props.onDropFiles(Array.from(e.dataTransfer.files), at);
        dragKeys.current = null;
      }}
    >
      {pages.map((p, i) => {
        const isSel = selected.has(p.key);
        return (
          <div
            key={p.key}
            className={`card ${isSel ? "selected" : ""} ${dropAt === i ? "drop-before" : ""} ${
              dropAt === i + 1 && i === pages.length - 1 ? "drop-after" : ""
            }`}
            style={{ width: thumbWidth + 20 }}
            draggable
            data-card-index={i}
            onClick={(e) => click(e, i)}
            onDoubleClick={() => props.onOpenPage(i)}
            onDragStart={(e) => {
              const keys = isSel ? pages.filter((x) => selected.has(x.key)).map((x) => x.key) : [p.key];
              if (!isSel) onSelect(new Set([p.key]));
              dragKeys.current = keys;
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/plain", keys.join(","));
            }}
            onDragEnd={() => {
              dragKeys.current = null;
              setDropAt(null);
            }}
            onDragOver={(e) => {
              if (!dragKeys.current && !isFileDrag(e)) return;
              e.preventDefault();
              e.stopPropagation();
              setDropAt(indexFromEvent(e, i));
            }}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              const at = indexFromEvent(e, i);
              setDropAt(null);
              if (dragKeys.current) props.onMove(dragKeys.current, at);
              else if (e.dataTransfer.files.length) props.onDropFiles(Array.from(e.dataTransfer.files), at);
              dragKeys.current = null;
            }}
          >
            <div className="card-page">
              <PageCanvas source={sources.get(p.sourceId)!} index={p.index} rotation={p.rotation} width={thumbWidth} preload={400} />
              <div className="card-actions" onClick={(e) => e.stopPropagation()}>
                <button title="Rotate left" onClick={() => props.onRotate([p.key], -90)}>
                  <Icon name="rotate-left" />
                </button>
                <button title="Rotate right" onClick={() => props.onRotate([p.key], 90)}>
                  <Icon name="rotate-right" />
                </button>
                <button title="Delete page" className="danger" onClick={() => props.onDelete([p.key])}>
                  <Icon name="trash" />
                </button>
              </div>
            </div>
            <div className="card-label">{i + 1}</div>
          </div>
        );
      })}
    </div>
  );
}
