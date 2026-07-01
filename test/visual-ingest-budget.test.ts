/**
 * T022 (US4) — visual-ingest budget enforcement + cost reporting + model pinning.
 *
 * Extends the T013 handler tests with the reproducible-and-cost-bounded surface:
 *   1. cost reported: normal ingest → result carries spentUsd (a number) and
 *      layout_model/embed_model; a persisted unit's provenance carries
 *      layout_model, embed_model, prompt_version (FR-013 pinning).
 *   2. budget exhausted: a tiny per-job cap (injected via the deps.budgetCapUsd
 *      DI seam) makes the manual embed record() blow the cap → the handler
 *      surfaces status:'budget_exhausted' with spentUsd/budgetCapUsd, and the
 *      already-persisted unit is NOT deleted (partial progress retained).
 *
 * Real PGLite engine + fixture PDF; detectLayoutFn/embedFn are stubbed (no API,
 * no cost). The cap is threaded via the DI seam so no config file is needed and
 * BudgetExhausted is triggered by REAL recorded embed cost (zembed-1 pricing),
 * not a mock throw.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { makeVisualIngestHandler } from '../src/core/minions/handlers/visual-ingest.ts';
import { PROMPT_VERSION } from '../src/core/ai/layout/detect-layout.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import type { MinionJobContext } from '../src/core/minions/types.ts';
import type { LayoutRegion } from '../src/core/ai/layout/detect-layout.ts';

const FIXTURE_PDF = join(import.meta.dir, 'fixtures/visual/one-page.pdf');

const STUB_REGIONS: LayoutRegion[] = [
  { type: 'table', bbox: { x0: 0.1, y0: 0.1, x1: 0.9, y1: 0.5 }, reading_order: 0, confidence: 0.9 },
];
const STUB_VEC = new Float32Array(1024).fill(0.01);

async function stubDetectLayout(
  _pageImage: { data: string; mime: string },
  _opts?: unknown,
): Promise<LayoutRegion[]> {
  return STUB_REGIONS;
}
async function stubEmbed(_inputs: unknown[], _opts?: unknown): Promise<Float32Array[]> {
  return [STUB_VEC];
}

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

describe('visual-ingest budget + cost reporting + model pinning', () => {
  test('cost reported: result carries spentUsd + models; unit provenance is pinned', async () => {
    const handler = makeVisualIngestHandler(engine, {
      detectLayoutFn: stubDetectLayout as typeof import('../src/core/ai/layout/detect-layout.ts').detectLayout,
      embedFn: stubEmbed as typeof import('../src/core/ai/gateway.ts').embedMultimodal,
    });

    const result = await handler(makeMinionJobContext(FIXTURE_PDF));

    expect(result.status).toBe('ok');
    expect(typeof result.spentUsd).toBe('number');
    expect(result.spentUsd as number).toBeGreaterThanOrEqual(0);
    expect(typeof result.layout_model).toBe('string');
    expect((result.layout_model as string).length).toBeGreaterThan(0);
    expect(typeof result.embed_model).toBe('string');
    expect((result.embed_model as string).length).toBeGreaterThan(0);

    // Provenance pinning round-trips through JSONB.
    const units = await engine.executeRaw<Record<string, unknown>>(
      `SELECT provenance FROM units WHERE document_id = $1`,
      [result.document_id as number],
    );
    expect(units.length).toBeGreaterThanOrEqual(1);
    const prov = typeof units[0].provenance === 'string'
      ? JSON.parse(units[0].provenance as string)
      : units[0].provenance;
    expect(prov.layout_model).toBe(result.layout_model);
    expect(prov.embed_model).toBe(result.embed_model);
    expect(prov.prompt_version).toBe(PROMPT_VERSION);
  }, 60_000);

  test('budget exhausted: tiny cap surfaces status + spentUsd, persisted units retained', async () => {
    // zembed-1 is priced ($0.05/1M tok); a per-image embed record therefore has a
    // small non-zero cost. A cap far below that cost makes the FIRST embed record
    // blow the cap → BudgetExhausted, thrown after the unit is already persisted.
    const handler = makeVisualIngestHandler(engine, {
      detectLayoutFn: stubDetectLayout as typeof import('../src/core/ai/layout/detect-layout.ts').detectLayout,
      embedFn: stubEmbed as typeof import('../src/core/ai/gateway.ts').embedMultimodal,
      budgetCapUsd: 1e-12,
    });

    const result = await handler(makeMinionJobContext(FIXTURE_PDF));

    expect(result.status).toBe('budget_exhausted');
    expect(typeof result.spentUsd).toBe('number');
    expect(result.spentUsd as number).toBeGreaterThan(0);
    expect(result.budgetCapUsd).toBe(1e-12);
    expect(result.units).toBeGreaterThanOrEqual(1);

    // Partial progress retained: the unit persisted before the throw is still there.
    const rows = await engine.executeRaw<{ c: string }>(
      `SELECT count(*)::text AS c FROM units WHERE document_id = $1`,
      [result.document_id as number],
    );
    expect(parseInt(rows[0].c, 10)).toBeGreaterThanOrEqual(1);
  }, 60_000);

  test('uncapped: no cap → normal ok status even with many records', async () => {
    const handler = makeVisualIngestHandler(engine, {
      detectLayoutFn: stubDetectLayout as typeof import('../src/core/ai/layout/detect-layout.ts').detectLayout,
      embedFn: stubEmbed as typeof import('../src/core/ai/gateway.ts').embedMultimodal,
      budgetCapUsd: undefined,
    });

    const result = await handler(makeMinionJobContext(FIXTURE_PDF));
    expect(result.status).toBe('ok');
    expect(result.budgetCapUsd).toBeUndefined();
  }, 60_000);
});
