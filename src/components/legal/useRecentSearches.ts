"use client";

import { useState, useCallback } from "react";

const STORAGE_KEY = "arlis-recent-searches";
const MAX_RECENT = 8;

export type RecentSearch = {
  query: string;
  timestamp: number;
};

function readStorage(): RecentSearch[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (x): x is RecentSearch =>
          x &&
          typeof x === "object" &&
          typeof x.query === "string" &&
          typeof x.timestamp === "number",
      )
      .slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

function writeStorage(items: RecentSearch[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items.slice(0, MAX_RECENT)));
  } catch {
    // ignore
  }
}

/**
 * Hook for managing recent searches in localStorage.
 * Returns the list + add/remove/clear functions.
 *
 * Uses a lazy initializer (not setState-in-effect) to read from localStorage
 * synchronously on first render — avoids cascading renders.
 */
export function useRecentSearches() {
  const [recent, setRecent] = useState<RecentSearch[]>(() => readStorage());

  const addRecent = useCallback((query: string) => {
    const q = query.trim();
    if (!q) return;
    setRecent((prev) => {
      // Remove duplicates (same query, case-insensitive)
      const filtered = prev.filter(
        (r) => r.query.toLowerCase() !== q.toLowerCase(),
      );
      const next = [{ query: q, timestamp: Date.now() }, ...filtered].slice(0, MAX_RECENT);
      writeStorage(next);
      return next;
    });
  }, []);

  const removeRecent = useCallback((query: string) => {
    setRecent((prev) => {
      const next = prev.filter(
        (r) => r.query.toLowerCase() !== query.toLowerCase(),
      );
      writeStorage(next);
      return next;
    });
  }, []);

  const clearRecent = useCallback(() => {
    setRecent([]);
    writeStorage([]);
  }, []);

  return { recent, addRecent, removeRecent, clearRecent };
}
