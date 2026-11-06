// Remembers recently opened files (paths only, never contents) on this PC.
export interface Recent {
  path: string;
  name: string;
  at: number;
}

const KEY = "opus.recents.v1";

export function loadRecents(): Recent[] {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(list) ? list.filter((r) => r && typeof r.path === "string") : [];
  } catch {
    return [];
  }
}

function store(list: Recent[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, 20)));
  } catch {
    /* storage unavailable: recents just won't persist */
  }
}

export function addRecent(path: string, name: string): Recent[] {
  const list = [{ path, name, at: Date.now() }, ...loadRecents().filter((r) => r.path !== path)];
  store(list);
  return list;
}

export function forgetRecent(path: string): Recent[] {
  const list = loadRecents().filter((r) => r.path !== path);
  store(list);
  return list;
}

export type Theme = "system" | "dark" | "light";
const THEME_KEY = "opus.theme";

export function loadTheme(): Theme {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === "dark" || t === "light" ? t : "system";
  } catch {
    return "system";
  }
}

export function saveTheme(t: Theme) {
  try {
    localStorage.setItem(THEME_KEY, t);
  } catch {
    /* ignore */
  }
}
