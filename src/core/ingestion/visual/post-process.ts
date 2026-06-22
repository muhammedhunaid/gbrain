/**
 * T010 — Deterministic layout post-processing.
 *
 * Turns raw LayoutRegion[] (from detectLayout / T009) into clean,
 * persist-ready ProcessedUnit[]. All functions are pure and deterministic:
 * no AI calls, no DB, no config reads — the caller passes options.
 *
 * Three entry points:
 *   postProcessPage   — main pipeline for a single page
 *   geometricFallback — safe N-band fallback when layout detection fails
 *   stitchAcrossPages — FR-016 cross-page table/figure stitching
 */

import type { LayoutRegion, UnitType } from '../../ai/layout/detect-layout.ts';

// ---- exported default constants --------------------------------------------

/** Height fraction at top/bottom treated as header/footer band. */
export const DEFAULT_HEADER_FOOTER_BAND = 0.06;

/** Padding added to each kept bbox (in normalized coords). */
export const DEFAULT_PADDING = 0.01;

/** Minimum confidence; if all regions are below this, use geometric fallback. */
export const DEFAULT_MIN_CONFIDENCE = 0.35;

/** Number of horizontal bands in the geometric fallback. */
export const DEFAULT_FALLBACK_BANDS = 3;

/** Distance from page edge (top/bottom) that a unit must reach to be stitchable. */
export const DEFAULT_STITCH_BAND = 0.05;

// ---- types ------------------------------------------------------------------

export interface ProcessedUnit {
  type: UnitType;
  /** 1-based page numbers. One entry per page when not stitched; multiple when stitched. */
  page_numbers: number[];
  /** One bounding box per page (stitch → multiple). Each box is normalized [0,1]. */
  bbox: { x0: number; y0: number; x1: number; y1: number }[];
  /** 0-based, dense (renumbered by postProcessPage). */
  reading_order: number;
  confidence: number;
  caption?: string;
  provenance: {
    source: 'layout' | 'geometric_fallback';
    fallback?: boolean;
    [k: string]: unknown;
  };
}

export interface PostProcessOpts {
  /** Override default header/footer band height. Default: DEFAULT_HEADER_FOOTER_BAND */
  headerFooterBand?: number;
  /** Padding to expand each bbox. Default: DEFAULT_PADDING */
  padding?: number;
  /** Regions with confidence below this trigger geometric fallback (when ALL are below). Default: DEFAULT_MIN_CONFIDENCE */
  minConfidence?: number;
  /** Number of horizontal bands for geometric fallback. Default: DEFAULT_FALLBACK_BANDS */
  fallbackBands?: number;
  /** Stitch band — fraction from edge to qualify a unit as stitchable. Default: DEFAULT_STITCH_BAND */
  stitchBand?: number;
}

// ---- helpers ----------------------------------------------------------------

/** Clamp a number to [min, max]. */
function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}

/** Clamp and normalize a bbox to [0,1], returning null if it is degenerate. */
function clampBbox(
  raw: { x0: number; y0: number; x1: number; y1: number },
): { x0: number; y0: number; x1: number; y1: number } | null {
  const x0 = clamp(raw.x0, 0, 1);
  const y0 = clamp(raw.y0, 0, 1);
  const x1 = clamp(raw.x1, 0, 1);
  const y1 = clamp(raw.y1, 0, 1);
  if (x0 >= x1 || y0 >= y1) return null;
  return { x0, y0, x1, y1 };
}

/**
 * Returns true if the region is a short header/footer artifact.
 * A region is considered a header/footer if it sits ENTIRELY within
 * the top or bottom band (no part of it extends into the body).
 */
function isHeaderFooter(
  bbox: { x0: number; y0: number; x1: number; y1: number },
  band: number,
): boolean {
  // Entirely in the top band
  if (bbox.y0 >= 0 && bbox.y1 <= band) return true;
  // Entirely in the bottom band
  if (bbox.y0 >= 1 - band && bbox.y1 <= 1) return true;
  return false;
}

