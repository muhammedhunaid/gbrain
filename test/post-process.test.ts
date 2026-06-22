/**
 * T010 — deterministic layout post-processing tests.
 *
 * Tests postProcessPage, geometricFallback, and stitchAcrossPages.
 * Pure functions, no DB, no AI, no network.
 */

import { describe, test, expect } from 'bun:test';
import {
  postProcessPage,
  geometricFallback,
  stitchAcrossPages,
  DEFAULT_HEADER_FOOTER_BAND,
  DEFAULT_PADDING,
  DEFAULT_MIN_CONFIDENCE,
  DEFAULT_FALLBACK_BANDS,
  DEFAULT_STITCH_BAND,
} from '../src/core/ingestion/visual/post-process.ts';
import type { LayoutRegion } from '../src/core/ai/layout/detect-layout.ts';

// ---- helpers ----------------------------------------------------------------

function region(
  overrides: Partial<LayoutRegion> & {
    type?: LayoutRegion['type'];
    bbox?: { x0: number; y0: number; x1: number; y1: number };
  } = {},
): LayoutRegion {
  return {
    type: 'text',
    bbox: { x0: 0.1, y0: 0.2, x1: 0.9, y1: 0.8 },
    reading_order: 0,
    confidence: 0.9,
    ...overrides,
  };
}

// ---- bbox clamp + degenerate drop -------------------------------------------

describe('postProcessPage — bbox clamp', () => {
  test('passes through valid bbox unchanged (aside from padding)', () => {
    const r = region({ bbox: { x0: 0.1, y0: 0.2, x1: 0.9, y1: 0.8 } });
    const units = postProcessPage([r], 1, { padding: 0 });
    expect(units).toHaveLength(1);
    expect(units[0].bbox[0]).toEqual({ x0: 0.1, y0: 0.2, x1: 0.9, y1: 0.8 });
  });

  test('clamps out-of-range coords into [0,1]', () => {
    const r = region({ bbox: { x0: -0.1, y0: -0.05, x1: 1.2, y1: 0.8 } });
    const units = postProcessPage([r], 1, { padding: 0 });
    expect(units).toHaveLength(1);
    const box = units[0].bbox[0];
    expect(box.x0).toBeGreaterThanOrEqual(0);
    expect(box.y0).toBeGreaterThanOrEqual(0);
    expect(box.x1).toBeLessThanOrEqual(1);
    expect(box.y1).toBeLessThanOrEqual(1);
  });

  test('drops degenerate bbox where x0 >= x1 after clamp', () => {
    const r = region({ bbox: { x0: 0.5, y0: 0.2, x1: 0.5, y1: 0.8 } });
    const units = postProcessPage([r], 1, { padding: 0 });
    // Degenerate (x0 == x1) before padding — should be dropped
    expect(units.length).toBe(0);
  });

  test('drops degenerate bbox where y0 >= y1 after clamp', () => {
    const r = region({ bbox: { x0: 0.1, y0: 0.8, x1: 0.9, y1: 0.2 } });
    const units = postProcessPage([r], 1, { padding: 0 });
    expect(units.length).toBe(0);
  });

  test('drops degenerate bbox that collapses to zero width after clamp', () => {
    // Coords that normalize to x0 > x1 after swap and clamp
    const r = region({ bbox: { x0: 1.1, y0: 0.2, x1: 1.5, y1: 0.8 } });
    const units = postProcessPage([r], 1, { padding: 0 });
    expect(units.length).toBe(0);
  });
});

// ---- header/footer drop -----------------------------------------------------

