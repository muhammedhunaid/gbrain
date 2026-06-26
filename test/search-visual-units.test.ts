/**
 * T016: multimodal recall over the `units` table.
 * Mirrors the harness in test/migrations-v120.test.ts — PGLite engine,
 * initSchema runs v120/v121; resetPgliteState in beforeEach.
 *
 * All tests inject an embedFn stub (fixed query vector) — NO real API calls.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { searchVisualUnits } from '../src/core/search/visual-units.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

/** Seed a parent page and return its numeric id. */
async function seedPage(slug: string, sourceId = 'default'): Promise<number> {
  if (sourceId !== 'default') {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ($1, $2, '{}'::jsonb) ON CONFLICT (id) DO NOTHING`,
      [sourceId, sourceId],
    );
  }
  await engine.putPage(slug, {
    type: 'note',
    title: slug,
    compiled_truth: '',
    timeline: '',
    frontmatter: {},
  }, { sourceId });
  const rows = await engine.executeRaw<{ id: number }>(
    `SELECT id FROM pages WHERE slug = $1 AND source_id = $2 LIMIT 1`,
    [slug, sourceId],
  );
  return rows[0].id;
}

/** Build a 1024-d Float32Array with value 1 at position `pos`, rest 0. */
function unitVec(pos: number, dims = 1024): Float32Array {
  const v = new Float32Array(dims);
  v[pos] = 1;
  return v;
}

/** Insert a unit row with an embedding. Returns the unit id. */
async function seedUnit(
  documentId: number,
  type: 'table' | 'figure' | 'chart' | 'text' | 'caption' | 'section',
  vec: Float32Array,
  extra?: { bbox?: unknown; provenance?: unknown },
): Promise<number> {
  const vecLit = '[' + Array.from(vec).join(',') + ']';
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO units (document_id, type, embedding, bbox, provenance)
       VALUES ($1, $2, $3::vector, $4, $5)
       RETURNING id`,
    [documentId, type, vecLit, extra?.bbox ?? null, extra?.provenance ?? null],
  );
  return rows[0].id;
}

// ---------------------------------------------------------------------------
// T017 rerank stage tests (added in PR4 T017)
// ---------------------------------------------------------------------------

