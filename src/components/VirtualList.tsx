'use client';

/**
 * Dependency-free windowed list.
 *
 * Renders only the rows intersecting the scrollport (+ overscan), absolutely
 * positioned inside a spacer sized to the full list height, so DOM size stays
 * constant no matter how many items exist. Row heights come from a callback
 * (prefix-summed once per items/heightsVersion change), which keeps
 * mixed-height rows cheap — message rows vs window separators, collapsed vs
 * expanded contact cards.
 *
 * Bump `heightsVersion` whenever itemHeight would return new values for the
 * same items (e.g. a card expanded) — heights are intentionally not
 * re-measured per render.
 */

import { ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

export default function VirtualList<T>({
  items,
  itemKey,
  itemHeight,
  renderItem,
  overscan = 6,
  className = '',
  heightsVersion = 0,
  scrollToIndex = -1,
  empty = null,
  preserveScrollOnPrepend = false,
}: {
  items: T[];
  itemKey: (item: T, index: number) => string;
  /** must be fast — called once per item per (items, heightsVersion) change */
  itemHeight: (item: T, index: number) => number;
  renderItem: (item: T, index: number) => ReactNode;
  overscan?: number;
  /** classes for the scroll container (must produce a bounded, scrollable box) */
  className?: string;
  heightsVersion?: number;
  /** when >= 0, smooth-scrolls that index into view (re-triggers on change) */
  scrollToIndex?: number;
  empty?: ReactNode;
  /**
   * For lists where new items are PREPENDED (newest-first feeds): when the
   * user has scrolled away from the top, keep whatever content they're
   * reading pinned in place as new rows land above it, instead of silently
   * shifting everything down by the height of what just arrived. Anchors on
   * the first key shared between the old and new item lists. Does nothing
   * while scrolled to (or within a few px of) the top, so watching new items
   * arrive live still works as expected.
   */
  preserveScrollOnPrepend?: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 0 });
  const rafRef = useRef<number | null>(null);

  const offsets = useMemo(() => {
    const off = new Float64Array(items.length + 1);
    for (let i = 0; i < items.length; i++) off[i + 1] = off[i] + itemHeight(items[i], i);
    return off;
    // itemHeight is intentionally not a dep — callers bump heightsVersion instead
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, heightsVersion]);
  const totalHeight = items.length ? offsets[items.length] : 0;

  // Remember the previous render's items/offsets/keys so a prepend can be
  // detected and compensated for before the browser paints the new layout.
  const prevRef = useRef<{ items: T[]; offsets: Float64Array; keys: Map<string, number> } | null>(null);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    const prev = prevRef.current;
    if (preserveScrollOnPrepend && el && prev && prev.items.length > 0 && items.length > 0) {
      // Only compensate once the user has scrolled away from the very top —
      // at the top they're watching live, so let new rows appear naturally.
      if (el.scrollTop > 4) {
        // Find the first item still present in both lists (walk the new list
        // top-down so a block prepend — e.g. a whole decode window — resolves
        // to the shift in one step instead of one row at a time).
        for (let i = 0; i < items.length; i++) {
          const key = itemKey(items[i], i);
          const prevIndex = prev.keys.get(key);
          if (prevIndex !== undefined) {
            const shift = offsets[i] - prev.offsets[prevIndex];
            if (shift !== 0) el.scrollTop += shift;
            break;
          }
        }
      }
    }
    prevRef.current = {
      items,
      offsets,
      keys: new Map(items.map((it, i) => [itemKey(it, i), i])),
    };
    // itemKey is assumed stable (callers pass a pure function); only items/offsets
    // identity should retrigger this comparison
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, offsets, preserveScrollOnPrepend]);

  // Track scroll position (rAF-coalesced) and viewport size (ResizeObserver).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => {
      rafRef.current = null;
      setViewport(prev => {
        const next = { top: el.scrollTop, height: el.clientHeight };
        return prev.top === next.top && prev.height === next.height ? prev : next;
      });
    };
    const onScroll = () => {
      if (rafRef.current === null) rafRef.current = requestAnimationFrame(update);
    };
    update();
    el.addEventListener('scroll', onScroll, { passive: true });
    const ro = new ResizeObserver(onScroll);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', onScroll);
      ro.disconnect();
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  useEffect(() => {
    if (scrollToIndex < 0 || scrollToIndex >= items.length || !scrollRef.current) return;
    const el = scrollRef.current;
    const top = offsets[scrollToIndex];
    const bottom = offsets[scrollToIndex + 1];
    // only scroll if not already fully visible (mirror scrollIntoView 'nearest')
    if (top < el.scrollTop || bottom > el.scrollTop + el.clientHeight) {
      el.scrollTo({ top: Math.max(0, top - 8), behavior: 'smooth' });
    }
    // offsets identity changes with items/heights; scroll only on target change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollToIndex]);

  // Binary search for the first row whose bottom edge is below the viewport top
  let lo = 0, hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid + 1] <= viewport.top) lo = mid + 1;
    else hi = mid;
  }
  const start = Math.max(0, lo - overscan);
  let end = lo;
  const viewBottom = viewport.top + viewport.height;
  while (end < items.length && offsets[end] < viewBottom) end++;
  end = Math.min(items.length, end + overscan);

  const visible: ReactNode[] = [];
  for (let i = start; i < end; i++) {
    visible.push(
      <div
        key={itemKey(items[i], i)}
        style={{ position: 'absolute', top: offsets[i], left: 0, right: 0, height: offsets[i + 1] - offsets[i] }}
      >
        {renderItem(items[i], i)}
      </div>,
    );
  }

  return (
    <div ref={scrollRef} className={className}>
      {items.length === 0 ? empty : (
        <div style={{ height: totalHeight, position: 'relative' }}>
          {visible}
        </div>
      )}
    </div>
  );
}
