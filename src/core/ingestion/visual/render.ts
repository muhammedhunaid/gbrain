/**
 * Deterministic PDF page-to-PNG render helper.
 *
 * Renders a single PDF page to a PNG raster using pdftoppm (poppler).
 * The output feeds multimodal embedding and vision layout-detection, so
 * determinism and stable pixel dimensions are the primary contract.
 *
 * DPI choice — 200:
 *   - At 72 DPI (1× PDF point) text is often too small for vision models.
 *   - At 300 DPI images are ~2× larger than needed and slow to embed.
 *   - 200 DPI is the de-facto standard for document-understanding tasks:
 *     it hits OCR sweet-spot quality (empirically confirmed in docTR, Donut,
 *     and Tesseract literature) while keeping file sizes manageable (~250 KB
 *     for a letter page vs ~550 KB at 300). It also yields round pixel counts
 *     for standard page sizes (letter 612×792 pt → 1700×2200 px).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, unlink, stat, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

export const PDFTOPPM_BIN = '/usr/bin/pdftoppm';

/** Pinned default DPI. See module doc comment for rationale. */
const DEFAULT_DPI = 200;

export interface RenderedPage {
  /** Raw PNG bytes. First 8 bytes are always the PNG signature. */
  png: Buffer;
  /** Pixel width of the rendered page. */
  width: number;
  /** Pixel height of the rendered page. */
  height: number;
}

/**
 * Render a single PDF page to a PNG raster.
 *
 * Uses pdftoppm from poppler-utils. Output is deterministic for the same
 * (pdfPath, page, dpi) triple: pixel dimensions are always identical;
 * raw bytes are also identical unless pdftoppm embeds a tIME chunk
 * (some builds do, some don't — dimensions are the stable contract).
 *
 * @throws Error if pdftoppm is missing, the file doesn't exist, the page
 *   is out of range, or pdftoppm exits non-zero for any other reason.
 */
export async function renderPdfPageToPng(opts: {
  pdfPath: string;
  /** 1-based page number to render. */
  page: number;
  /** Dots-per-inch. Defaults to 200 (see module doc). */
  dpi?: number;
}): Promise<RenderedPage> {
  const { pdfPath, page } = opts;
  const dpi = opts.dpi ?? DEFAULT_DPI;

  // Check pdftoppm availability
  try {
    await stat(PDFTOPPM_BIN);
  } catch {
    throw new Error(
      `pdftoppm not found at ${PDFTOPPM_BIN}. Install poppler-utils (e.g. apt install poppler-utils).`,
    );
  }

  // Create a unique temp directory so concurrent calls never collide
  const tmpDir = await mkdtemp(join(tmpdir(), 'gbrain-render-'));
  const outPrefix = join(tmpDir, 'page');
  const outFile = `${outPrefix}.png`;

  try {
    const { stderr } = await execFileAsync(PDFTOPPM_BIN, [
      '-png',
      '-r', String(dpi),
      '-f', String(page),
      '-l', String(page),
      '-singlefile',
      pdfPath,
      outPrefix,
    ]).catch((err: NodeJS.ErrnoException & { stderr?: string }) => {
      // pdftoppm writes errors to stderr and exits non-zero.
      const detail = err.stderr?.trim() || err.message;
      if (detail.includes('No such file') || detail.includes('couldn\'t open')) {
        throw new Error(`renderPdfPageToPng: PDF not found or unreadable: ${pdfPath}\n${detail}`);
      }
      if (detail.includes('firstPage') || detail.includes('lastPage') || detail.includes('invalid page')) {
        throw new Error(`renderPdfPageToPng: page ${page} is out of range for ${pdfPath}\n${detail}`);
      }
      throw new Error(`renderPdfPageToPng: pdftoppm failed for ${pdfPath} page ${page}\n${detail}`);
    });

    // Read the output PNG; if missing the page was out of range (pdftoppm exits 0
    // but produces no file when the requested page doesn't exist)
    let png: Buffer;
    try {
      png = await readFile(outFile);
    } catch {
      const stderrHint = typeof stderr === 'string' ? stderr.trim() : '';
      throw new Error(
        `renderPdfPageToPng: pdftoppm produced no output for ${pdfPath} page ${page} — ` +
        `the page number may be out of range.` +
        (stderrHint ? `\nstderr: ${stderrHint}` : ''),
      );
    }

    const { width, height } = readPngIhdrDimensions(png);
    return { png, width, height };
  } finally {
    // Best-effort cleanup; ignore errors (file may not exist if pdftoppm failed early)
    await unlink(outFile).catch(() => undefined);
    // Remove tmpDir (it's now empty)
    await rmdir(tmpDir).catch(() => undefined);
  }
}

/**
 * Read pixel dimensions from a PNG IHDR chunk.
 *
 * PNG structure (relevant bytes):
 *   [0-7]   PNG signature: 89 50 4e 47 0d 0a 1a 0a
 *   [8-11]  IHDR chunk length (always 13 = 0x0000000d)
 *   [12-15] IHDR chunk type: "IHDR"
 *   [16-19] width  (big-endian uint32)
 *   [20-23] height (big-endian uint32)
 *
 * This is dependency-free and requires no external library.
 */
export function readPngIhdrDimensions(buf: Buffer): { width: number; height: number } {
  if (buf.length < 24) {
    throw new Error('renderPdfPageToPng: PNG output is too small to contain an IHDR chunk');
  }
  // Verify PNG signature
  const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== PNG_SIG[i]) {
      throw new Error('renderPdfPageToPng: output does not start with PNG signature');
    }
  }
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return { width, height };
}
