/**
 * Tests for the deterministic PDF page-to-PNG render helper.
 *
 * Runs pdftoppm (poppler) under the hood; requires poppler-utils installed
 * at /usr/bin/pdftoppm.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { renderPdfPageToPng } from '../src/core/ingestion/visual/render.ts';

const FIXTURE = join(import.meta.dir, 'fixtures/visual/one-page.pdf');

// PNG magic bytes (IHDR signature bytes 0-7)
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('renderPdfPageToPng', () => {
  test('fixture file exists', () => {
    expect(existsSync(FIXTURE)).toBe(true);
  });

  test('returns a Buffer with PNG signature', async () => {
    const result = await renderPdfPageToPng({ pdfPath: FIXTURE, page: 1 });
    expect(result.png).toBeInstanceOf(Buffer);
    expect(result.png.subarray(0, 8)).toEqual(PNG_SIGNATURE);
  });

  test('returns positive pixel dimensions', async () => {
    const result = await renderPdfPageToPng({ pdfPath: FIXTURE, page: 1 });
    expect(result.width).toBeGreaterThan(0);
    expect(result.height).toBeGreaterThan(0);
  });

  test('dimensions are consistent with pinned 200 DPI (letter page = 1700x2200)', async () => {
    const result = await renderPdfPageToPng({ pdfPath: FIXTURE, page: 1 });
    // letter = 612x792 pts; at 200 DPI: 612/72*200=1700, 792/72*200=2200
    expect(result.width).toBe(1700);
    expect(result.height).toBe(2200);
  });

  test('determinism — same page at same DPI yields identical dimensions', async () => {
    const r1 = await renderPdfPageToPng({ pdfPath: FIXTURE, page: 1 });
    const r2 = await renderPdfPageToPng({ pdfPath: FIXTURE, page: 1 });
    expect(r1.width).toBe(r2.width);
    expect(r1.height).toBe(r2.height);
    // Note: pdftoppm may embed a tIME chunk with a current timestamp in some builds,
    // which would break byte-level equality. We assert dims equality (always stable)
    // as the primary determinism contract. If bytes happen to be equal, great.
    // To verify: compare first 24 bytes (PNG sig + IHDR length + "IHDR" + dims)
    // which are stable regardless of tIME.
    const stableRegion1 = r1.png.subarray(0, 24);
    const stableRegion2 = r2.png.subarray(0, 24);
    expect(stableRegion1).toEqual(stableRegion2);
  });

  test('custom DPI is respected', async () => {
    const result = await renderPdfPageToPng({ pdfPath: FIXTURE, page: 1, dpi: 72 });
    // letter at 72 DPI = 612x792
    expect(result.width).toBe(612);
    expect(result.height).toBe(792);
  });

  test('throws a clear Error for a nonexistent file', async () => {
    await expect(
      renderPdfPageToPng({ pdfPath: '/does/not/exist/fake.pdf', page: 1 }),
    ).rejects.toThrow();
  });

  test('throws a clear Error for an out-of-range page', async () => {
    // Page 99 does not exist in a 1-page PDF
    await expect(
      renderPdfPageToPng({ pdfPath: FIXTURE, page: 99 }),
    ).rejects.toThrow();
  });
});
