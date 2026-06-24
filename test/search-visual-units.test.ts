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
