// Small localStorage helpers for persisted UI preferences (panel sizes, map
// view, sort order, display toggles). SSR-safe: reads/writes are no-ops on
// the server, matching the guard pattern already used ad hoc across
// page.tsx/FTContactsPanel.tsx before this was extracted.

export function loadNumberArray(key: string, fallback: number[]): number[] {
  if (typeof window === 'undefined') return fallback;
  const raw = localStorage.getItem(key);
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length === fallback.length && parsed.every(n => typeof n === 'number' && Number.isFinite(n))) {
      return parsed;
    }
  } catch { /* malformed — fall back */ }
  return fallback;
}

export function saveNumberArray(key: string, value: number[]): void {
  if (typeof window !== 'undefined') localStorage.setItem(key, JSON.stringify(value));
}

export function loadNumber(key: string, fallback: number): number {
  if (typeof window === 'undefined') return fallback;
  const raw = localStorage.getItem(key);
  if (raw === null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function saveNumber(key: string, value: number): void {
  if (typeof window !== 'undefined') localStorage.setItem(key, String(value));
}

export function loadBoolean(key: string, fallback: boolean): boolean {
  if (typeof window === 'undefined') return fallback;
  const raw = localStorage.getItem(key);
  return raw === null ? fallback : raw === 'true';
}

export function saveBoolean(key: string, value: boolean): void {
  if (typeof window !== 'undefined') localStorage.setItem(key, String(value));
}

export function loadString<T extends string>(key: string, fallback: T, valid: readonly T[]): T {
  if (typeof window === 'undefined') return fallback;
  const raw = localStorage.getItem(key);
  return (valid as readonly string[]).includes(raw ?? '') ? (raw as T) : fallback;
}

export function saveString(key: string, value: string): void {
  if (typeof window !== 'undefined') localStorage.setItem(key, value);
}

/** Loads a JSON object, merged shallowly onto `fallback` so a partially-valid
 *  (or older-shape) stored value still yields every expected field rather
 *  than being discarded wholesale — new fields added after a value was
 *  already saved just fall back to their default instead of nulling the rest. */
export function loadObject<T extends object>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  const raw = localStorage.getItem(key);
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ...fallback, ...parsed };
    }
  } catch { /* malformed — fall back */ }
  return fallback;
}

export function saveObject<T extends object>(key: string, value: T): void {
  if (typeof window !== 'undefined') localStorage.setItem(key, JSON.stringify(value));
}
