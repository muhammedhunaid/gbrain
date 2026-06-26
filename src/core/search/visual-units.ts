/**
 * T016: multimodal recall over the `units` table.
 * T017: optional cross-encoder rerank stage (rerank-2.5, fail-open).
 *
 * Dedicated read path — NOT integrated into hybridSearch. Uses executeRaw
 * only (no engine methods) to keep engine parity untouched.
 */

import type { BrainEngine } from '../engine.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VisualUnitResult {
  unit_id: number;
  document_id: number;
  page_slug: string;
  source_id: string;
  type: 'table' | 'figure' | 'chart' | 'text' | 'caption' | 'section';
  page_numbers: number[] | null;
  bbox: unknown | null;
  provenance: unknown | null;
  confidence: number | null;
  source_image_ref: string | null;
  /** cosine similarity: 1 - pgvector cosine distance */
  score: number;
  /** cross-encoder relevance score (set only when reranking was applied) */
  rerank_score?: number;
}

export interface SearchVisualUnitsOpts {
  query: string;
  /** Source scope (from sourceScopeOpts(ctx) in the operation handler). */
  sourceScope?: { sourceIds?: string[]; sourceId?: string };
  /** Max results to return. Default 10. */
  limit?: number;
  /**
   * DI seam: inject a custom embed function. When provided, skips the
   * isAvailable gateway gate and uses this function directly. Designed for
   * tests (pass a fixed-vector stub; no API call needed).
   *
   * Default: embedQueryMultimodal from gateway.ts (1024d multimodal embedding).
   */
  embedFn?: (text: string) => Promise<Float32Array>;

  // -------------------------------------------------------------------------
  // T017: rerank options
  // -------------------------------------------------------------------------

  /**
   * Whether to apply a cross-encoder rerank pass over recall candidates.
   * - undefined / omitted → AUTO: on iff isAvailable('reranker') OR rerankFn is provided
   * - true → force on (if no rerankFn and gateway reranker unavailable → fail-open, not a throw)
   * - false → force off
   */
  rerank?: boolean;

  /**
   * DI seam for the reranker. When provided, reranking is treated as enabled
   * regardless of gateway availability (this is the test path — no API call).
   * Signature matches gateway rerank().
   */
  rerankFn?: (input: {
    query: string;
    documents: string[];
    topN?: number;
  }) => Promise<{ index: number; relevanceScore: number }[]>;

