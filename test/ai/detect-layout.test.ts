/**
 * TDD tests for detectLayout (T009).
 *
 * Uses the visionFn DI seam so no network calls are made.
 * Each test passes its own `cache: new Map()` to remain isolated from the
 * module-level default cache.
 * Covers:
 *   - happy path: parses canned JSON array into sorted LayoutRegion[]
 *   - fenced JSON (```json...```) is stripped before parse
 *   - invalid region (bad type enum, bad bbox) is dropped silently
 *   - bbox values outside [0,1] are rejected (region dropped)
 *   - cache hit: visionFn called only once for two identical calls
 *   - unparseable response throws a clear Error
 */

import { describe, test, expect, mock } from 'bun:test';
import {
  detectLayout,
  type LayoutRegion,
  type UnitType,
} from '../../src/core/ai/layout/detect-layout.ts';

// ---- helpers ----------------------------------------------------------------

function makeImage(data = 'aGVsbG8=', mime = 'image/png') {
  return { data, mime };
}

/** Fresh cache — keeps tests isolated from the module-level default cache. */
function freshCache() {
  return new Map<string, LayoutRegion[]>();
}

// ---- a "valid" canned response from the LLM ---------------------------------

const VALID_REGIONS: LayoutRegion[] = [
  {
    type: 'figure',
    bbox: { x0: 0.1, y0: 0.1, x1: 0.9, y1: 0.4 },
    reading_order: 1,
    confidence: 0.95,
    caption: 'Fig. 1: Scatter plot',
  },
  {
    type: 'text',
    bbox: { x0: 0.0, y0: 0.5, x1: 1.0, y1: 0.8 },
    reading_order: 0,
    confidence: 0.88,
  },
  {
    type: 'table',
    bbox: { x0: 0.2, y0: 0.85, x1: 0.8, y1: 1.0 },
    reading_order: 2,
    confidence: 0.77,
  },
];

const VALID_JSON = JSON.stringify(VALID_REGIONS);

// Fenced variant
const FENCED_JSON = '```json\n' + VALID_JSON + '\n```';

// Response that includes one invalid region (bad type + bad bbox) mixed with valid ones
const WITH_INVALID_REGIONS = JSON.stringify([
  // valid region (reading_order=0)
  {
    type: 'text',
    bbox: { x0: 0.0, y0: 0.0, x1: 0.5, y1: 0.5 },
    reading_order: 0,
    confidence: 0.9,
  },
  // invalid: type not in enum
  {
    type: 'unknown_type',
    bbox: { x0: 0.0, y0: 0.0, x1: 0.5, y1: 0.5 },
    reading_order: 1,
    confidence: 0.7,
  },
  // invalid: bbox out of [0,1] (x1 > 1)
  {
    type: 'figure',
    bbox: { x0: 0.0, y0: 0.0, x1: 1.5, y1: 0.5 },
    reading_order: 2,
    confidence: 0.8,
  },
  // valid region (reading_order=3)
  {
    type: 'section',
    bbox: { x0: 0.1, y0: 0.6, x1: 0.9, y1: 0.9 },
    reading_order: 3,
    confidence: 0.85,
  },
]);

// ---- tests ------------------------------------------------------------------

describe('detectLayout — happy path', () => {
  test('parses a plain JSON array and returns LayoutRegion[] sorted by reading_order', async () => {
    const visionFn = mock(async () => VALID_JSON);
    const regions = await detectLayout(makeImage(), { visionFn, cache: freshCache() });

    expect(regions).toHaveLength(3);

    // Must be sorted by reading_order
    expect(regions[0].reading_order).toBe(0);
    expect(regions[1].reading_order).toBe(1);
    expect(regions[2].reading_order).toBe(2);

    // Spot-check field preservation
    expect(regions[1].type).toBe('figure');
    expect(regions[1].caption).toBe('Fig. 1: Scatter plot');
    expect(regions[1].confidence).toBe(0.95);
  });

  test('reading_order is coerced to integer', async () => {
    const floatOrder = JSON.stringify([
      {
        type: 'text',
        bbox: { x0: 0.0, y0: 0.0, x1: 1.0, y1: 1.0 },
        reading_order: 1.7,
        confidence: 0.9,
      },
    ]);
    const visionFn = mock(async () => floatOrder);
    const [region] = await detectLayout(makeImage(), { visionFn, cache: freshCache() });
    expect(region.reading_order).toBe(1);
    expect(Number.isInteger(region.reading_order)).toBe(true);
  });
});

describe('detectLayout — fence stripping', () => {
  test('strips ```json ... ``` fences before parsing', async () => {
    const visionFn = mock(async () => FENCED_JSON);
    const regions = await detectLayout(makeImage(), { visionFn, cache: freshCache() });
    expect(regions).toHaveLength(3);
    expect(regions[0].type).toBe('text');
  });

  test('strips plain ``` fences (no language tag)', async () => {
    const plainFenced = '```\n' + VALID_JSON + '\n```';
    const visionFn = mock(async () => plainFenced);
    const regions = await detectLayout(makeImage(), { visionFn, cache: freshCache() });
    expect(regions).toHaveLength(3);
  });
});