/** Pad a bbox outward by `padding`, clamped to [0,1]. */
function padBbox(
  bbox: { x0: number; y0: number; x1: number; y1: number },
  padding: number,
): { x0: number; y0: number; x1: number; y1: number } {
  return {
    x0: clamp(bbox.x0 - padding, 0, 1),
    y0: clamp(bbox.y0 - padding, 0, 1),
    x1: clamp(bbox.x1 + padding, 0, 1),
    y1: clamp(bbox.y1 + padding, 0, 1),
  };
}

// ---- public API -------------------------------------------------------------

/**
 * Geometric fallback — produce N equal horizontal bands covering the full page.
 * All units have type 'text' and provenance source:'geometric_fallback'.
 * NEVER throws.
 */
export function geometricFallback(pageNumber: number, opts?: PostProcessOpts): ProcessedUnit[] {
  const bands = Math.max(1, opts?.fallbackBands ?? DEFAULT_FALLBACK_BANDS);
  const units: ProcessedUnit[] = [];
  const bandHeight = 1 / bands;

  for (let i = 0; i < bands; i++) {
    const y0 = i * bandHeight;
    const y1 = i === bands - 1 ? 1 : (i + 1) * bandHeight;
    units.push({
      type: 'text',
      page_numbers: [pageNumber],
      bbox: [{ x0: 0, y0, x1: 1, y1 }],
      reading_order: i,
      confidence: 0,
      provenance: { source: 'geometric_fallback', fallback: true },
    });
  }

  return units;
}

/**
 * Post-process a single page's raw LayoutRegion[] into ProcessedUnit[].
 *
 * Pipeline:
 *  1. Clamp/validate bboxes — drop degenerate ones.
 *  2. Drop header/footer bands.
 *  3. Check fallback condition (empty or all-low-confidence).
 *  4. Pad remaining bboxes.
 *  5. Sort by reading_order; renumber to dense 0-based.
 */
export function postProcessPage(
  regions: LayoutRegion[],
  pageNumber: number,
  opts?: PostProcessOpts,
): ProcessedUnit[] {
  const band = opts?.headerFooterBand ?? DEFAULT_HEADER_FOOTER_BAND;
  const padding = opts?.padding ?? DEFAULT_PADDING;
  const minConfidence = opts?.minConfidence ?? DEFAULT_MIN_CONFIDENCE;

  // Step 1: fallback if the *input* is empty or entirely below confidence threshold.
  // (Header/footer drop happens AFTER this check — we don't want to fallback just
  //  because all detected regions are running headers.)
  if (regions.length === 0) {
    return geometricFallback(pageNumber, opts);
  }
  const allLow = regions.every(r => r.confidence < minConfidence);
  if (allLow) {
    return geometricFallback(pageNumber, opts);
  }

  // Step 2: clamp/validate bboxes
  const valid: { region: LayoutRegion; bbox: { x0: number; y0: number; x1: number; y1: number } }[] = [];
  for (const r of regions) {
    const clamped = clampBbox(r.bbox);
    if (clamped === null) continue;
    valid.push({ region: r, bbox: clamped });
  }

  // Step 3: drop header/footer (small regions fully within the top/bottom band)
  const body = valid.filter(({ bbox }) => !isHeaderFooter(bbox, band));

  // Step 4: sort by reading_order
  body.sort((a, b) => a.region.reading_order - b.region.reading_order);

  // Step 5: pad and emit ProcessedUnit, with densified reading_order
  return body.map(({ region, bbox }, idx) => {
    const paddedBbox = padBbox(bbox, padding);
    const unit: ProcessedUnit = {
      type: region.type,
      page_numbers: [pageNumber],
      bbox: [paddedBbox],
      reading_order: idx,
      confidence: region.confidence,
      provenance: { source: 'layout' },
    };
    if (region.caption !== undefined) {
      unit.caption = region.caption;
    }
    return unit;
  });
}