  /**
   * Final number of results to return after reranking. Defaults to limit.
   * Irrelevant when reranking is not applied.
   */
  rerankTopN?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a text representation of a visual unit for the cross-encoder.
 *
 * NOTE: units store no transcription yet, so this text representation is thin
 * (type + caption + page + provenance source) — full vision-transcribe-then-rerank
 * is deferred (cross-modal gap). The reranker can still reorder by contextual
 * relevance using this metadata.
 */
function textRep(u: VisualUnitResult): string {
  const parts: string[] = [u.type];
  // Caption: units don't carry a caption field in the DB yet, so skip for now.
  // page_numbers
  parts.push('page ' + (u.page_numbers?.join(',') ?? '?'));
  // provenance source
  const prov = u.provenance as Record<string, unknown> | null;
  if (prov && typeof prov.source === 'string') {
    parts.push(prov.source);
  }
  return parts.filter(Boolean).join(' — ');
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Search units via multimodal query embedding + source-scoped vector search
 * over `units.embedding`. Returns results ordered by cosine similarity desc.
 *
 * Optionally applies a cross-encoder rerank pass (T017). Fail-open: a rerank
 * failure never breaks recall — recall order is returned unchanged.
 *
 * Source isolation is enforced via a JOIN to pages — units has no source_id.
 */
export async function searchVisualUnits(
  engine: BrainEngine,
  opts: SearchVisualUnitsOpts,
): Promise<VisualUnitResult[]> {
  const limit = opts.limit ?? 10;

  // Determine whether to rerank.
  // AUTO: on iff rerankFn provided OR gateway reranker available.
  let doRerank: boolean;
  if (opts.rerank === false) {
    doRerank = false;
  } else if (opts.rerank === true) {
    // Force on — but if no rerankFn and gateway unavailable, fail-open later.
    doRerank = true;
  } else {
    // AUTO
    if (opts.rerankFn) {
      doRerank = true;
    } else {
      const { isAvailable } = await import('../ai/gateway.ts');
      doRerank = isAvailable('reranker');
    }
  }

  // When reranking, over-fetch recall candidates.
  const candidateK = doRerank ? Math.max(limit, 30) : limit;

  // --- Embed the query ---
  let vec: Float32Array;
  if (opts.embedFn) {
    // DI seam: caller injected a custom embed function — bypass gateway gate.
    vec = await opts.embedFn(opts.query);
  } else {
    // Production path: gate on embedding availability then use multimodal embedder.
    const { isAvailable } = await import('../ai/gateway.ts');
    if (!isAvailable('embedding')) {
      throw new Error('search_visual_units: gateway not configured for embedding');
    }
    const { embedQueryMultimodal } = await import('../ai/gateway.ts');
    vec = await embedQueryMultimodal(opts.query);
  }

  const vecLit = '[' + Array.from(vec).join(',') + ']';

  // Resolve source scope params. $2 = sourceIds array (or null), $3 = scalar sourceId (or null).
  const sourceIds: string[] | null = opts.sourceScope?.sourceIds ?? null;
  const sourceId: string | null = opts.sourceScope?.sourceId ?? null;

  // Source-scoped vector search. The JOIN to pages enforces source isolation
  // (units has no source_id column). embedding IS NOT NULL guards partial HNSW.
  const rows = await (engine as { executeRaw: <T>(sql: string, params?: unknown[]) => Promise<T[]> }).executeRaw<{
    unit_id: number;
    document_id: number;
    page_slug: string;
    source_id: string;
    type: 'table' | 'figure' | 'chart' | 'text' | 'caption' | 'section';
    page_numbers: number[] | null;
    bbox: unknown | null;
    provenance: unknown | null;
    confidence: number | null;
    source_image_ref: string | null;
    score: number;
  }>(
    `SELECT u.id AS unit_id, u.document_id, p.slug AS page_slug, p.source_id,
            u.type, u.page_numbers, u.bbox, u.provenance, u.confidence, u.source_image_ref,
            (1 - (u.embedding <=> $1::vector))::real AS score
     FROM units u JOIN pages p ON p.id = u.document_id
     WHERE u.embedding IS NOT NULL
       AND ($2::text[] IS NULL OR p.source_id = ANY($2::text[]))
       AND ($3::text   IS NULL OR p.source_id = $3)
     ORDER BY u.embedding <=> $1::vector
     LIMIT $4`,
    [vecLit, sourceIds, sourceId, candidateK],
  );

  // Map rows to VisualUnitResult — bbox/provenance arrive as parsed JS objects
  // from PGLite, do NOT JSON.parse/stringify them.
  const recallResults: VisualUnitResult[] = rows.map(r => ({
    unit_id: r.unit_id,
    document_id: r.document_id,
    page_slug: r.page_slug,
    source_id: r.source_id,
    type: r.type,
    page_numbers: r.page_numbers,
    bbox: r.bbox,
    provenance: r.provenance,
    confidence: r.confidence,
    source_image_ref: r.source_image_ref,
    score: r.score,
  }));

  // --- Rerank stage (T017) ---
  if (!doRerank) {
    // No rerank: return top `limit` in recall order (T016 behavior unchanged).
    return recallResults.slice(0, limit);
  }

  // Resolve the rerank function (DI seam or gateway).
  let rerankFn = opts.rerankFn;
  if (!rerankFn) {
    const { isAvailable, rerank } = await import('../ai/gateway.ts');
    if (!isAvailable('reranker')) {
      // Forced true but no reranker configured → fail-open: return recall top-limit.
      console.warn('search_visual_units: rerank forced=true but reranker unavailable — falling back to recall order');
      return recallResults.slice(0, limit);
    }
    rerankFn = (input) => rerank(input);
  }

  const finalTopN = opts.rerankTopN ?? limit;

  // Build text representations for the cross-encoder.
  const textReps = recallResults.map(textRep);

  try {
    const rerankResults = await rerankFn({ query: opts.query, documents: textReps, topN: finalTopN });

    if (!rerankResults || rerankResults.length === 0) {
      // Empty results → fail-open.
      console.warn('search_visual_units: rerankFn returned empty — falling back to recall order');
      return recallResults.slice(0, limit);
    }

    // Reorder recallResults by the returned index order, set rerank_score.
    const reranked: VisualUnitResult[] = rerankResults.map(r => ({
      ...recallResults[r.index],
      rerank_score: r.relevanceScore,
    }));

    return reranked.slice(0, finalTopN);
  } catch (err) {
    // FAIL-OPEN: any rerankFn error → return recall-ordered top limit unchanged.
    console.warn('search_visual_units: rerankFn threw, falling back to recall order:', (err as Error)?.message ?? err);
    return recallResults.slice(0, limit);
  }
}
