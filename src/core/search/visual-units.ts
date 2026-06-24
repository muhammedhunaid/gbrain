/**
 * T016: multimodal recall over the `units` table.
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
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Search units via multimodal query embedding + source-scoped vector search
 * over `units.embedding`. Returns results ordered by cosine similarity desc.
 *
 * Source isolation is enforced via a JOIN to pages — units has no source_id.
 */
export async function searchVisualUnits(
  engine: BrainEngine,
  opts: SearchVisualUnitsOpts,
): Promise<VisualUnitResult[]> {
  const limit = opts.limit ?? 10;

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
    [vecLit, sourceIds, sourceId, limit],
  );

  // Map rows to VisualUnitResult — bbox/provenance arrive as parsed JS objects
  // from PGLite, do NOT JSON.parse/stringify them.
  return rows.map(r => ({
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
}
