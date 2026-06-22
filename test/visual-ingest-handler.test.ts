/**
 * T013 — visual-ingest minion handler integration test.
 *
 * Uses a real PGLite engine + the fixture test/fixtures/visual/one-page.pdf.
 * Stubs out detectLayoutFn and embedFn (network/cost) while letting
 * renderPdfPageToPng + cropUnitFromPdf run for real (pdftoppm is fast).
 *
 * Verifies:
 *   1. A pages row is written at the correct slug with content_hash.
 *   2. At least one units row is persisted with the right document_id, type,
 *      non-null embedding, and proper JSONB bbox/provenance round-trip.
 *   3. Running the handler again with the same file → {status:'skipped'} and
 *      the unit count stays unchanged (idempotency).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { makeVisualIngestHandler } from '../src/core/minions/handlers/visual-ingest.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import type { MinionJobContext } from '../src/core/minions/types.ts';
import type { LayoutRegion } from '../src/core/ai/layout/detect-layout.ts';

// ---- fixtures -----------------------------------------------------------------

const FIXTURE_PDF = join(import.meta.dir, 'fixtures/visual/one-page.pdf');

const STUB_REGIONS: LayoutRegion[] = [
  {
    type: 'table',
    bbox: { x0: 0.1, y0: 0.1, x1: 0.9, y1: 0.5 },
    reading_order: 0,
    confidence: 0.9,
  },
];

const STUB_VEC = new Float32Array(1024).fill(0.01);

// ---- stubs --------------------------------------------------------------------

async function stubDetectLayout(
  _pageImage: { data: string; mime: string },
  _opts?: unknown,
): Promise<LayoutRegion[]> {
  return STUB_REGIONS;
}

async function stubEmbed(
  _inputs: unknown[],
  _opts?: unknown,
): Promise<Float32Array[]> {
  return [STUB_VEC];
}

// ---- helpers ------------------------------------------------------------------

function makeMinionJobContext(filePath: string, sourceId = 'default'): MinionJobContext {
  const ac = new AbortController();
  return {
    id: 1,
    name: 'ingest_visual_doc',
    data: { filePath, sourceId } as Record<string, unknown>,
    attempts_made: 0,
    signal: ac.signal,
    shutdownSignal: ac.signal,
    updateProgress: async (_p: unknown) => {},
    updateTokens: async () => {},
    log: async () => {},
    isActive: async () => true,
    readInbox: async () => [],
  };
}

// ---- engine -------------------------------------------------------------------

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
}, 60_000);

beforeEach(async () => {
  await resetPgliteState(engine);
}, 30_000);

// ---- tests --------------------------------------------------------------------

describe('makeVisualIngestHandler', () => {
  test('processes a single-page PDF: page row + unit row persisted', async () => {
    const handler = makeVisualIngestHandler(engine, {
      detectLayoutFn: stubDetectLayout as typeof import('../src/core/ai/layout/detect-layout.ts').detectLayout,
      embedFn: stubEmbed as typeof import('../src/core/ai/gateway.ts').embedMultimodal,
    });

    const job = makeMinionJobContext(FIXTURE_PDF);
    const result = await handler(job) as {
      status: string;
      slug: string;
      document_id: number;
      pages: number;
      units: number;
    };

    expect(result.status).toBe('ok');
    expect(result.pages).toBe(1);
    expect(result.units).toBeGreaterThanOrEqual(1);
    expect(typeof result.slug).toBe('string');
    expect(typeof result.document_id).toBe('number');

    // Verify pages row exists with content_hash
    const pages = await engine.executeRaw<Record<string, unknown>>(
      `SELECT id, slug, frontmatter FROM pages WHERE id = $1`,
      [result.document_id],
    );
    expect(pages.length).toBe(1);
    const fm = typeof pages[0].frontmatter === 'string'
      ? JSON.parse(pages[0].frontmatter as string)
      : pages[0].frontmatter;
    expect(typeof fm.content_hash).toBe('string');
    expect(fm.content_hash.length).toBe(64); // sha256 hex
    expect(fm.source_kind).toBe('visual_ingest');

    // Verify at least one units row
    const units = await engine.executeRaw<Record<string, unknown>>(
      `SELECT id, document_id, type, embedding, bbox, provenance FROM units WHERE document_id = $1`,
      [result.document_id],
    );
    expect(units.length).toBeGreaterThanOrEqual(1);

    const unit = units[0];
    expect(unit.document_id).toBe(result.document_id);
    expect(unit.type).toBe('table');
    // embedding: non-null
    expect(unit.embedding).not.toBeNull();

    // bbox JSONB round-trip: should be an array of bbox objects
    const bbox = typeof unit.bbox === 'string' ? JSON.parse(unit.bbox as string) : unit.bbox;
    expect(Array.isArray(bbox)).toBe(true);
    expect(bbox.length).toBeGreaterThanOrEqual(1);
    const firstBbox = bbox[0];
    expect(typeof firstBbox.x0).toBe('number');
    expect(typeof firstBbox.y1).toBe('number');

    // provenance JSONB round-trip
    const prov = typeof unit.provenance === 'string'
      ? JSON.parse(unit.provenance as string)
      : unit.provenance;
    expect(prov).toBeTruthy();
    expect(typeof prov.source).toBe('string');
  }, 60_000);

  test('idempotent: second run with same file returns status:skipped, unit count unchanged', async () => {
    const handler = makeVisualIngestHandler(engine, {
      detectLayoutFn: stubDetectLayout as typeof import('../src/core/ai/layout/detect-layout.ts').detectLayout,
      embedFn: stubEmbed as typeof import('../src/core/ai/gateway.ts').embedMultimodal,
    });

    const job = makeMinionJobContext(FIXTURE_PDF);

    // First run
    const r1 = await handler(job) as { status: string; document_id: number; units: number };
    expect(r1.status).toBe('ok');

    const countAfterFirst = await engine.executeRaw<{ c: string }>(
      `SELECT count(*)::text AS c FROM units WHERE document_id = $1`,
      [r1.document_id],
    );
    const firstCount = parseInt(countAfterFirst[0].c, 10);
    expect(firstCount).toBeGreaterThanOrEqual(1);

    // Second run — same file
    const job2 = makeMinionJobContext(FIXTURE_PDF);
    const r2 = await handler(job2) as { status: string; slug: string; reason: string };
    expect(r2.status).toBe('skipped');
    expect(typeof r2.slug).toBe('string');

    // Unit count must be unchanged
    const countAfterSecond = await engine.executeRaw<{ c: string }>(
      `SELECT count(*)::text AS c FROM units WHERE document_id = $1`,
      [r1.document_id],
    );
    expect(parseInt(countAfterSecond[0].c, 10)).toBe(firstCount);
  }, 60_000);
});