describe('T017 searchVisualUnits rerank stage', () => {
  test('rerankFn reorders results and sets rerank_score', async () => {
    const pageId = await seedPage('test/rerank-order-page');
    // Seed 3 units with DISTINCT similarity to query so recall order is deterministic.
    // Query = [0.9, 0.1, 0.0, ...0]. Similarities (approx):
    //   figure = unitVec(0) → high similarity  (idx 0 in recall)
    //   table  = mixed vec  → medium similarity (idx 1 in recall)
    //   chart  = unitVec(5) → zero similarity   (idx 2 in recall)
    const highVec = unitVec(0);               // similarity ~0.9 with query
    const midVec = new Float32Array(1024);
    midVec[0] = 0.5; midVec[1] = 0.5;        // similarity ~0.45 with query
    const lowVec = unitVec(5);                // similarity ~0.0 with query

    await seedUnit(pageId, 'figure', highVec); // recall idx 0
    await seedUnit(pageId, 'table',  midVec);  // recall idx 1
    await seedUnit(pageId, 'chart',  lowVec);  // recall idx 2

    // Query vector aligned with pos 0 (figure closest, chart furthest)
    const queryVec = new Float32Array(1024);
    queryVec[0] = 0.9; queryVec[1] = 0.1;

    // rerankFn reverses the order: chart(idx2), figure(idx0), table(idx1)
    const rerankFn = async (_input: { query: string; documents: string[]; topN?: number }) => [
      { index: 2, relevanceScore: 0.9 },
      { index: 0, relevanceScore: 0.7 },
      { index: 1, relevanceScore: 0.5 },
    ];

    const results = await searchVisualUnits(engine, {
      query: 'test rerank',
      embedFn: async () => queryVec,
      limit: 3,
      rerankFn,
    });

    expect(results.length).toBe(3);
    // Reranked order: chart, figure, table
    expect(results[0].type).toBe('chart');
    expect(results[1].type).toBe('figure');
    expect(results[2].type).toBe('table');
    // rerank_score set on each
    expect(results[0].rerank_score).toBeCloseTo(0.9);
    expect(results[1].rerank_score).toBeCloseTo(0.7);
    expect(results[2].rerank_score).toBeCloseTo(0.5);
  });

  test('over-fetch + truncate: final length == limit after rerank', async () => {
    const pageId = await seedPage('test/rerank-truncate-page');
    // Seed 10 units so candidateK (30) clips to however many exist; limit=3
    for (let i = 0; i < 10; i++) {
      await seedUnit(pageId, 'text', unitVec(i));
    }

    // rerankFn returns 5 entries; after truncation to rerankTopN=limit=3 → 3 results
    const rerankFn = async (input: { query: string; documents: string[]; topN?: number }) => {
      // Return topN entries (the function is asked for topN, but we simulate returning all topN)
      const n = input.topN ?? input.documents.length;
      return Array.from({ length: Math.min(n, input.documents.length) }, (_, i) => ({
        index: i,
        relevanceScore: 1 - i * 0.1,
      }));
    };

    const results = await searchVisualUnits(engine, {
      query: 'test truncate',
      embedFn: async () => unitVec(0),
      limit: 3,
      rerankFn,
    });

    expect(results.length).toBe(3);
  });

  test('fail-open: rerankFn that throws returns recall order, no throw', async () => {
    const pageId = await seedPage('test/rerank-failopen-page');
    await seedUnit(pageId, 'figure', unitVec(0));
    await seedUnit(pageId, 'table',  unitVec(1));
    await seedUnit(pageId, 'chart',  unitVec(2));

    const rerankFn = async (_input: { query: string; documents: string[]; topN?: number }): Promise<{ index: number; relevanceScore: number }[]> => {
      throw new Error('reranker unavailable');
    };

    // Should not throw; returns top `limit` in recall order
    const results = await searchVisualUnits(engine, {
      query: 'test failopen',
      embedFn: async () => unitVec(0),
      limit: 2,
      rerankFn,
    });

    // No throw, returns recall-ordered top 2
    expect(results.length).toBe(2);
    // recall order: figure(pos0) first since query=unitVec(0)
    expect(results[0].type).toBe('figure');
    // rerank_score must NOT be set on fail-open
    expect(results[0].rerank_score).toBeUndefined();
  });

  test('rerank:false skips reranker, preserves recall order, no rerank_score', async () => {
    const pageId = await seedPage('test/rerank-off-page');
    await seedUnit(pageId, 'figure', unitVec(0));
    await seedUnit(pageId, 'table',  unitVec(1));

    let rerankCalled = false;
    const rerankFn = async (_input: { query: string; documents: string[]; topN?: number }) => {
      rerankCalled = true;
      return [{ index: 0, relevanceScore: 0.99 }];
    };

    const results = await searchVisualUnits(engine, {
      query: 'test no rerank',
      embedFn: async () => unitVec(0),
      limit: 2,
      rerank: false,
      rerankFn,
    });

    expect(rerankCalled).toBe(false);
    expect(results.length).toBe(2);
    expect(results[0].type).toBe('figure'); // recall order
    expect(results[0].rerank_score).toBeUndefined();
  });
});

