/**
 * T018: Deterministic visual-retrieval eval harness.
 *
 * This harness validates the retrieval MECHANISM deterministically (ranking,
 * no page-position bias, recall@k plumbing) using controlled stub vectors.
 * All embedding vectors are seeded — no API calls are made.
 *
 * Measuring the REAL success-criteria thresholds (e.g. SC-008 ≥90% recall@3
 * on natural-language paraphrases) requires the live multimodal embedder and
 * is OUT OF SCOPE for this CI unit eval. That belongs in a future env-gated
 * live eval, following the T015 validation-gate pattern.
 *
 * Covered spec success criteria:
 *   SC-002 — sibling-table separation: correct sibling ranks #1
 *   SC-003 — late-page parity: no positional penalty for late pages
 *   SC-008 — paraphrase recall@3: query→target unit appears in top-3
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { searchVisualUnits } from '../src/core/search/visual-units.ts';

// ---------------------------------------------------------------------------
// Engine lifecycle (shared per file — initSchema paid once)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a 1024-d one-hot Float32Array (value 1 at `pos`, rest 0). */
function unitVec(pos: number, dims = 1024): Float32Array {
  const v = new Float32Array(dims);
  v[pos] = 1;
  return v;
}

/**
 * Seed a parent page, registering its source if it differs from 'default'.
 * Returns the numeric pages.id.
 */
async function seedPage(slug: string, sourceId = 'default'): Promise<number> {
  if (sourceId !== 'default') {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ($1, $2, '{}'::jsonb) ON CONFLICT (id) DO NOTHING`,
      [sourceId, sourceId],
    );
  }
  await engine.putPage(
    slug,
    { type: 'note', title: slug, compiled_truth: '', timeline: '', frontmatter: {} },
    { sourceId },
  );
  const rows = await engine.executeRaw<{ id: number }>(
    `SELECT id FROM pages WHERE slug = $1 AND source_id = $2 LIMIT 1`,
    [slug, sourceId],
  );
  return rows[0].id;
}

/**
 * Insert a unit row with a controlled embedding and an optional page_numbers array.
 * Returns the inserted unit id.
 */
async function seedUnit(
  documentId: number,
  type: 'table' | 'figure' | 'chart' | 'text' | 'caption' | 'section',
  vec: Float32Array,
  pageNumbers?: number[],
): Promise<number> {
  const vecLit = '[' + Array.from(vec).join(',') + ']';
  const pgArr = pageNumbers ? `'{${pageNumbers.join(',')}}'::int[]` : 'NULL';
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO units (document_id, type, embedding, page_numbers)
       VALUES ($1, $2, $3::vector, ${pgArr})
       RETURNING id`,
    [documentId, type, vecLit],
  );
  return rows[0].id;
}

// ---------------------------------------------------------------------------
// SC-002: sibling-table separation
//   Seed TWO `table` units on the SAME page. Query near unit A → A is #1.
//   Query near unit B → B is #1. Proves same-page siblings are distinguished.
// ---------------------------------------------------------------------------

describe('SC-002: sibling-table separation', () => {
  test('query near tableA ranks tableA first with higher score', async () => {
    const pageId = await seedPage('sc002/sibling-page');

    // Orthogonal basis vectors — cosine similarity between them is 0.
    const vecA = unitVec(0);  // table A
    const vecB = unitVec(1);  // table B  (same page, page 1)

    const idA = await seedUnit(pageId, 'table', vecA, [1]);
    const idB = await seedUnit(pageId, 'table', vecB, [1]);

    // Query aligned with A → A should rank first.
    const resultsA = await searchVisualUnits(engine, {
      query: 'query near tableA',
      embedFn: async () => unitVec(0),
      limit: 10,
    });

    expect(resultsA.length).toBe(2);
    expect(resultsA[0].unit_id).toBe(idA);
    expect(resultsA[1].unit_id).toBe(idB);
    expect(resultsA[0].score).toBeGreaterThan(resultsA[1].score);

    // Query aligned with B → B should rank first.
    const resultsB = await searchVisualUnits(engine, {
      query: 'query near tableB',
      embedFn: async () => unitVec(1),
      limit: 10,
    });

    expect(resultsB.length).toBe(2);
    expect(resultsB[0].unit_id).toBe(idB);
    expect(resultsB[1].unit_id).toBe(idA);
    expect(resultsB[0].score).toBeGreaterThan(resultsB[1].score);
  });
});

// ---------------------------------------------------------------------------
// SC-003: late-page parity
//   Seed a unit on page 1 (early) and page 20 (late) of one document.
//   Query near late-page unit → late-page unit is #1 (no positional penalty).
//   Query near early-page unit → early-page unit is #1.
// ---------------------------------------------------------------------------

