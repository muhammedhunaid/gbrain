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
import { detectLayout } from '../../ai/layout/detect-layout.ts';
import { embedMultimodal } from '../../ai/gateway.ts';

const execFileAsync = promisify(execFile);

/** Pinned DPI — must match render.ts default (200). */
const RENDER_DPI = 200;

/** Path to pdfinfo binary (mirrors PDFTOPPM_BIN in render.ts). */
const PDFINFO_BIN = '/usr/bin/pdfinfo';

/** Vision model passed to detectLayout (undefined = gateway default). */
const LAYOUT_MODEL: string | undefined = undefined;

// ---- types ------------------------------------------------------------------

export interface VisualIngestJobData {
  filePath: string;
  sourceId?: string;
  slug?: string;
}

export interface VisualIngestResult {
  status: 'ok' | 'skipped';
  slug: string;
  document_id?: number;
  pages?: number;
  units?: number;
  reason?: string;
}

export interface VisualIngestDeps {
  detectLayoutFn?: typeof detectLayout;
  embedFn?: typeof embedMultimodal;
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

    // ---- Step 4: create/upsert parent page --------------------------------------
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
        },
      },
      { sourceId },
    );
    const documentId = page.id;

    // ---- Step 5: rebuild safety — delete stale units for this document ----------
    await engine.executeRaw(
      'DELETE FROM units WHERE document_id = $1',
      [documentId],
    );

    // ---- Step 6: page count -----------------------------------------------------
    const N = await getPdfPageCount(filePath, job.signal);
    if (N === 0) {
      throw new Error(`visual-ingest: ${filePath} has 0 pages`);
    }

    // ---- Step 7: per-page render + layout + post-process -----------------------
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
        { model: LAYOUT_MODEL, abortSignal: job.signal },
      );

      const units = postProcessPage(regions, p, {});
      perPage.push(units);

      void job.updateProgress({ phase: 'visual_ingest.layout', page: p, total_pages: N });
    }

    // ---- Step 8: stitch across pages -------------------------------------------
    const finalUnits = stitchAcrossPages(perPage);

    // ---- Step 9: crop + embed + persist each unit -------------------------------
    let count = 0;

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
      const provenanceJson = unit.provenance;

      await executeRawJsonb(
        engine,
        `INSERT INTO units (document_id, type, page_numbers, reading_order, confidence, source_image_ref, embedding, bbox, provenance)
         VALUES ($1, $2, $3::int[], $4, $5, $6, $7::vector, ($8::jsonb)->'boxes', $9::jsonb)`,
        [documentId, unit.type, pageNumsLiteral, unit.reading_order, unit.confidence, null /* TODO(PR6): persist crop image ref instead of null */, embStr],
        [bboxJson, provenanceJson],
      );

      void job.updateProgress({ phase: 'visual_ingest.embed', units_persisted: ++count, total_pages: N });
    }

    // ---- Step 10: return result -------------------------------------------------
    return {
      status: 'ok',
      slug,
      document_id: documentId,
      pages: N,
      units: count,
    };
  };
}
