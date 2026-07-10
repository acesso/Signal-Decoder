// Async contact enrichment — reverse geocoding (OSM Nominatim) and operator
// lookup (hamdb.org). These run independently of message parsing: results are
// cached and surfaced to the UI whenever they arrive, never blocking decode.

import { baseCallsign } from './parser';

export interface GeoInfo {
  country?: string;     // full country name in English
  countryCode?: string; // ISO-3166 alpha-2, uppercase
  flag?: string;        // country flag emoji
}

export interface OperatorInfo {
  name?: string;
  email?: string;
}

export function flagEmoji(countryCode: string): string {
  const cc = countryCode.toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return '';
  return String.fromCodePoint(...[...cc].map(c => 0x1f1e6 + c.charCodeAt(0) - 65));
}

// ── Grid → City/Country (Nominatim reverse geocoding) ─────────────────────────

const GEO_LS_KEY = 'ft-geo-cache-v3'; // v3: country-level only (city dropped)
const geoCache   = new Map<string, GeoInfo | null>();
const geoPending = new Map<string, Promise<GeoInfo | null>>();
// Nominatim usage policy caps at 1 request/second — serialize through a queue
let geoQueue: Promise<void> = Promise.resolve();
let geoLsLoaded = false;

function loadGeoLS() {
  if (geoLsLoaded || typeof window === 'undefined') return;
  geoLsLoaded = true;
  try {
    const raw = localStorage.getItem(GEO_LS_KEY);
    if (raw) {
      for (const [k, v] of Object.entries(JSON.parse(raw) as Record<string, GeoInfo>)) {
        geoCache.set(k, v);
      }
    }
  } catch { /* corrupted cache — start fresh */ }
}

function persistGeoLS() {
  try {
    const entries = Object.fromEntries(
      Array.from(geoCache.entries()).filter(([, v]) => v !== null),
    );
    localStorage.setItem(GEO_LS_KEY, JSON.stringify(entries));
  } catch { /* storage full/unavailable — cache stays in-memory only */ }
}

async function fetchGeo([lat, lon]: [number, number]): Promise<GeoInfo | null> {
  // zoom=3 → country-level result; cheaper for Nominatim and all we need
  const res = await fetch(
    `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=3&accept-language=en`,
  );
  if (!res.ok) return null;
  const data = await res.json();
  const a    = data?.address ?? {};
  const cc: string | undefined = a.country_code?.toUpperCase();
  if (!cc) return null;
  return { country: a.country, countryCode: cc, flag: flagEmoji(cc) };
}

export function resolveGridLocation(grid: string, latLon: [number, number]): Promise<GeoInfo | null> {
  loadGeoLS();
  const key    = grid.toUpperCase().slice(0, 4);
  const cached = geoCache.get(key);
  if (cached !== undefined) return Promise.resolve(cached);
  const pending = geoPending.get(key);
  if (pending) return pending;

  const task = new Promise<GeoInfo | null>(resolve => {
    geoQueue = geoQueue.then(async () => {
      const info = await fetchGeo(latLon).catch(() => null);
      geoCache.set(key, info);
      geoPending.delete(key);
      if (info) persistGeoLS();
      resolve(info);
      await new Promise(r => setTimeout(r, 1100));
    });
  });
  geoPending.set(key, task);
  return task;
}

// ── Callsign → operator name/email ────────────────────────────────────────────
// QRZ's XML API requires an authenticated (paid) session and has no CORS
// support, so the data lookup goes through hamdb.org instead; the visible
// callsign link in the UI still points at qrz.com.

const OP_CACHE_MAX = 1000;
const opCache   = new Map<string, OperatorInfo | null>();
const opPending = new Map<string, Promise<OperatorInfo | null>>();

async function fetchOperator(call: string): Promise<OperatorInfo | null> {
  const res = await fetch(`https://api.hamdb.org/${encodeURIComponent(call)}/json/rtty-decoder`);
  if (!res.ok) return null;
  const data = await res.json();
  const cs   = data?.hamdb?.callsign;
  if (!cs || cs.call === 'NOT_FOUND') return null;
  const clean = (v: unknown) => (typeof v === 'string' && v && v !== 'NOT_FOUND' ? v : undefined);
  const name  = [clean(cs.fname), clean(cs.name)].filter(Boolean).join(' ') || undefined;
  const email = clean(cs.email);
  if (!name && !email) return null;
  return { name, email };
}

export function lookupOperator(callsign: string): Promise<OperatorInfo | null> {
  // The registry only knows the operator's base call — for compound/portable
  // forms (9A/S55X/P, YS3/PY8WW) query that, not the leading prefix.
  const base   = baseCallsign(callsign.toUpperCase());
  const cached = opCache.get(base);
  if (cached !== undefined) return Promise.resolve(cached);
  const pending = opPending.get(base);
  if (pending) return pending;

  const task = fetchOperator(base)
    .catch(() => null)
    .then(info => {
      if (opCache.size >= OP_CACHE_MAX) {
        const first = opCache.keys().next().value;
        if (first !== undefined) opCache.delete(first);
      }
      opCache.set(base, info);
      opPending.delete(base);
      return info;
    });
  opPending.set(base, task);
  return task;
}

// ── Cache size accessors (for debug instrumentation) ──────────────────────────
export function getGeoCacheSize(): number { return geoCache.size; }
export function getOpCacheSize(): number  { return opCache.size; }