describe('SC-003: late-page parity', () => {
  test('late-page unit ranks first when query is near its embedding', async () => {
    const pageId = await seedPage('sc003/late-page-parity');

    const earlyVec = unitVec(10);  // page 1
    const lateVec  = unitVec(11);  // page 20

    const earlyId = await seedUnit(pageId, 'text',  earlyVec, [1]);
    const lateId  = await seedUnit(pageId, 'table', lateVec,  [20]);

    // Query near late embedding (dim 11) → late must rank first.
    const resultsLate = await searchVisualUnits(engine, {
      query: 'query near late page',
      embedFn: async () => unitVec(11),
      limit: 10,
    });

    expect(resultsLate.length).toBe(2);
    expect(resultsLate[0].unit_id).toBe(lateId);
    expect(resultsLate[0].page_numbers).toEqual([20]);
    expect(resultsLate[0].score).toBeGreaterThan(resultsLate[1].score);

    // Query near early embedding (dim 10) → early must rank first.
    const resultsEarly = await searchVisualUnits(engine, {
      query: 'query near early page',
      embedFn: async () => unitVec(10),
      limit: 10,
    });

    expect(resultsEarly.length).toBe(2);
    expect(resultsEarly[0].unit_id).toBe(earlyId);
    expect(resultsEarly[0].page_numbers).toEqual([1]);
    expect(resultsEarly[0].score).toBeGreaterThan(resultsEarly[1].score);
  });
});

// ---------------------------------------------------------------------------
// SC-008: paraphrase recall@3
//   Seed N≥5 units with distinct embeddings.
//   For each "paraphrase query" (lexically unlike the unit but embedFn maps
//   its vector near the target unit), assert the target appears in top-3.
//   Recall@3 == 1.0 over all pairs asserts the retrieval plumbing.
//
//   NOTE: This proves the recall@k MECHANISM with controlled vectors.
//   Real paraphrase semantic quality requires the live multimodal embedder.
// ---------------------------------------------------------------------------

describe('SC-008: paraphrase recall@3', () => {
  test('paraphrase query vectors retrieve the correct target in top-3', async () => {
    const pageId = await seedPage('sc008/paraphrase-recall');

    // Seed 6 units, each at a distinct orthogonal dimension.
    const dims = [20, 21, 22, 23, 24, 25];
    const unitIds: number[] = [];
    const types = ['table', 'figure', 'chart', 'text', 'caption', 'section'] as const;
    for (let i = 0; i < dims.length; i++) {
      const id = await seedUnit(pageId, types[i], unitVec(dims[i]));
      unitIds.push(id);
    }

    // Define paraphrase query → target index mappings.
    // Each "paraphrase" is a lexically distinct string but its embedFn
    // returns a vector near the target unit's embedding.
    const paraphrasePairs: Array<{ queryLabel: string; targetDim: number; targetIdx: number }> = [
      { queryLabel: 'revenue summary chart (paraphrase of table)',    targetDim: dims[0], targetIdx: 0 },
      { queryLabel: 'bar graph showing results (paraphrase of figure)', targetDim: dims[1], targetIdx: 1 },
      { queryLabel: 'pie chart breakdown (paraphrase of chart)',      targetDim: dims[2], targetIdx: 2 },
      { queryLabel: 'written analysis section (paraphrase of text)',  targetDim: dims[3], targetIdx: 3 },
    ];

    let hits = 0;
    for (const pair of paraphrasePairs) {
      // embedFn maps this paraphrase string → its target's vector (stub semantics).
      const queryVec = unitVec(pair.targetDim);
      const results = await searchVisualUnits(engine, {
        query: pair.queryLabel,
        embedFn: async () => queryVec,
        limit: 3,
      });

      expect(results.length).toBe(3);
      const targetId = unitIds[pair.targetIdx];
      const found = results.some(r => r.unit_id === targetId);
      if (found) hits++;

      // Assert target is in top-3 for each pair.
      expect(found).toBe(true);
    }

    // Recall@3 == 1.0 over all paraphrase pairs.
    const recall3 = hits / paraphrasePairs.length;
    expect(recall3).toBe(1.0);
  });

  test('recall@3 holds WITH a rerank pass that preserves vector order', async () => {
    const pageId = await seedPage('sc008/paraphrase-recall-rerank');

    const dims = [30, 31, 32, 33, 34];
    const unitIds: number[] = [];
    for (let i = 0; i < dims.length; i++) {
      const id = await seedUnit(pageId, 'text', unitVec(dims[i]));
      unitIds.push(id);
    }

    // rerankFn that preserves the recall order (scores descend by index).
    const rerankFn = async (input: { query: string; documents: string[]; topN?: number }) => {
      const n = input.topN ?? input.documents.length;
      return Array.from({ length: Math.min(n, input.documents.length) }, (_, i) => ({
        index: i,
        relevanceScore: 1 - i * 0.1,
      }));
    };

    // Query near dim 31 (index 1 in the pool) → should still be in top-3.
    const results = await searchVisualUnits(engine, {
      query: 'paraphrase for unit at dim 31',
      embedFn: async () => unitVec(31),
      limit: 3,
      rerankFn,
    });

    expect(results.length).toBe(3);
    const targetId = unitIds[1];
    const found = results.some(r => r.unit_id === targetId);
    expect(found).toBe(true);
  });
});
