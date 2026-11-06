// Undo / redo for the page list. Each change pushes a snapshot.
import { useCallback, useRef, useState } from "react";

const LIMIT = 200;

export function useHistory<T>(initial: T) {
  const [present, setPresent] = useState<T>(initial);
  const past = useRef<T[]>([]);
  const future = useRef<T[]>([]);
  const [, force] = useState(0);
  const presentRef = useRef(present);
  presentRef.current = present;

  /** Apply a change that can be undone. */
  const commit = useCallback((next: T | ((cur: T) => T)) => {
    const cur = presentRef.current;
    const value = typeof next === "function" ? (next as (c: T) => T)(cur) : next;
    if (value === cur) return;
    past.current.push(cur);
    if (past.current.length > LIMIT) past.current.shift();
    future.current = [];
    presentRef.current = value;
    setPresent(value);
  }, []);

  /** Replace everything and forget history (e.g. opening a new file). */
  const reset = useCallback((value: T) => {
    past.current = [];
    future.current = [];
    presentRef.current = value;
    setPresent(value);
    force((n) => n + 1);
  }, []);

  const undo = useCallback(() => {
    const prev = past.current.pop();
    if (prev === undefined) return false;
    future.current.push(presentRef.current);
    presentRef.current = prev;
    setPresent(prev);
    return true;
  }, []);

  const redo = useCallback(() => {
    const next = future.current.pop();
    if (next === undefined) return false;
    past.current.push(presentRef.current);
    presentRef.current = next;
    setPresent(next);
    return true;
  }, []);

  return {
    present,
    commit,
    reset,
    undo,
    redo,
    canUndo: past.current.length > 0,
    canRedo: future.current.length > 0,
    /** Number of undoable steps; used to tell whether there are unsaved changes. */
    depth: past.current.length,
  };
}
