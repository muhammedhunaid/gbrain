/**
 * `ingest_visual_doc` minion handler (T013).
 *
 * Processes a visual document (PDF) into semantic units via:
 *   render each page → detect layout → post-process → cross-page stitch
 *   → crop each unit → multimodally embed → persist to `units` table.
 *
 * Idempotent by file content-hash: if the parent page already exists
 * with the same content_hash, returns {status:'skipped'} without
 * reprocessing. A rebuild (hash changed) deletes old units before
 * inserting fresh ones.
 *
 * DI seams allow tests to stub detectLayoutFn and embedFn (the network /
 * cost calls) while render + crop run for real against the fixture PDF.
 */

import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { BrainEngine } from '../../engine.ts';
import type { MinionJobContext } from '../types.ts';
import { renderPdfPageToPng } from '../../ingestion/visual/render.ts';
import { postProcessPage, stitchAcrossPages } from '../../ingestion/visual/post-process.ts';
import type { ProcessedUnit } from '../../ingestion/visual/post-process.ts';
import { cropUnitFromPdf } from '../../ingestion/visual/crop.ts';
import { executeRawJsonb } from '../../sql-query.ts';
import { detectLayout, PROMPT_VERSION } from '../../ai/layout/detect-layout.ts';
import { embedMultimodal, getChatModel, withBudgetTracker, DEFAULT_EMBEDDING_MODEL } from '../../ai/gateway.ts';
import { BudgetTracker, BudgetExhausted } from '../../budget/budget-tracker.ts';
import { loadConfig } from '../../config.ts';

const execFileAsync = promisify(execFile);

/** Pinned DPI — must match render.ts default (200). */
const RENDER_DPI = 200;

/** Path to pdfinfo binary (mirrors PDFTOPPM_BIN in render.ts). */
const PDFINFO_BIN = '/usr/bin/pdfinfo';

// detectLayout's vision model is read per-job from the file-plane config key
// `visual.layout_model` (see resolveLayoutModel below); undefined falls back to
// the gateway's default chat model.
//
// NOTE: `visual.embedding_model` is shipped but NOT yet routed here — embedMultimodal
// resolves its model from the gateway config (embedding_multimodal_model), and a
// per-call override isn't on its API yet. TODO(PR4/PR6): route visual.embedding_model.
function resolveLayoutModel(): string | undefined {
  return loadConfig()?.visual?.layout_model;
}

/**
 * Resolve the CONCRETE layout (vision) model id for provenance pinning (FR-013).
 * When `visual.layout_model` is unset, detectLayout falls back to the gateway's
 * default chat model, so we pin that. getChatModel() throws when the gateway
 * isn't configured (e.g. unit tests with stubbed detectLayoutFn) — fall back to
 * the config chat_model / a stable default so pinning never breaks the ingest.
 */
function resolveLayoutModelPinned(): string {
  const explicit = resolveLayoutModel();
  if (explicit) return explicit;
  try {
    return getChatModel();
  } catch {
    return loadConfig()?.chat_model ?? 'anthropic:claude-sonnet-4-6';
  }
}

/**
 * Resolve the CONCRETE multimodal embed model id for provenance pinning + budget
 * recording. Mirrors embedMultimodal's fallback chain (embedding_multimodal_model
 * → embedding_model → DEFAULT_EMBEDDING_MODEL) with visual.embedding_model as the
 * intended-but-not-yet-routed override at the front (see the TODO above:
 * embedMultimodal does not read visual.embedding_model yet, so this is the
 * documented target, not necessarily what the endpoint used).
 */
function resolveEmbedModelPinned(): string {
  const cfg = loadConfig();
  return cfg?.visual?.embedding_model
    ?? cfg?.embedding_multimodal_model
    ?? cfg?.embedding_model
    ?? DEFAULT_EMBEDDING_MODEL;
}