/**
 * FR-016 — Cross-page table/figure stitch.
 *
 * If a 'table' or 'figure' unit on page N has its last bbox touching the
 * bottom band (y1 >= 1 - stitchBand), and the first unit of the same type
 * on page N+1 touches the top band (y0 <= stitchBand), merge them into a
 * single unit spanning both pages.
 *
 * Three-page (and longer) stitch is handled iteratively.
 * All other units pass through unchanged.
 */
export function stitchAcrossPages(
  perPageUnits: ProcessedUnit[][],
  opts?: PostProcessOpts,
): ProcessedUnit[] {
  const stitchBand = opts?.stitchBand ?? DEFAULT_STITCH_BAND;

  if (perPageUnits.length === 0) return [];

  // Flatten all pages into a mutable working list, preserving per-page order.
  // We work in two passes:
  //   Pass 1 — for each page N, attempt to stitch the candidate from page N
  //            with a matching candidate at the top of page N+1.
  //   Pass 2 — collect the result.
  //
  // Strategy: iterate pages left-to-right, carrying a "pending stitch" unit
  // that absorbs qualifying units from subsequent pages.

  const stitchableTypes = new Set<UnitType>(['table', 'figure']);

  // Build a mutable working list per page.
  type Entry = { unit: ProcessedUnit; absorbed: boolean };
  const entries: Entry[][] = perPageUnits.map(page =>
    page.map(unit => ({ unit, absorbed: false })),
  );

  // Track the active "open tail" for each type — the unit that is currently
  // spanning from some earlier page and is waiting for a continuation on the
  // next page. Keyed by UnitType.
  const openTails = new Map<UnitType, Entry>();

  for (let n = 0; n < entries.length; n++) {
    const pageEntries = entries[n];

    // For each type that has an open tail, check if page N provides a head.
    for (const [type, tail] of openTails) {
      const headCandidates = pageEntries.filter(
        e => !e.absorbed && e.unit.type === type && e.unit.bbox[0].y0 <= stitchBand,
      );
      if (headCandidates.length > 0) {
        const head = headCandidates[0];
        // Absorb head into tail.
        tail.unit.page_numbers = [...tail.unit.page_numbers, ...head.unit.page_numbers];
        tail.unit.bbox = [...tail.unit.bbox, ...head.unit.bbox];
        tail.unit.reading_order = Math.min(tail.unit.reading_order, head.unit.reading_order);
        if (tail.unit.caption === undefined && head.unit.caption !== undefined) {
          tail.unit.caption = head.unit.caption;
        }
        head.absorbed = true;

        // If the merged unit (now ending with head's last bbox) still touches the
        // bottom band of this page, keep the tail open for the next page.
        const lastBbox = tail.unit.bbox[tail.unit.bbox.length - 1];
        if (lastBbox.y1 >= 1 - stitchBand) {
          openTails.set(type, tail);
        } else {
          openTails.delete(type);
        }
      } else {
        // No continuation found on this page — close the tail.
        openTails.delete(type);
      }
    }

    // Now look for NEW tails starting on this page (non-absorbed stitchable units
    // touching the bottom band). Only the last candidate per type becomes the new tail.
    for (const type of stitchableTypes) {
      if (openTails.has(type)) continue; // already tracking one
      const newTailCandidates = pageEntries.filter(
        e =>
          !e.absorbed &&
          e.unit.type === type &&
          e.unit.bbox[e.unit.bbox.length - 1].y1 >= 1 - stitchBand,
      );
      if (newTailCandidates.length > 0) {
        openTails.set(type, newTailCandidates[newTailCandidates.length - 1]);
      }
    }
  }

  // Collect all non-absorbed units in page order.
  const result: ProcessedUnit[] = [];
  for (const page of entries) {
    for (const { unit, absorbed } of page) {
      if (!absorbed) result.push(unit);
    }
  }

  return result;
}
