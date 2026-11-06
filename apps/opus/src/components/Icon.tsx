// Simple line icons drawn in SVG (no external icon font needed offline).
const paths: Record<string, string> = {
  open: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  save: "M5 3h11l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM7 3v6h9V3M7 21v-7h10v7",
  merge: "M7 3v5c0 3.5 5 4.5 5 9v4M17 3v5c0 3.5-5 4.5-5 9M9 19l3 3 3-3",
  split: "M6 3v18M18 3v18M10 8l-4 4 4 4M14 8l4 4-4 4",
  lock: "M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4",
  unlock: "M6 11h12v10H6zM8 11V7a4 4 0 0 1 7.5-2",
  "rotate-left": "M4 4v6h6M4.5 10A8 8 0 1 1 6 16",
  "rotate-right": "M20 4v6h-6M19.5 10A8 8 0 1 0 18 16",
  trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6",
  read: "M4 4h7a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H4zM20 4h-7a3 3 0 0 0-3 3v13a2 2 0 0 1 2-2h8z",
  grid: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  "zoom-in": "M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14zM21 21l-5-5M11 8v6M8 11h6",
  "zoom-out": "M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14zM21 21l-5-5M8 11h6",
  search: "M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14zM21 21l-5-5",
  undo: "M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3",
  redo: "M15 14l5-5-5-5M20 9H10a6 6 0 0 0 0 12h3",
  extract: "M14 3h7v7M21 3l-9 9M19 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5",
  close: "M6 6l12 12M18 6L6 18",
  command: "M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z",
  sidebar: "M4 4h16v16H4zM9 4v16",
  plus: "M12 5v14M5 12h14",
  back: "M15 5l-7 7 7 7",
  upload: "M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3",
  check: "M5 12.5l4.5 4.5L19 7.5",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  info: "M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM12 11v5M12 8h.01",
  up: "M6 15l6-6 6 6",
  down: "M6 9l6 6 6-6",
  reverse: "M7 4v16M7 20l-3-3M7 20l3-3M17 20V4M17 4l-3 3M17 4l3 3",
  compress: "M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5",
  repair: "M14.7 6.3a4 4 0 0 0-5.4 5.2L4 16.8V20h3.2l5.3-5.3a4 4 0 0 0 5.2-5.4l-2.5 2.5-2.3-.6-.6-2.3z",
  contrast: "M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM12 3v18M12 7h4M12 11h7M12 15h6",
  layers: "M12 3l9 5-9 5-9-5zM3 13l9 5 9-5",
  tag: "M3 12V4h8l10 10-8 8zM7.5 7.5h.01",
  image: "M4 4h16v16H4zM4 16l5-5 4 4 3-3 4 4M15 8.5h.01",
  "image-plus": "M4 4h11M4 4v16h16v-9M4 16l5-5 4 4 3-3 4 4M19 3v6M16 6h6",
  images: "M7 7h13v13H7zM4 4h13M4 4v13M7 17l4-4 3 3 2-2 4 4",
  archive: "M3 4h18v4H3zM5 8v12h14V8M10 12h4",
  table: "M4 4h16v16H4zM4 10h16M4 15h16M10 4v16",
  scan: "M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4M7 12h10",
  hash: "M9 4L7 20M17 4l-2 16M4 9h16M3 15h16",
  stamp: "M9 4h6l-1 7h4a2 2 0 0 1 2 2v2H4v-2a2 2 0 0 1 2-2h4zM5 19h14",
  crop: "M6 2v16h16M2 6h16v16",
  pen: "M4 20h4L19 9l-4-4L4 16zM13 7l4 4",
  compare: "M4 4h7v16H4zM13 4h7v16h-7M7 9h1M7 13h1M16 9h1M16 13h1",
  signature: "M3 17c3 0 4-9 6-9s1 9 3 9 2-4 3-4 1 3 2 3h4M3 21h18",
  redact: "M4 5h16v14H4zM7 9h10v2H7zM7 13h6v2H7z",
  home: "M4 11l8-7 8 7v9H4zM10 20v-6h4v6",
  sun: "M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4",
  moon: "M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z",
  monitor: "M3 4h18v12H3zM8 20h8M12 16v4",
  tools: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM16.5 13v7M13 16.5h7",
  file: "M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6",
};

export function Icon({ name, size = 18 }: { name: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name] ?? paths.file} />
    </svg>
  );
}