/**
 * Fixed per-image input-token estimate used when manually recording embed cost
 * against the BudgetTracker. embedMultimodal does NOT auto-record (unlike
 * gateway.chat), so the handler records each embed explicitly to keep the
 * per-job cap holistic (vision + embed). Voyage converts image pixels to tokens
 * server-side; without a returned usage count we use this conservative constant.
 * Tune if Voyage surfaces per-call usage on the multimodal endpoint.
 */
const VISUAL_EMBED_TOKENS_PER_IMAGE = 1568;

// ---- types ------------------------------------------------------------------

export interface VisualIngestJobData {
  filePath: string;
  sourceId?: string;
  slug?: string;
}

export interface VisualIngestResult {
  status: 'ok' | 'skipped' | 'budget_exhausted';
  slug: string;
  document_id?: number;
  pages?: number;
  units?: number;
  reason?: string;
  /** Total USD spent (vision + embed) recorded on the BudgetTracker. */
  spentUsd?: number;
  /** The per-job USD cap in effect (visual.budget_per_job_usd), when set. */
  budgetCapUsd?: number;
  /** Concrete vision model pinned in unit provenance (FR-013). */
  layout_model?: string;
  /** Concrete multimodal embed model pinned in unit provenance (FR-013). */
  embed_model?: string;
}

export interface VisualIngestDeps {
  detectLayoutFn?: typeof detectLayout;
  embedFn?: typeof embedMultimodal;
  /**
   * DI seam (T022): override the per-job USD cap that would otherwise come from
   * `loadConfig()?.visual?.budget_per_job_usd`. Lets tests drive a tiny cap so
   * BudgetExhausted surfaces as `status:'budget_exhausted'` without a config
   * file or real API cost. `undefined` = no override (config value / uncapped).
   */
  budgetCapUsd?: number;
}

// ---- page count helper ------------------------------------------------------

/**
 * Get the page count for a PDF using pdfinfo.
 * Falls back to rendering pages one-by-one if pdfinfo is unavailable.
 * An optional AbortSignal is threaded into the fallback loop so a cancelled
 * job does not spin through a pathological PDF for minutes.
 */
async function getPdfPageCount(pdfPath: string, signal?: AbortSignal): Promise<number> {
  try {
    const { stdout } = await execFileAsync(PDFINFO_BIN, [pdfPath]);
    const m = stdout.match(/^Pages:\s*(\d+)/m);
    if (m) return parseInt(m[1], 10);
  } catch {
    // pdfinfo unavailable — fall through to render-based fallback
  }

  // Render-based fallback: render pages until one fails
  let count = 0;
  for (;;) {
    if (signal?.aborted) break;
    try {
      await renderPdfPageToPng({ pdfPath, page: count + 1, dpi: RENDER_DPI });
      count++;
    } catch {
      break;
    }
  }
  return count;
}

// ---- handler factory ---------------------------------------------------------

