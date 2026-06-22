/**
 * Semantic-unit cropper: renders a sub-region of a PDF page to PNG.
 *
 * Uses pdftoppm's crop flags (-x/-y/-W/-H) to render directly from the vector
 * source at the chosen DPI — higher quality than raster post-crop.
 *
 * Caller must supply the rendered full-page pixel dimensions (pageWidth /
 * pageHeight) at the same DPI, typically obtained from a prior renderPdfPageToPng
 * call or from a cached render run.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, unlink, stat, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFTOPPM_BIN, readPngIhdrDimensions } from './render.ts';

const execFileAsync = promisify(execFile);

export interface CroppedUnit {
  png: Buffer;
  /** Actual cropped pixel width (read from PNG IHDR). */
  width: number;
  /** Actual cropped pixel height (read from PNG IHDR). */
  height: number;
  provenance: {
    /** 1-based page number. */
    page: number;
    /** Normalized bbox input [0, 1]. */
    bbox: { x0: number; y0: number; x1: number; y1: number };
    /** Computed device-pixel crop rect. */
    pixel_rect: { x: number; y: number; w: number; h: number };
    dpi: number;
  };
}

/**
 * Crop a normalized bbox region from a PDF page and return it as PNG.
 *
 * @param opts.pdfPath  - Absolute path to the PDF file.
 * @param opts.page     - 1-based page number.
 * @param opts.dpi      - DPI the page was (or will be) rendered at.
 * @param opts.pageWidth  - Full-page pixel width at the given DPI.
 * @param opts.pageHeight - Full-page pixel height at the given DPI.
 * @param opts.bbox     - Normalized [0, 1] bounding box {x0, y0, x1, y1}.
 *
 * @throws Error if bbox is invalid, pdftoppm is missing, the file doesn't exist,
 *   the page is out of range, or pdftoppm fails for any other reason.
 */
export async function cropUnitFromPdf(opts: {
  pdfPath: string;
  page: number;
  dpi: number;
  pageWidth: number;
  pageHeight: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}): Promise<CroppedUnit> {
  const { pdfPath, page, dpi, pageWidth, pageHeight, bbox } = opts;

  // --- Validate bbox ---
  const { x0, y0, x1, y1 } = bbox;
  if (!isFinite(x0) || !isFinite(y0) || !isFinite(x1) || !isFinite(y1)) {
    throw new Error(`cropUnitFromPdf: bbox values must be finite numbers (got ${JSON.stringify(bbox)})`);
  }
  if (x0 < 0 || y0 < 0 || x1 > 1 || y1 > 1) {
    throw new Error(`cropUnitFromPdf: bbox values must be in [0, 1] (got ${JSON.stringify(bbox)})`);
  }
  if (x1 <= x0) {
    throw new Error(`cropUnitFromPdf: invalid bbox — x1 (${x1}) must be greater than x0 (${x0})`);
  }
  if (y1 <= y0) {
    throw new Error(`cropUnitFromPdf: invalid bbox — y1 (${y1}) must be greater than y0 (${y0})`);
  }

  // --- Compute device-pixel rect ---
  let x = Math.round(x0 * pageWidth);
  let y = Math.round(y0 * pageHeight);
  let w = Math.round((x1 - x0) * pageWidth);
  let h = Math.round((y1 - y0) * pageHeight);

  // Clamp to page bounds
  if (x + w > pageWidth) w = pageWidth - x;
  if (y + h > pageHeight) h = pageHeight - y;

  if (w < 1 || h < 1) {
    throw new Error(
      `cropUnitFromPdf: computed crop rect is too small (w=${w}, h=${h}) — ` +
      `bbox may be degenerate after rounding`,
    );
  }

  const pixel_rect = { x, y, w, h };

  // --- Check pdftoppm availability ---
  try {
    await stat(PDFTOPPM_BIN);
  } catch {
    throw new Error(
      `cropUnitFromPdf: pdftoppm not found at ${PDFTOPPM_BIN}. Install poppler-utils (e.g. apt install poppler-utils).`,
    );
  }

  // --- Create temp dir for output ---
  const tmpDir = await mkdtemp(join(tmpdir(), 'gbrain-crop-'));
  const outPrefix = join(tmpDir, 'crop');
  const outFile = `${outPrefix}.png`;

  try {
    const { stderr } = await execFileAsync(PDFTOPPM_BIN, [
      '-png',
      '-r', String(dpi),
      '-f', String(page),
      '-l', String(page),
      '-x', String(x),
      '-y', String(y),
      '-W', String(w),
      '-H', String(h),
      '-singlefile',
      pdfPath,
      outPrefix,
    ]).catch((err: NodeJS.ErrnoException & { stderr?: string }) => {
      const detail = err.stderr?.trim() || err.message;
      if (detail.includes('No such file') || detail.includes("couldn't open")) {
        throw new Error(`cropUnitFromPdf: PDF not found or unreadable: ${pdfPath}\n${detail}`);
      }
      if (detail.includes('firstPage') || detail.includes('lastPage') || detail.includes('invalid page')) {
        throw new Error(`cropUnitFromPdf: page ${page} is out of range for ${pdfPath}\n${detail}`);
      }
      throw new Error(`cropUnitFromPdf: pdftoppm failed for ${pdfPath} page ${page}\n${detail}`);
    });

    // Read output PNG; a missing file means page was out of range
    let png: Buffer;
    try {
      png = await readFile(outFile);
    } catch {
      const stderrHint = typeof stderr === 'string' ? stderr.trim() : '';
      throw new Error(
        `cropUnitFromPdf: pdftoppm produced no output for ${pdfPath} page ${page} — ` +
        `the page number may be out of range.` +
        (stderrHint ? `\nstderr: ${stderrHint}` : ''),
      );
    }

    if (png.length === 0) {
      throw new Error(`cropUnitFromPdf: pdftoppm returned an empty buffer for ${pdfPath} page ${page}`);
    }

    const { width, height } = readPngIhdrDimensions(png);
    return {
      png,
      width,
      height,
      provenance: {
        page,
        bbox,
        pixel_rect,
        dpi,
      },
    };
  } finally {
    await unlink(outFile).catch(() => undefined);
    await rmdir(tmpDir).catch(() => undefined);
  }
}
