/**
 * T019 + T020 — answerFromVisualUnits: vision-read the top recalled visual
 * unit and return the answer WITH provenance, or an explicit not-found
 * (no fabrication) when recall is weak or the value isn't visible.
 *
 * Harness mirrors test/search-visual-units.test.ts + visual-ingest-handler.test.ts:
 * real PGLite engine, initSchema, resetPgliteState in beforeEach. embedFn +
 * visionFn are DI stubs (NO API). render + crop run REAL against the fixture PDF.
 *
 * The NOT-FOUND short-circuits (empty recall, below threshold) MUST NOT call
 * vision — enforced via a spy on visionFn.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { answerFromVisualUnits } from '../src/core/search/answer.ts';

const FIXTURE_PDF = join(import.meta.dir, 'fixtures/visual/one-page.pdf');

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

// ---- helpers ------------------------------------------------------------------

/** Build a 1024-d Float32Array with value 1 at position `pos`, rest 0. */
function unitVec(pos: number, dims = 1024): Float32Array {
  const v = new Float32Array(dims);
  v[pos] = 1;
  return v;
}

/** Seed a parent page with frontmatter; return its numeric id. */
async function seedPage(
  slug: string,
  frontmatter: Record<string, unknown>,
  sourceId = 'default',
): Promise<number> {
  await engine.putPage(slug, {
    type: 'note',
    title: slug,
    compiled_truth: '',
    timeline: '',
    frontmatter,
  }, { sourceId });
  const rows = await engine.executeRaw<{ id: number }>(
    `SELECT id FROM pages WHERE slug = $1 AND source_id = $2 LIMIT 1`,
    [slug, sourceId],
  );
  return rows[0].id;
}

/** Insert a unit row with an embedding, bbox boxes array and page_numbers. Returns id. */
async function seedUnit(
  documentId: number,
  vec: Float32Array,
  boxes: { x0: number; y0: number; x1: number; y1: number }[],
  pageNumbers: number[],
): Promise<number> {
  const vecLit = '[' + Array.from(vec).join(',') + ']';
  const pageNumsLiteral = '{' + pageNumbers.join(',') + '}';
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO units (document_id, type, page_numbers, embedding, bbox, provenance)
       VALUES ($1, 'table', $2::int[], $3::vector, $4, $5)
       RETURNING id`,
    [documentId, pageNumsLiteral, vecLit, boxes, { source: 'pdf' }],
  );
  return rows[0].id;
}

/** Insert a unit row with a NULL bbox (malformed recall). Returns id. */
async function seedUnitNullBbox(
  documentId: number,
  vec: Float32Array,
  pageNumbers: number[],
): Promise<number> {
  const vecLit = '[' + Array.from(vec).join(',') + ']';
  const pageNumsLiteral = '{' + pageNumbers.join(',') + '}';
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO units (document_id, type, page_numbers, embedding, bbox, provenance)
       VALUES ($1, 'table', $2::int[], $3::vector, NULL, $4)
       RETURNING id`,
    [documentId, pageNumsLiteral, vecLit, { source: 'pdf' }],
  );
  return rows[0].id;
}

const BOXES = [{ x0: 0.1, y0: 0.1, x1: 0.9, y1: 0.5 }];

// ---- tests --------------------------------------------------------------------

