/**
 * Tests for the semantic-unit cropper via pdftoppm region render.
 *
 * Requires poppler-utils installed at /usr/bin/pdftoppm.
 * Fixture: test/fixtures/visual/one-page.pdf — a 612x792pt letter page.
 * At 200 DPI the full page is 1700x2200 px.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { cropUnitFromPdf } from '../src/core/ingestion/visual/crop.ts';

const FIXTURE = join(import.meta.dir, 'fixtures/visual/one-page.pdf');

// PNG magic bytes
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('cropUnitFromPdf', () => {
  test('fixture file exists', () => {
    expect(existsSync(FIXTURE)).toBe(true);
  });

  test('top-left quadrant crop: PNG signature, correct dims, correct provenance', async () => {
    const result = await cropUnitFromPdf({
      pdfPath: FIXTURE,
      page: 1,
      dpi: 200,
      pageWidth: 1700,
      pageHeight: 2200,
      bbox: { x0: 0, y0: 0, x1: 0.5, y1: 0.5 },
    });

    // PNG signature
    expect(result.png).toBeInstanceOf(Buffer);
    expect(result.png.subarray(0, 8)).toEqual(PNG_SIGNATURE);
    expect(result.png.length).toBeGreaterThan(0);

    // Dimensions within 2px of expected
    expect(Math.abs(result.width - 850)).toBeLessThanOrEqual(2);
    expect(Math.abs(result.height - 1100)).toBeLessThanOrEqual(2);

    // Provenance
    expect(result.provenance.page).toBe(1);
    expect(result.provenance.dpi).toBe(200);
    expect(result.provenance.bbox).toEqual({ x0: 0, y0: 0, x1: 0.5, y1: 0.5 });
    expect(result.provenance.pixel_rect).toEqual({ x: 0, y: 0, w: 850, h: 1100 });
  });

  test('determinism — two crops of same region yield identical dims', async () => {
    const opts = {
      pdfPath: FIXTURE,
      page: 1,
      dpi: 200,
      pageWidth: 1700,
      pageHeight: 2200,
      bbox: { x0: 0.1, y0: 0.1, x1: 0.6, y1: 0.6 },
    };
    const r1 = await cropUnitFromPdf(opts);
    const r2 = await cropUnitFromPdf(opts);
    expect(r1.width).toBe(r2.width);
    expect(r1.height).toBe(r2.height);
    // IHDR region (first 24 bytes) is always stable
    expect(r1.png.subarray(0, 24)).toEqual(r2.png.subarray(0, 24));
  });

  test('invalid bbox (x1 <= x0) throws a clear Error', async () => {
    await expect(
      cropUnitFromPdf({
        pdfPath: FIXTURE,
        page: 1,
        dpi: 200,
        pageWidth: 1700,
        pageHeight: 2200,
        bbox: { x0: 0.5, y0: 0, x1: 0.3, y1: 0.5 },
      }),
    ).rejects.toThrow(/x1.*x0|x0.*x1|invalid bbox/i);
  });

  test('invalid bbox (y1 <= y0) throws a clear Error', async () => {
    await expect(
      cropUnitFromPdf({
        pdfPath: FIXTURE,
        page: 1,
        dpi: 200,
        pageWidth: 1700,
        pageHeight: 2200,
        bbox: { x0: 0, y0: 0.7, x1: 0.5, y1: 0.5 },
      }),
    ).rejects.toThrow(/y1.*y0|y0.*y1|invalid bbox/i);
  });

  test('invalid bbox (out of [0,1] range) throws a clear Error', async () => {
    await expect(
      cropUnitFromPdf({
        pdfPath: FIXTURE,
        page: 1,
        dpi: 200,
        pageWidth: 1700,
        pageHeight: 2200,
        bbox: { x0: -0.1, y0: 0, x1: 0.5, y1: 0.5 },
      }),
    ).rejects.toThrow();
  });

  test('bottom-right quadrant: expected pixel_rect', async () => {
    const result = await cropUnitFromPdf({
      pdfPath: FIXTURE,
      page: 1,
      dpi: 200,
      pageWidth: 1700,
      pageHeight: 2200,
      bbox: { x0: 0.5, y0: 0.5, x1: 1.0, y1: 1.0 },
    });

    // x = round(0.5*1700)=850, y = round(0.5*2200)=1100, w = round(0.5*1700)=850, h = round(0.5*2200)=1100
    // After clamping: x+w=1700<=1700 OK, y+h=2200<=2200 OK
    expect(result.provenance.pixel_rect).toEqual({ x: 850, y: 1100, w: 850, h: 1100 });
    expect(Math.abs(result.width - 850)).toBeLessThanOrEqual(2);
    expect(Math.abs(result.height - 1100)).toBeLessThanOrEqual(2);
  });

  test('throws for nonexistent PDF file', async () => {
    await expect(
      cropUnitFromPdf({
        pdfPath: '/does/not/exist/fake.pdf',
        page: 1,
        dpi: 200,
        pageWidth: 1700,
        pageHeight: 2200,
        bbox: { x0: 0, y0: 0, x1: 0.5, y1: 0.5 },
      }),
    ).rejects.toThrow();
  });

  test('throws for out-of-range page', async () => {
    await expect(
      cropUnitFromPdf({
        pdfPath: FIXTURE,
        page: 99,
        dpi: 200,
        pageWidth: 1700,
        pageHeight: 2200,
        bbox: { x0: 0, y0: 0, x1: 0.5, y1: 0.5 },
      }),
    ).rejects.toThrow();
  });
});