describe('postProcessPage — header/footer drop', () => {
  test('drops a short region at the very top (running header)', () => {
    // Sits entirely within top 6% band, small height
    const r = region({ bbox: { x0: 0.1, y0: 0.01, x1: 0.9, y1: 0.04 } });
    const units = postProcessPage([r], 1, { padding: 0 });
    expect(units.length).toBe(0);
  });

  test('drops a short region at the very bottom (page number)', () => {
    const r = region({ bbox: { x0: 0.1, y0: 0.96, x1: 0.9, y1: 0.99 } });
    const units = postProcessPage([r], 1, { padding: 0 });
    expect(units.length).toBe(0);
  });

  test('keeps a tall body region that overlaps the top band', () => {
    // Starts in header zone but extends well into the body
    const r = region({ bbox: { x0: 0.1, y0: 0.01, x1: 0.9, y1: 0.5 } });
    const units = postProcessPage([r], 1, { padding: 0 });
    expect(units.length).toBe(1);
  });

  test('keeps a normal body region far from header/footer', () => {
    const r = region({ bbox: { x0: 0.1, y0: 0.2, x1: 0.9, y1: 0.7 } });
    const units = postProcessPage([r], 1, { padding: 0 });
    expect(units.length).toBe(1);
  });

  test('respects custom headerFooterBand', () => {
    // Band = 0.10; region sits within 0-0.08 — should be dropped with 0.10 band
    const r = region({ bbox: { x0: 0.1, y0: 0.01, x1: 0.9, y1: 0.08 } });
    const units = postProcessPage([r], 1, { padding: 0, headerFooterBand: 0.10 });
    expect(units.length).toBe(0);
  });
});

// ---- padding ----------------------------------------------------------------

describe('postProcessPage — padding', () => {
  test('expands bbox by padding', () => {
    const r = region({ bbox: { x0: 0.2, y0: 0.2, x1: 0.8, y1: 0.8 } });
    const units = postProcessPage([r], 1, { padding: 0.02 });
    expect(units).toHaveLength(1);
    const box = units[0].bbox[0];
    expect(box.x0).toBeCloseTo(0.18, 5);
    expect(box.y0).toBeCloseTo(0.18, 5);
    expect(box.x1).toBeCloseTo(0.82, 5);
    expect(box.y1).toBeCloseTo(0.82, 5);
  });

  test('padding is clamped to [0,1] at edges', () => {
    const r = region({ bbox: { x0: 0.01, y0: 0.01, x1: 0.99, y1: 0.99 } });
    const units = postProcessPage([r], 1, { padding: 0.05 });
    expect(units).toHaveLength(1);
    const box = units[0].bbox[0];
    expect(box.x0).toBe(0);
    expect(box.y0).toBe(0);
    expect(box.x1).toBe(1);
    expect(box.y1).toBe(1);
  });
});

// ---- geometric fallback (FR-011) -------------------------------------------

describe('postProcessPage — geometric fallback', () => {
  test('empty regions array → fallback with 3 bands', () => {
    const units = postProcessPage([], 5);
    expect(units.length).toBe(3);
    for (const u of units) {
      expect(u.provenance.source).toBe('geometric_fallback');
      expect(u.provenance.fallback).toBe(true);
      expect(u.page_numbers).toEqual([5]);
    }
  });

  test('all-low-confidence regions → fallback', () => {
    const regions = [
      region({ confidence: 0.1 }),
      region({ confidence: 0.2 }),
    ];
    const units = postProcessPage(regions, 2, { minConfidence: 0.35 });
    expect(units.length).toBe(3);
    expect(units[0].provenance.source).toBe('geometric_fallback');
  });

  test('at least one high-confidence region → no fallback', () => {
    const regions = [
      region({ confidence: 0.1 }),
      region({ confidence: 0.9 }),
    ];
    const units = postProcessPage(regions, 1, { minConfidence: 0.35, padding: 0 });
    // Only the high-confidence one should survive (low one stays if it's not dropped otherwise)
    const hasFallback = units.some(u => u.provenance.fallback);
    expect(hasFallback).toBe(false);
  });

  test('fallback never throws', () => {
    expect(() => postProcessPage([], 1)).not.toThrow();
    expect(() => geometricFallback(1)).not.toThrow();
    expect(() => geometricFallback(1, { fallbackBands: 0 })).not.toThrow();
  });

  test('geometricFallback bands cover full [0,1] height range', () => {
    const units = geometricFallback(3, { fallbackBands: 3 });
    expect(units[0].bbox[0].y0).toBeCloseTo(0, 5);
    expect(units[units.length - 1].bbox[0].y1).toBeCloseTo(1, 5);
    // Adjacent bands should not overlap or leave gaps
    for (let i = 0; i < units.length - 1; i++) {
      expect(units[i].bbox[0].y1).toBeCloseTo(units[i + 1].bbox[0].y0, 5);
    }
  });

  test('geometricFallback with custom band count', () => {
    const units = geometricFallback(1, { fallbackBands: 5 });
    expect(units.length).toBe(5);
    for (const u of units) {
      expect(u.type).toBe('text');
    }
  });
});