describe('detectLayout — validation / invalid region dropping', () => {
  test('drops region with unknown type, keeps valid regions', async () => {
    const visionFn = mock(async () => WITH_INVALID_REGIONS);
    const regions = await detectLayout(makeImage(), { visionFn, cache: freshCache() });

    // Only valid types
    for (const r of regions) {
      expect(['table', 'figure', 'chart', 'text', 'caption', 'section']).toContain(r.type);
    }

    // Exactly 2 valid ones (reading_order 0 + 3)
    expect(regions).toHaveLength(2);
  });

  test('drops region with bbox x1 > 1', async () => {
    const bad = JSON.stringify([
      {
        type: 'figure',
        bbox: { x0: 0.0, y0: 0.0, x1: 1.5, y1: 0.5 },
        reading_order: 0,
        confidence: 0.8,
      },
    ]);
    const visionFn = mock(async () => bad);
    const regions = await detectLayout(makeImage(), { visionFn, cache: freshCache() });
    expect(regions).toHaveLength(0);
  });

  test('drops region where x0 >= x1', async () => {
    const bad = JSON.stringify([
      {
        type: 'text',
        bbox: { x0: 0.5, y0: 0.0, x1: 0.3, y1: 0.5 },
        reading_order: 0,
        confidence: 0.9,
      },
    ]);
    const visionFn = mock(async () => bad);
    const regions = await detectLayout(makeImage(), { visionFn, cache: freshCache() });
    expect(regions).toHaveLength(0);
  });

  test('drops region where y0 >= y1', async () => {
    const bad = JSON.stringify([
      {
        type: 'text',
        bbox: { x0: 0.0, y0: 0.8, x1: 0.5, y1: 0.2 },
        reading_order: 0,
        confidence: 0.9,
      },
    ]);
    const visionFn = mock(async () => bad);
    const regions = await detectLayout(makeImage(), { visionFn, cache: freshCache() });
    expect(regions).toHaveLength(0);
  });

  test('drops region with confidence outside [0,1]', async () => {
    const bad = JSON.stringify([
      {
        type: 'text',
        bbox: { x0: 0.0, y0: 0.0, x1: 0.5, y1: 0.5 },
        reading_order: 0,
        confidence: 1.5, // invalid
      },
    ]);
    const visionFn = mock(async () => bad);
    const regions = await detectLayout(makeImage(), { visionFn, cache: freshCache() });
    expect(regions).toHaveLength(0);
  });

  test('does not throw on empty array response', async () => {
    const visionFn = mock(async () => '[]');
    const regions = await detectLayout(makeImage(), { visionFn, cache: freshCache() });
    expect(regions).toHaveLength(0);
  });
});

describe('detectLayout — error on unparseable response', () => {
  test('throws a clear Error when response is not valid JSON', async () => {
    const visionFn = mock(async () => 'Sorry, I cannot analyze this image.');
    await expect(detectLayout(makeImage(), { visionFn, cache: freshCache() })).rejects.toThrow(
      /failed to parse/i,
    );
  });

  test('throws a clear Error when response is valid JSON but not an array', async () => {
    const visionFn = mock(async () => '{"type": "text"}');
    await expect(detectLayout(makeImage(), { visionFn, cache: freshCache() })).rejects.toThrow(
      /expected.*array/i,
    );
  });
});

describe('detectLayout — caching', () => {
  test('returns cached result on second identical call without re-invoking visionFn', async () => {
    const visionFn = mock(async () => VALID_JSON);
    const cache = new Map<string, LayoutRegion[]>();

    const img = makeImage('dGVzdA==');

    const first = await detectLayout(img, { visionFn, cache });
    const second = await detectLayout(img, { visionFn, cache });

    // visionFn called only once
    expect(visionFn).toHaveBeenCalledTimes(1);

    // Both calls return the same regions
    expect(first).toEqual(second);
  });

  test('different images bypass the cache', async () => {
    const visionFn = mock(async () => VALID_JSON);
    const cache = new Map<string, LayoutRegion[]>();

    await detectLayout(makeImage('aW1hZ2Ux'), { visionFn, cache });
    await detectLayout(makeImage('aW1hZ2Uy'), { visionFn, cache });

    expect(visionFn).toHaveBeenCalledTimes(2);
  });

  test('different models bypass the cache', async () => {
    const visionFn = mock(async () => VALID_JSON);
    const cache = new Map<string, LayoutRegion[]>();
    const img = makeImage('c2FtZQ==');

    await detectLayout(img, { visionFn, cache, model: 'anthropic:model-a' });
    await detectLayout(img, { visionFn, cache, model: 'anthropic:model-b' });

    expect(visionFn).toHaveBeenCalledTimes(2);
  });
});
