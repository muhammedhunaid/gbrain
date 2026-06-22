/**
 * T015 — env-gated RAG-paper layout validation gate.
 *
 * GO/NO-GO integration test: renders a dense-table page from a real PDF,
 * runs detectLayout with the real visionChat, and asserts the result
 * matches the manual table-separation result from the design (≥2 separated
 * table regions on the RAG paper page 6).
 *
 * SKIPPED BY DEFAULT — set GBRAIN_VISUAL_E2E=1 to run.
 *
 * Required env vars:
 *   GBRAIN_VISUAL_E2E=1             — enable the suite
 *   GBRAIN_VISUAL_E2E_PDF=<path>    — absolute path to the RAG paper PDF
 *   ANTHROPIC_API_KEY=<key>         — vision model gateway credential
 *
 * Optional env vars:
 *   GBRAIN_VISUAL_E2E_PAGE=<n>      — page number (default: 6)
 *   GBRAIN_VISUAL_E2E_LAYOUT_MODEL  — model override (default: gateway default)
 *
 * Run command:
 *   GBRAIN_VISUAL_E2E=1 GBRAIN_VISUAL_E2E_PDF=/path/to/rag-2005.11401.pdf \
 *     ANTHROPIC_API_KEY=... \
 *     bun test test/visual-doc-validation.e2e.test.ts --timeout=120000
 *
 * Cost: ~1 vision model call (typically < $0.01 at claude-3-5-sonnet pricing).
 */

import { describe, test, expect, beforeAll } from 'bun:test';
import { accessSync } from 'node:fs';
import { renderPdfPageToPng } from '../src/core/ingestion/visual/render.ts';
import { detectLayout } from '../src/core/ai/layout/detect-layout.ts';
import type { LayoutRegion } from '../src/core/ai/layout/detect-layout.ts';

// ---- gate -------------------------------------------------------------------

const E2E_ENABLED = process.env.GBRAIN_VISUAL_E2E === '1';

// ---- helpers ----------------------------------------------------------------

/**
 * Assert two table regions are vertically separated — one ends before the
 * other begins (with a small tolerance for nearly-adjacent tables).
 *
 * Two regions are "separated" when they do NOT overlap vertically:
 *   top.y1 <= bottom.y0  (within tolerance)
 */
function areSeparated(a: LayoutRegion, b: LayoutRegion, tolerancePx = 0.005): boolean {
  const top = a.bbox.y0 <= b.bbox.y0 ? a : b;
  const bottom = top === a ? b : a;
  return top.bbox.y1 <= bottom.bbox.y0 + tolerancePx;
}

// ---- suite ------------------------------------------------------------------

describe.skipIf(!E2E_ENABLED)('T015 layout validation gate (RAG paper, dense-table page)', () => {
  let pdfPath: string;
  let pageNum: number;
  let modelOverride: string | undefined;

  beforeAll(() => {
    // Validate required env var — fail loudly before any test runs
    const envPdf = process.env.GBRAIN_VISUAL_E2E_PDF;
    if (!envPdf) {
      throw new Error(
        'GBRAIN_VISUAL_E2E_PDF is not set. ' +
        'Point it at the RAG paper PDF, e.g. ' +
        'GBRAIN_VISUAL_E2E_PDF=/path/to/rag-2005.11401.pdf',
      );
    }
    try {
      accessSync(envPdf);
    } catch {
      throw new Error(
        `GBRAIN_VISUAL_E2E_PDF path is not readable: ${envPdf}\n` +
        'Download the PDF and set the env var to its absolute path.',
      );
    }
    pdfPath = envPdf;

    const envPage = process.env.GBRAIN_VISUAL_E2E_PAGE;
    pageNum = envPage ? parseInt(envPage, 10) : 6;
    if (!Number.isFinite(pageNum) || pageNum < 1) {
      throw new Error(`GBRAIN_VISUAL_E2E_PAGE must be a positive integer, got: ${envPage}`);
    }

    modelOverride = process.env.GBRAIN_VISUAL_E2E_LAYOUT_MODEL || undefined;
  });

  test('detectLayout on the dense-table page returns ≥2 spatially-separated table regions with normalized bboxes', async () => {
    // Step 1: render the PDF page to PNG
    const rendered = await renderPdfPageToPng({ pdfPath, page: pageNum });
    const b64 = rendered.png.toString('base64');

    // Step 2: run real detectLayout (live vision call — no stub)
    const regions = await detectLayout(
      { data: b64, mime: 'image/png' },
      { model: modelOverride },
    );

    // Step 4: log a concise summary for human review
    const summary = regions.map(r =>
      `  [${r.type}] bbox=(${r.bbox.x0.toFixed(3)},${r.bbox.y0.toFixed(3)},${r.bbox.x1.toFixed(3)},${r.bbox.y1.toFixed(3)}) conf=${r.confidence.toFixed(2)}`,
    ).join('\n');
    console.log(
      `\nT015 layout result — page ${pageNum} of ${pdfPath}\n` +
      `  total regions: ${regions.length}\n` +
      `  types: ${[...new Set(regions.map(r => r.type))].join(', ')}\n` +
      `${summary}`,
    );

    // Step 3a: every bbox must be normalized in [0,1]
    for (const r of regions) {
      const { x0, y0, x1, y1 } = r.bbox;
      expect(x0).toBeGreaterThanOrEqual(0);
      expect(y0).toBeGreaterThanOrEqual(0);
      expect(x1).toBeLessThanOrEqual(1);
      expect(y1).toBeLessThanOrEqual(1);
      expect(x0).toBeLessThan(x1);
      expect(y0).toBeLessThan(y1);
    }

    // Step 3b: at least 2 table regions detected
    const tableRegions = regions.filter(r => r.type === 'table');
    expect(tableRegions.length).toBeGreaterThanOrEqual(2);

    // Step 3c: table regions are spatially separated (sibling-table separation)
    // Check every pair of table regions — at least one pair must be separated.
    // On a page with only 2 tables this covers the key design invariant.
    let foundSeparatedPair = false;
    for (let i = 0; i < tableRegions.length; i++) {
      for (let j = i + 1; j < tableRegions.length; j++) {
        if (areSeparated(tableRegions[i]!, tableRegions[j]!)) {
          foundSeparatedPair = true;
          break;
        }
      }
      if (foundSeparatedPair) break;
    }
    expect(foundSeparatedPair).toBe(true);
  }, 120_000);
});