// ---- reading_order densification -------------------------------------------

describe('postProcessPage — reading_order densification', () => {
  test('renumbers reading_order to dense 0-based sequence', () => {
    const regions = [
      region({ reading_order: 10, bbox: { x0: 0.1, y0: 0.1, x1: 0.5, y1: 0.3 } }),
      region({ reading_order: 20, bbox: { x0: 0.1, y0: 0.35, x1: 0.5, y1: 0.5 } }),
      region({ reading_order: 99, bbox: { x0: 0.1, y0: 0.55, x1: 0.5, y1: 0.8 } }),
    ];
    const units = postProcessPage(regions, 1, { padding: 0 });
    const orders = units.map(u => u.reading_order);
    expect(orders).toEqual([0, 1, 2]);
  });

  test('sorted by original reading_order before densification', () => {
    const regions = [
      region({ reading_order: 5, bbox: { x0: 0.1, y0: 0.5, x1: 0.5, y1: 0.7 } }),
      region({ reading_order: 1, bbox: { x0: 0.1, y0: 0.1, x1: 0.5, y1: 0.3 } }),
    ];
    const units = postProcessPage(regions, 1, { padding: 0 });
    // The one with original order=1 should end up at reading_order=0
    // We check that reading_order 0 corresponds to the one with y0=0.1
    const first = units.find(u => u.reading_order === 0);
    expect(first?.bbox[0].y0).toBeCloseTo(0.1, 5);
  });
});

// ---- provenance ---------------------------------------------------------------

describe('postProcessPage — provenance', () => {
  test('normal regions get source:layout provenance', () => {
    const r = region();
    const units = postProcessPage([r], 1, { padding: 0 });
    expect(units[0].provenance.source).toBe('layout');
    expect(units[0].provenance.fallback).toBeUndefined();
  });

  test('page_numbers is [pageNumber] for each unit', () => {
    const r = region();
    const units = postProcessPage([r], 7, { padding: 0 });
    expect(units[0].page_numbers).toEqual([7]);
  });
});

// ---- stitchAcrossPages (FR-016) --------------------------------------------