export function makeVisualIngestHandler(
  engine: BrainEngine,
  deps: VisualIngestDeps = {},
) {
  const detectLayoutFn = deps.detectLayoutFn ?? detectLayout;
  const embedFn = deps.embedFn ?? embedMultimodal;

  return async function visualIngestHandler(
    job: MinionJobContext,
  ): Promise<VisualIngestResult> {
    const data = job.data as unknown as VisualIngestJobData;

    const filePath = data.filePath;
    if (typeof filePath !== 'string' || filePath.length === 0) {
      throw new Error('visual-ingest: job.data.filePath is required');
    }

    const sourceId = typeof data.sourceId === 'string' && data.sourceId.length > 0
      ? data.sourceId
      : 'default';

    // ---- Step 1: hash the file --------------------------------------------------
    let bytes: Buffer;
    try {
      bytes = await readFile(filePath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`visual-ingest: cannot read file ${filePath}: ${msg}`);
    }
    const fileHash = createHash('sha256').update(bytes).digest('hex');

    // ---- Step 2: slug -----------------------------------------------------------
    const slug = (typeof data.slug === 'string' && data.slug.length > 0)
      ? data.slug
      : `inbox/visual/${fileHash.slice(0, 6)}`;

    // ---- Step 3: idempotency check ----------------------------------------------
    const existing = await engine.getPage(slug, { sourceId });
    if (existing) {
      // putPage stores a hash of the page content (title+compiled_truth+frontmatter…)
      // in pages.content_hash — NOT the PDF file's SHA-256. The PDF hash lives only
      // in frontmatter.content_hash, so the fallback to existing.content_hash would
      // never match fileHash and is misleading. Use frontmatter only.
      const existingHash = existing.frontmatter?.content_hash as string | undefined;
      if (existingHash === fileHash) {
        return { status: 'skipped', slug, reason: 'unchanged' };
      }
    }

    // ---- Budget setup (T022, US4): bound the whole job by visual.budget_per_job_usd.
    // Gateway.chat calls inside withBudgetTracker (detectLayout→visionChat→chat)
    // auto-record + auto-cap via AsyncLocalStorage. embedMultimodal does NOT
    // auto-record, so we manually record each embed below so the cap spans
    // vision + embed and totalSpent reflects both. undefined cap = uncapped.
    const capUsd = deps.budgetCapUsd ?? loadConfig()?.visual?.budget_per_job_usd;
    const tracker = new BudgetTracker({ maxCostUsd: capUsd, label: `visual-ingest:${slug}` });

    // ---- Model pinning (FR-013): resolve concrete ids ONCE for provenance + record.
    const layoutModel = resolveLayoutModelPinned();
    const embedModel = resolveEmbedModelPinned();

    // Mutable state readable in the BudgetExhausted catch + success return
    // (partial progress + final counts live outside the tracker closure).
    let documentId = -1;
    let count = 0;
    let pageCount = 0;

    try {
      await withBudgetTracker(tracker, async () => {
        // ---- Step 4: create/upsert parent page ----------------------------------
        const title = basename(filePath);
        const page = await engine.putPage(
          slug,
          {
            type: 'note',
            title,
            compiled_truth: '',
            timeline: '',
            frontmatter: {
              content_hash: fileHash,
              source_kind: 'visual_ingest',
              source_path: filePath,
            },
          },
          { sourceId },
        );
        documentId = page.id;

        // ---- Step 5: rebuild safety — delete stale units for this document ------
        await engine.executeRaw(
          'DELETE FROM units WHERE document_id = $1',
          [documentId],
        );

        // ---- Step 6: page count -------------------------------------------------
        const N = await getPdfPageCount(filePath, job.signal);
        if (N === 0) {
          throw new Error(`visual-ingest: ${filePath} has 0 pages`);
        }
        pageCount = N;

        // ---- Step 7: per-page render + layout + post-process --------------------
        const perPage: ProcessedUnit[][] = [];
        // Keep rendered dims per page so crop can use them
        const pageRenderedDims = new Map<number, { width: number; height: number }>();

        for (let p = 1; p <= N; p++) {
          if (job.signal.aborted) {
            throw new Error('visual-ingest: aborted');
          }

          const rp = await renderPdfPageToPng({ pdfPath: filePath, page: p, dpi: RENDER_DPI });
          pageRenderedDims.set(p, { width: rp.width, height: rp.height });

          const regions = await detectLayoutFn(
            { data: rp.png.toString('base64'), mime: 'image/png' },
            { model: resolveLayoutModel(), abortSignal: job.signal },
          );

          const units = postProcessPage(regions, p, {});
          perPage.push(units);

          void job.updateProgress({ phase: 'visual_ingest.layout', page: p, total_pages: N, spentUsd: tracker.totalSpent });
        }

        // ---- Step 8: stitch across pages ---------------------------------------
        const finalUnits = stitchAcrossPages(perPage);

        // ---- Step 9: crop + embed + persist each unit --------------------------
        for (const unit of finalUnits) {
          if (job.signal.aborted) {
            throw new Error('visual-ingest: aborted during embed phase');
          }

          // For a stitched multi-page unit there are multiple (page, bbox) pairs.
          // We embed using the crop of the FIRST page/bbox (primary representative image).
          const firstPage = unit.page_numbers[0];
          const firstBbox = unit.bbox[0];
          const dims = pageRenderedDims.get(firstPage);
          if (!dims) {
            throw new Error(`visual-ingest: no rendered dims for page ${firstPage} (document_id=${documentId}) — unit would be dropped`);
          }

          const crop = await cropUnitFromPdf({
            pdfPath: filePath,
            page: firstPage,
            dpi: RENDER_DPI,
            pageWidth: dims.width,
            pageHeight: dims.height,
            bbox: firstBbox,
          });

          const [vec] = await embedFn(
            [{ kind: 'image_base64', data: crop.png.toString('base64'), mime: 'image/png' }],
            { inputType: 'document' },
          );

          const embStr = '[' + Array.from(vec).join(',') + ']';

          // page_numbers must be a Postgres array literal (not a JS array bind param —
          // executeRawJsonb scalars are validated as SqlValue which rejects arrays).
          const pageNumsLiteral = '{' + unit.page_numbers.join(',') + '}';

          // bbox stored as array of per-page boxes (wrap in object for executeRawJsonb)
          const bboxJson = { boxes: unit.bbox };
          // FR-013: pin the concrete models + prompt version into provenance so a
          // re-ingest is reproducible-by-skip and the audit trail names what ran.
          // Bound as trailing $9::jsonb — NOT JSON.stringify'd (executeRawJsonb
          // handles jsonb; see the JSONB invariant).
          const provenanceJson = {
            ...unit.provenance,
            layout_model: layoutModel,
            embed_model: embedModel,
            prompt_version: PROMPT_VERSION,
          };

          await executeRawJsonb(
            engine,
            `INSERT INTO units (document_id, type, page_numbers, reading_order, confidence, source_image_ref, embedding, bbox, provenance)
             VALUES ($1, $2, $3::int[], $4, $5, $6, $7::vector, ($8::jsonb)->'boxes', $9::jsonb)`,
            [documentId, unit.type, pageNumsLiteral, unit.reading_order, unit.confidence, null /* TODO(PR6): persist crop image ref instead of null */, embStr],
            [bboxJson, provenanceJson],
          );
          // Count the unit as persisted BEFORE recording embed cost, so a
          // BudgetExhausted throw from record() still reports this row as retained.
          count++;

          // Manually record embed cost (embedMultimodal doesn't auto-record). Throws
          // BudgetExhausted when this pushes cumulative spend over the cap — AFTER
          // the unit above is already persisted, so partial progress is retained.
          tracker.record({
            modelId: embedModel,
            kind: 'embed',
            inputTokens: VISUAL_EMBED_TOKENS_PER_IMAGE,
            embeddingDims: 1024,
            label: 'visual-ingest.embed',
          });

          void job.updateProgress({ phase: 'visual_ingest.embed', units_persisted: count, total_pages: N, spentUsd: tracker.totalSpent });
        }
      });
    } catch (err) {
      if (err instanceof BudgetExhausted) {
        // Cap hit (vision or embed). Retain already-persisted units — partial
        // progress is reported, never silently discarded.
        return {
          status: 'budget_exhausted',
          slug,
          document_id: documentId >= 0 ? documentId : undefined,
          units: count,
          spentUsd: tracker.totalSpent,
          budgetCapUsd: capUsd,
          layout_model: layoutModel,
          embed_model: embedModel,
        };
      }
      throw err;
    }

    // ---- Step 10: return result -------------------------------------------------
    return {
      status: 'ok',
      slug,
      document_id: documentId,
      pages: pageCount,
      units: count,
      spentUsd: tracker.totalSpent,
      layout_model: layoutModel,
      embed_model: embedModel,
    };
  };
}