describe('answerFromVisualUnits (T019 + T020)', () => {
  test('FOUND: vision-reads the top unit and returns answer + provenance', async () => {
    const docId = await seedPage('test/answer-found', { source_path: FIXTURE_PDF });
    const unitId = await seedUnit(docId, unitVec(0), BOXES, [1]);

    let visionCalls = 0;
    const visionFn = async (_opts: unknown) => { visionCalls++; return '42'; };

    const res = await answerFromVisualUnits(engine, {
      query: 'what is the answer',
      embedFn: async () => unitVec(0),
      visionFn: visionFn as Parameters<typeof answerFromVisualUnits>[1]['visionFn'],
    });

    expect(res.found).toBe(true);
    expect(res.answer).toBe('42');
    expect(res.provenance?.slug).toBe('test/answer-found');
    expect(res.provenance?.unit_id).toBe(unitId);
    expect(res.provenance?.page_numbers).toEqual([1]);
    expect(res.provenance?.bbox).toEqual(BOXES);
    expect(typeof res.score).toBe('number');
    expect(res.score).toBeGreaterThan(0.25);
    expect(visionCalls).toBe(1);
  });

  test('NOT-FOUND empty recall: no units → reason empty_recall, vision NOT called', async () => {
    await seedPage('test/answer-empty', { source_path: FIXTURE_PDF });

    let visionCalls = 0;
    const visionFn = async (_opts: unknown) => { visionCalls++; return 'should not happen'; };

    const res = await answerFromVisualUnits(engine, {
      query: 'anything',
      embedFn: async () => unitVec(0),
      visionFn: visionFn as Parameters<typeof answerFromVisualUnits>[1]['visionFn'],
    });

    expect(res.found).toBe(false);
    expect(res.reason).toBe('empty_recall');
    expect(res.score).toBe(0);
    expect(visionCalls).toBe(0);
  });

  test('NOT-FOUND below threshold: weak recall → reason below_threshold, vision NOT called', async () => {
    const docId = await seedPage('test/answer-weak', { source_path: FIXTURE_PDF });
    await seedUnit(docId, unitVec(0), BOXES, [1]);

    let visionCalls = 0;
    const visionFn = async (_opts: unknown) => { visionCalls++; return 'should not happen'; };

    // Query orthogonal to the unit vector → score 0 < minScore (0.25)
    const res = await answerFromVisualUnits(engine, {
      query: 'unrelated',
      embedFn: async () => unitVec(5),
      visionFn: visionFn as Parameters<typeof answerFromVisualUnits>[1]['visionFn'],
    });

    expect(res.found).toBe(false);
    expect(res.reason).toBe('below_threshold');
    expect(res.score).toBeLessThan(0.25);
    expect(visionCalls).toBe(0);
  });

  test('NOT-FOUND vision sentinel: recall passes but value not visible → reason not_visible', async () => {
    const docId = await seedPage('test/answer-sentinel', { source_path: FIXTURE_PDF });
    await seedUnit(docId, unitVec(0), BOXES, [1]);

    let visionCalls = 0;
    const visionFn = async (_opts: unknown) => { visionCalls++; return 'NOT_FOUND'; };

    const res = await answerFromVisualUnits(engine, {
      query: 'what is the answer',
      embedFn: async () => unitVec(0),
      visionFn: visionFn as Parameters<typeof answerFromVisualUnits>[1]['visionFn'],
    });

    expect(res.found).toBe(false);
    expect(res.reason).toBe('not_visible');
    expect(visionCalls).toBe(1);
  });

  test('no_source_path fallback: no stored source_path and no pdfPath → not found; pdfPath param recovers', async () => {
    const docId = await seedPage('test/answer-nopath', {}); // NO source_path
    await seedUnit(docId, unitVec(0), BOXES, [1]);

    const visionFn = async (_opts: unknown) => '42';

    // 1) no pdf path anywhere → no_source_path
    const res1 = await answerFromVisualUnits(engine, {
      query: 'what is the answer',
      embedFn: async () => unitVec(0),
      visionFn: visionFn as Parameters<typeof answerFromVisualUnits>[1]['visionFn'],
    });
    expect(res1.found).toBe(false);
    expect(res1.reason).toBe('no_source_path');

    // 2) pass pdfPath param override → found
    const res2 = await answerFromVisualUnits(engine, {
      query: 'what is the answer',
      pdfPath: FIXTURE_PDF,
      embedFn: async () => unitVec(0),
      visionFn: visionFn as Parameters<typeof answerFromVisualUnits>[1]['visionFn'],
    });
    expect(res2.found).toBe(true);
    expect(res2.answer).toBe('42');
  });

  test('NOT-FOUND rerank below threshold: low relevanceScore → reason below_threshold, vision NOT called', async () => {
    const docId = await seedPage('test/answer-rerank-low', { source_path: FIXTURE_PDF });
    await seedUnit(docId, unitVec(0), BOXES, [1]);

    let visionCalls = 0;
    const visionFn = async (_opts: unknown) => { visionCalls++; return 'should not happen'; };

    // Strong cosine recall (embedFn matches the unit vector) but the reranker
    // says it's irrelevant (0.1 < default minRerankScore 0.40) → gate on
    // rerank_score, not score. No vision spend.
    const res = await answerFromVisualUnits(engine, {
      query: 'what is the answer',
      rerank: true,
      embedFn: async () => unitVec(0),
      rerankFn: async () => [{ index: 0, relevanceScore: 0.1 }],
      visionFn: visionFn as Parameters<typeof answerFromVisualUnits>[1]['visionFn'],
    });

    expect(res.found).toBe(false);
    expect(res.reason).toBe('below_threshold');
    expect(res.rerank_score).toBe(0.1);
    expect(visionCalls).toBe(0);
  });

  test('FOUND via rerank: high relevanceScore ≥ threshold → found, vision called once', async () => {
    const docId = await seedPage('test/answer-rerank-high', { source_path: FIXTURE_PDF });
    await seedUnit(docId, unitVec(0), BOXES, [1]);

    let visionCalls = 0;
    const visionFn = async (_opts: unknown) => { visionCalls++; return '42'; };

    const res = await answerFromVisualUnits(engine, {
      query: 'what is the answer',
      rerank: true,
      embedFn: async () => unitVec(0),
      rerankFn: async () => [{ index: 0, relevanceScore: 0.9 }],
      visionFn: visionFn as Parameters<typeof answerFromVisualUnits>[1]['visionFn'],
    });

    expect(res.found).toBe(true);
    expect(res.answer).toBe('42');
    expect(res.rerank_score).toBe(0.9);
    expect(visionCalls).toBe(1);
  });

  test('NOT-FOUND null bbox: passing recall but bbox NULL → reason no_bbox, vision NOT called', async () => {
    const docId = await seedPage('test/answer-nobbox', { source_path: FIXTURE_PDF });
    await seedUnitNullBbox(docId, unitVec(0), [1]);

    let visionCalls = 0;
    const visionFn = async (_opts: unknown) => { visionCalls++; return 'should not happen'; };

    // Strong cosine recall passes the score gate, but the malformed (NULL) bbox
    // must short-circuit to not-found BEFORE render/crop — no crash, no vision.
    const res = await answerFromVisualUnits(engine, {
      query: 'what is the answer',
      embedFn: async () => unitVec(0),
      visionFn: visionFn as Parameters<typeof answerFromVisualUnits>[1]['visionFn'],
    });

    expect(res.found).toBe(false);
    expect(res.reason).toBe('no_bbox');
    expect(visionCalls).toBe(0);
  });
});
