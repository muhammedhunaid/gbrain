/**
 * detectLayout (T009) — LLM-vision page layout detection.
 *
 * Given a rendered page image, asks a vision model (via the gateway-routed
 * visionChat) to segment the page into semantic regions. Parses and validates
 * the STRICT JSON response into LayoutRegion[], caches by content-hash.
 *
 * Route: AI calls flow exclusively through visionChat (or the injected visionFn
 * DI seam). No provider SDK calls here.
 */

import { createHash } from 'crypto';
import { visionChat } from '../vision.ts';

// ---- types ------------------------------------------------------------------

export type UnitType = 'table' | 'figure' | 'chart' | 'text' | 'caption' | 'section';

export interface LayoutRegion {
  type: UnitType;
  /** Normalized bounding box in [0,1], origin top-left, x0<x1 && y0<y1. */
  bbox: { x0: number; y0: number; x1: number; y1: number };
  /** 0-based reading order index. */
  reading_order: number;
  /** Confidence score in [0,1]. */
  confidence: number;
  /** Bound caption text for table/figure, if any. */
  caption?: string;
}

export interface DetectLayoutOpts {
  /** Model override — defaults to the gateway-configured chat model. */
  model?: string;
  abortSignal?: AbortSignal;
  /**
   * DI seam for tests. Defaults to the real visionChat from ../vision.ts.
   * Signature must match visionChat.
   */
  visionFn?: typeof visionChat;
  /**
   * Cache store. Defaults to the module-level Map.
   * Key: sha256(image.data) + ':' + model + ':' + PROMPT_VERSION.
   */
  cache?: { get(k: string): LayoutRegion[] | undefined; set(k: string, v: LayoutRegion[]): void };
}

// ---- constants --------------------------------------------------------------

export const PROMPT_VERSION = 'v1';

const VALID_UNIT_TYPES = new Set<string>([
  'table',
  'figure',
  'chart',
  'text',
  'caption',
  'section',
]);

// Module-level default cache (shared across calls unless caller injects their own).
const DEFAULT_CACHE = new Map<string, LayoutRegion[]>();

// ---- prompts ----------------------------------------------------------------

const SYSTEM_PROMPT = `You are a document-layout analysis engine.
Your job is to segment a rendered page image into semantic regions and return ONLY a JSON array — no prose, no explanation, no markdown fences.

Each element of the array must be a JSON object with these exact fields:
  "type"          : one of "table" | "figure" | "chart" | "text" | "caption" | "section"
  "bbox"          : { "x0": number, "y0": number, "x1": number, "y1": number }
                    — normalized coordinates in [0, 1], origin is top-left, x0 < x1 and y0 < y1
  "reading_order" : integer (0-based), column-aware left-to-right top-to-bottom reading order
  "confidence"    : number in [0, 1]
  "caption"       : (optional) bound caption text for table or figure regions

Rules:
- Assign reading_order integers starting from 0, incrementing in natural reading order.
- Bind each caption to its table/figure (include "caption" field on the table/figure region, not as a separate region).
- Return ONLY the JSON array. Do NOT wrap it in markdown fences or prose.`;

const USER_PROMPT = `Analyze this page image and return a JSON array of all semantic layout regions following the schema in the system prompt.`;

// ---- helpers ----------------------------------------------------------------

/**
 * Strip ```json ... ``` or ``` ... ``` fences from LLM output before parsing.
 * Anchors to leading/trailing fences to avoid over-stripping.
 */
function stripFences(text: string): string {
  // Match optional language tag after opening fence
  return text
    .replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/m, '$1')
    .trim();
}

function isFiniteInRange(n: unknown, min: number, max: number): boolean {
  return typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max;
}

/**
 * Validate and normalise a single raw region object from the LLM response.
 * Returns a LayoutRegion if valid, null if the region must be dropped.
 */
function parseRegion(raw: unknown): LayoutRegion | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  // type
  if (typeof r['type'] !== 'string' || !VALID_UNIT_TYPES.has(r['type'])) return null;

  // bbox
  const b = r['bbox'];
  if (!b || typeof b !== 'object') return null;
  const { x0, y0, x1, y1 } = b as Record<string, unknown>;
  if (
    !isFiniteInRange(x0, 0, 1) ||
    !isFiniteInRange(y0, 0, 1) ||
    !isFiniteInRange(x1, 0, 1) ||
    !isFiniteInRange(y1, 0, 1) ||
    (x0 as number) >= (x1 as number) ||
    (y0 as number) >= (y1 as number)
  ) {
    return null;
  }

  // reading_order — coerce to int
  if (typeof r['reading_order'] !== 'number' || !Number.isFinite(r['reading_order'])) return null;
  const reading_order = Math.trunc(r['reading_order'] as number);

  // confidence
  if (!isFiniteInRange(r['confidence'], 0, 1)) return null;

  const region: LayoutRegion = {
    type: r['type'] as UnitType,
    bbox: {
      x0: x0 as number,
      y0: y0 as number,
      x1: x1 as number,
      y1: y1 as number,
    },
    reading_order,
    confidence: r['confidence'] as number,
  };

  if (typeof r['caption'] === 'string' && r['caption'].length > 0) {
    region.caption = r['caption'];
  }

  return region;
}

/**
 * Parse + validate the LLM text response into LayoutRegion[].
 * Throws a descriptive Error if the top-level structure is unusable.
 * Invalid individual regions are silently dropped.
 */
function parseResponse(text: string): LayoutRegion[] {
  const stripped = stripFences(text);

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    throw new Error(
      `detectLayout: failed to parse LLM response as JSON. Response started with: ${text.slice(0, 120)}`,
    );
  }

  if (!Array.isArray(parsed)) {
    throw new Error(
      `detectLayout: expected JSON array from LLM, got ${typeof parsed}`,
    );
  }

  const regions: LayoutRegion[] = [];
  for (const item of parsed) {
    const region = parseRegion(item);
    if (region !== null) regions.push(region);
  }

  // Sort by reading_order
  regions.sort((a, b) => a.reading_order - b.reading_order);
  return regions;
}

// ---- cache key --------------------------------------------------------------

function buildCacheKey(imageData: string, model: string | undefined): string {
  const hash = createHash('sha256').update(imageData).digest('hex');
  return `${hash}:${model ?? 'default'}:${PROMPT_VERSION}`;
}

// ---- public API -------------------------------------------------------------

/**
 * Detect semantic layout regions in a rendered page image using a vision model.
 *
 * @param pageImage  Base64-encoded page image with MIME type.
 * @param opts       Optional configuration including DI seam for tests.
 * @returns          Validated LayoutRegion[] sorted by reading_order.
 */
export async function detectLayout(
  pageImage: { data: string; mime: string },
  opts?: DetectLayoutOpts,
): Promise<LayoutRegion[]> {
  const cache = opts?.cache ?? DEFAULT_CACHE;
  const cacheKey = buildCacheKey(pageImage.data, opts?.model);

  // Cache hit
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  // Call vision model
  const fn = opts?.visionFn ?? visionChat;
  const raw = await fn({
    images: [pageImage],
    prompt: USER_PROMPT,
    system: SYSTEM_PROMPT,
    model: opts?.model,
    abortSignal: opts?.abortSignal,
  });

  const regions = parseResponse(raw);

  cache.set(cacheKey, regions);
  return regions;
}