describe('T016 searchVisualUnits', () => {
  test('ranking: unit closer to query vector ranks first with higher score', async () => {
    const pageId = await seedPage('test/rank-page');

    // Unit A: vec[0]=1, Unit B: vec[1]=1
    const vecA = unitVec(0);
    const vecB = unitVec(1);
    await seedUnit(pageId, 'figure', vecA);
    await seedUnit(pageId, 'table', vecB);

    // Query near A (vec[0]=1 exactly)
    const queryVec = unitVec(0);
    const results = await searchVisualUnits(engine, {
      query: 'test query',
      embedFn: async (_text) => queryVec,
      limit: 10,
    });

    expect(results.length).toBe(2);
    // A should be ranked first
    expect(results[0].type).toBe('figure');
    expect(results[1].type).toBe('table');
    // Score of A should be higher than B
    expect(results[0].score).toBeGreaterThan(results[1].score);
    // Score of A should be ~1 (cosine similarity with itself)
    expect(results[0].score).toBeCloseTo(1.0, 3);
  });

  test('provenance: result carries page_slug, type, score; bbox/provenance round-trip', async () => {
    const pageId = await seedPage('test/provenance-page');

    const bbox = { x: 10, y: 20, w: 100, h: 50 };
    const provenance = { source: 'pdf', page: 3 };
    const vec = unitVec(5);
    await seedUnit(pageId, 'chart', vec, { bbox, provenance });

    const results = await searchVisualUnits(engine, {
      query: 'test',
      embedFn: async () => unitVec(5),
      limit: 10,
    });

    expect(results.length).toBe(1);
    const r = results[0];
    expect(r.page_slug).toBe('test/provenance-page');
    expect(r.source_id).toBe('default');
    expect(r.type).toBe('chart');
    expect(typeof r.score).toBe('number');
    // bbox and provenance arrive as parsed JS objects (no JSON.parse needed)
    expect(r.bbox).toEqual(bbox);
    expect(r.provenance).toEqual(provenance);
  });

  test('source isolation: unit under foreign source MUST NOT appear when scoped to default', async () => {
    // Seed a unit under source 'other'
    const otherPageId = await seedPage('test/other-page', 'other');
    const defaultPageId = await seedPage('test/default-page', 'default');

    const vecOther = unitVec(0);
    const vecDefault = unitVec(0); // same direction — so both would rank well if not scoped
    await seedUnit(otherPageId, 'text', vecOther);
    await seedUnit(defaultPageId, 'section', vecDefault);

    // Query scoped to 'default' only
    const results = await searchVisualUnits(engine, {
      query: 'test',
      embedFn: async () => unitVec(0),
      sourceScope: { sourceId: 'default' },
      limit: 10,
    });

    // ONLY the default unit should appear
    expect(results.length).toBe(1);
    expect(results[0].source_id).toBe('default');
    expect(results[0].page_slug).toBe('test/default-page');

    // The 'other' source unit must NOT leak
    const otherInResults = results.some(r => r.source_id === 'other');
    expect(otherInResults).toBe(false);
  });

  test('limit is honored', async () => {
    const pageId = await seedPage('test/limit-page');
    for (let i = 0; i < 5; i++) {
      await seedUnit(pageId, 'text', unitVec(i));
    }

    const results = await searchVisualUnits(engine, {
      query: 'test',
      embedFn: async () => unitVec(0),
      limit: 3,
    });

    expect(results.length).toBe(3);
  });

  test('returns empty array when no units have embeddings', async () => {
    const pageId = await seedPage('test/no-embed-page');
    // Insert unit WITHOUT embedding
    await engine.executeRaw(
      `INSERT INTO units (document_id, type) VALUES ($1, 'text')`,
      [pageId],
    );

    const results = await searchVisualUnits(engine, {
      query: 'test',
      embedFn: async () => unitVec(0),
      limit: 10,
    });

    expect(results.length).toBe(0);
  });

  test('result shape: all VisualUnitResult fields present', async () => {
    const pageId = await seedPage('test/shape-page');
    await seedUnit(pageId, 'table', unitVec(2));

    const results = await searchVisualUnits(engine, {
      query: 'test',
      embedFn: async () => unitVec(2),
      limit: 10,
    });

    expect(results.length).toBe(1);
    const r = results[0];
    // Required numeric fields
    expect(typeof r.unit_id).toBe('number');
    expect(typeof r.document_id).toBe('number');
    expect(typeof r.score).toBe('number');
    // String fields
    expect(typeof r.page_slug).toBe('string');
    expect(typeof r.source_id).toBe('string');
    expect(typeof r.type).toBe('string');
    // Nullable fields exist (null or value)
    expect('page_numbers' in r).toBe(true);
    expect('bbox' in r).toBe(true);
    expect('provenance' in r).toBe(true);
    expect('confidence' in r).toBe(true);
    expect('source_image_ref' in r).toBe(true);
  });
});