describe('stitchAcrossPages', () => {
  function makeUnit(
    type: LayoutRegion['type'],
    page: number,
    y0: number,
    y1: number,
    readingOrder = 0,
    caption?: string,
  ) {
    return {
      type,
      page_numbers: [page],
      bbox: [{ x0: 0.1, y0, x1: 0.9, y1 }],
      reading_order: readingOrder,
      confidence: 0.9,
      caption,
      provenance: { source: 'layout' as const },
    };
  }

  test('merges a bottom-of-p1 table with top-of-p2 table', () => {
    const p1 = [makeUnit('table', 1, 0.2, 0.98)]; // touches bottom band (y1 >= 0.95)
    const p2 = [makeUnit('table', 2, 0.01, 0.5)]; // touches top band (y0 <= 0.05)
    const result = stitchAcrossPages([p1, p2]);
    expect(result.length).toBe(1);
    expect(result[0].page_numbers).toEqual([1, 2]);
    expect(result[0].bbox).toHaveLength(2);
  });

  test('merged unit carries the earliest reading_order', () => {
    const p1 = [makeUnit('table', 1, 0.2, 0.98, 3)];
    const p2 = [makeUnit('table', 2, 0.01, 0.5, 7)];
    const result = stitchAcrossPages([p1, p2]);
    expect(result[0].reading_order).toBe(3);
  });

  test('merged unit carries caption if either page had one', () => {
    const p1 = [makeUnit('table', 1, 0.2, 0.98, 0, 'Table 1')];
    const p2 = [makeUnit('table', 2, 0.01, 0.5)];
    const result = stitchAcrossPages([p1, p2]);
    expect(result[0].caption).toBe('Table 1');
  });

  test('leaves unrelated units on same pages intact', () => {
    const p1 = [
      makeUnit('table', 1, 0.2, 0.98), // stitchable
      makeUnit('text', 1, 0.1, 0.19),  // unrelated
    ];
    const p2 = [
      makeUnit('table', 2, 0.01, 0.5), // stitches with p1 table
      makeUnit('text', 2, 0.55, 0.85), // unrelated
    ];
    const result = stitchAcrossPages([p1, p2]);
    // 1 merged table + 2 text units = 3 total
    expect(result.length).toBe(3);
    const types = result.map(u => u.type);
    expect(types.filter(t => t === 'table')).toHaveLength(1);
    expect(types.filter(t => t === 'text')).toHaveLength(2);
  });

  test('does NOT stitch tables on non-adjacent pages', () => {
    const p1 = [makeUnit('table', 1, 0.2, 0.98)];
    const p2 = [makeUnit('text', 2, 0.1, 0.5)];  // no table on p2
    const p3 = [makeUnit('table', 3, 0.01, 0.5)]; // table on p3 not adjacent to p1's
    const result = stitchAcrossPages([p1, p2, p3]);
    // All 3 units pass through unstitched (no adjacent match)
    expect(result.length).toBe(3);
  });

  test('does NOT stitch different types (table vs figure)', () => {
    const p1 = [makeUnit('table', 1, 0.2, 0.98)];
    const p2 = [makeUnit('figure', 2, 0.01, 0.5)];
    const result = stitchAcrossPages([p1, p2]);
    expect(result.length).toBe(2);
    expect(result[0].page_numbers).toEqual([1]);
    expect(result[1].page_numbers).toEqual([2]);
  });

  test('figure can also stitch across pages', () => {
    const p1 = [makeUnit('figure', 1, 0.2, 0.98)];
    const p2 = [makeUnit('figure', 2, 0.01, 0.5)];
    const result = stitchAcrossPages([p1, p2]);
    expect(result.length).toBe(1);
    expect(result[0].page_numbers).toEqual([1, 2]);
  });

  test('three-page stitch: p1 table + p2 table (both edges) + p3 table', () => {
    const p1 = [makeUnit('table', 1, 0.2, 0.98)];
    const p2 = [makeUnit('table', 2, 0.01, 0.98)]; // touches top and bottom
    const p3 = [makeUnit('table', 3, 0.01, 0.5)];
    const result = stitchAcrossPages([p1, p2, p3]);
    expect(result.length).toBe(1);
    expect(result[0].page_numbers).toEqual([1, 2, 3]);
    expect(result[0].bbox).toHaveLength(3);
  });

  test('empty input returns empty', () => {
    expect(stitchAcrossPages([])).toEqual([]);
  });

  test('preserves order of non-stitched units', () => {
    const p1 = [
      makeUnit('text', 1, 0.1, 0.4, 0),
      makeUnit('text', 1, 0.5, 0.9, 1),
    ];
    const result = stitchAcrossPages([p1]);
    expect(result[0].reading_order).toBe(0);
    expect(result[1].reading_order).toBe(1);
  });
});

// ---- constants exported correctly ------------------------------------------

describe('exported default constants', () => {
  test('all default constants are exported and have sensible values', () => {
    expect(DEFAULT_HEADER_FOOTER_BAND).toBeGreaterThan(0);
    expect(DEFAULT_HEADER_FOOTER_BAND).toBeLessThan(0.2);
    expect(DEFAULT_PADDING).toBeGreaterThanOrEqual(0);
    expect(DEFAULT_PADDING).toBeLessThan(0.1);
    expect(DEFAULT_MIN_CONFIDENCE).toBeGreaterThan(0);
    expect(DEFAULT_MIN_CONFIDENCE).toBeLessThan(1);
    expect(DEFAULT_FALLBACK_BANDS).toBeGreaterThanOrEqual(2);
    expect(DEFAULT_STITCH_BAND).toBeGreaterThan(0);
    expect(DEFAULT_STITCH_BAND).toBeLessThan(0.2);
  });
});
