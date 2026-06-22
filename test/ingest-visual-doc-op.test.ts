/**
 * Tests for the `ingest_visual_doc` operation (T012):
 *   - dryRun guard
 *   - remote/trust guard (fail-closed)
 *   - missing path guard
 *   - happy-path enqueues a job named 'ingest_visual_doc' with the expected payload
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName, OperationError, type OperationContext } from '../src/core/operations.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

const ingest_visual_doc = operationsByName['ingest_visual_doc'];
if (!ingest_visual_doc) {
  throw new Error('ingest_visual_doc op missing from operations registry — test fixture invalid');
}

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  // Restore version row so MinionQueue.ensureSchema() sees the migrated state.
  await engine.setConfig('version', '85');
});

function makeCtx(over: Partial<OperationContext> = {}): OperationContext {
  return {
    engine,
    config: {} as OperationContext['config'],
    logger: { info() {}, warn() {}, error() {}, debug() {} } as unknown as OperationContext['logger'],
    dryRun: false,
    remote: false,
    ...over,
  } as OperationContext;
}

describe('ingest_visual_doc op', () => {
  describe('op surface', () => {
    test('exists and is admin-scoped with mutating=true', () => {
      expect(ingest_visual_doc).toBeDefined();
      expect(ingest_visual_doc.scope).toBe('admin');
      expect(ingest_visual_doc.mutating).toBe(true);
    });

    test('declares required path param', () => {
      expect(ingest_visual_doc.params.path).toBeDefined();
      expect((ingest_visual_doc.params.path as { required?: boolean }).required).toBe(true);
    });
  });

  describe('dryRun guard', () => {
    test('dryRun=true returns dry_run object without enqueuing', async () => {
      const ctx = makeCtx({ dryRun: true, remote: false });
      const result = (await ingest_visual_doc.handler(ctx, { path: '/tmp/test.pdf' })) as Record<string, unknown>;
      expect(result.dry_run).toBe(true);
      expect(result.action).toBe('ingest_visual_doc');
      expect(result.path).toBe('/tmp/test.pdf');

      // No job should have been enqueued
      const rows = await engine.executeRaw<{ count: string }>(
        `SELECT count(*)::text AS count FROM minion_jobs WHERE name = 'ingest_visual_doc'`,
      );
      expect(rows[0].count).toBe('0');
    });
  });

  describe('trust guard (fail-closed)', () => {
    test('remote=true → throws permission_denied', async () => {
      const ctx = makeCtx({ remote: true });
      await expect(
        ingest_visual_doc.handler(ctx, { path: '/tmp/test.pdf' }),
      ).rejects.toBeInstanceOf(OperationError);

      try {
        await ingest_visual_doc.handler(ctx, { path: '/tmp/test.pdf' });
      } catch (e) {
        expect((e as OperationError).code).toBe('permission_denied');
      }
    });

    test('remote=undefined → throws permission_denied', async () => {
      const ctx = makeCtx({ remote: undefined as unknown as boolean });
      await expect(
        ingest_visual_doc.handler(ctx, { path: '/tmp/test.pdf' }),
      ).rejects.toBeInstanceOf(OperationError);
    });
  });

  describe('path validation', () => {
    test('missing path → throws invalid_request', async () => {
      const ctx = makeCtx({ remote: false });
      await expect(
        ingest_visual_doc.handler(ctx, {}),
      ).rejects.toBeInstanceOf(OperationError);

      try {
        await ingest_visual_doc.handler(ctx, {});
      } catch (e) {
        expect((e as OperationError).code).toBe('invalid_request');
      }
    });

    test('empty string path → throws invalid_request', async () => {
      const ctx = makeCtx({ remote: false });
      await expect(
        ingest_visual_doc.handler(ctx, { path: '   ' }),
      ).rejects.toBeInstanceOf(OperationError);
    });
  });

  describe('happy-path enqueue', () => {
    test('trusted local call enqueues job named ingest_visual_doc with correct data', async () => {
      const ctx = makeCtx({ remote: false, sourceId: 'my-source' });
      const result = (await ingest_visual_doc.handler(ctx, {
        path: '/tmp/paper.pdf',
      })) as { job_id: number; status: string };

      expect(typeof result.job_id).toBe('number');
      expect(result.job_id).toBeGreaterThan(0);
      expect(result.status).toBe('waiting');

      // Verify the job was persisted with the right shape.
      const rows = await engine.executeRaw<Record<string, unknown>>(
        `SELECT name, status, data FROM minion_jobs WHERE id = $1`,
        [result.job_id],
      );
      expect(rows.length).toBe(1);
      expect(rows[0].name).toBe('ingest_visual_doc');
      expect(rows[0].status).toBe('waiting');

      const data = typeof rows[0].data === 'string'
        ? JSON.parse(rows[0].data as string)
        : (rows[0].data as Record<string, unknown>);
      expect(data.filePath).toBe('/tmp/paper.pdf');
      expect(data.sourceId).toBe('my-source');
    });

    test('uses provided source_id over ctx.sourceId', async () => {
      const ctx = makeCtx({ remote: false, sourceId: 'ctx-source' });
      const result = (await ingest_visual_doc.handler(ctx, {
        path: '/tmp/paper.pdf',
        source_id: 'explicit-source',
      })) as { job_id: number; status: string };

      const rows = await engine.executeRaw<Record<string, unknown>>(
        `SELECT data FROM minion_jobs WHERE id = $1`,
        [result.job_id],
      );
      const data = typeof rows[0].data === 'string'
        ? JSON.parse(rows[0].data as string)
        : (rows[0].data as Record<string, unknown>);
      expect(data.sourceId).toBe('explicit-source');
    });

    test('falls back to "default" when no source_id provided and no ctx.sourceId', async () => {
      const ctx = makeCtx({ remote: false });
      const result = (await ingest_visual_doc.handler(ctx, {
        path: '/tmp/paper.pdf',
      })) as { job_id: number; status: string };

      const rows = await engine.executeRaw<Record<string, unknown>>(
        `SELECT data FROM minion_jobs WHERE id = $1`,
        [result.job_id],
      );
      const data = typeof rows[0].data === 'string'
        ? JSON.parse(rows[0].data as string)
        : (rows[0].data as Record<string, unknown>);
      expect(data.sourceId).toBe('default');
    });

    test('passes slug through to job data when provided', async () => {
      const ctx = makeCtx({ remote: false });
      const result = (await ingest_visual_doc.handler(ctx, {
        path: '/tmp/paper.pdf',
        slug: 'inbox/visual/abc123',
      })) as { job_id: number; status: string };

      const rows = await engine.executeRaw<Record<string, unknown>>(
        `SELECT data FROM minion_jobs WHERE id = $1`,
        [result.job_id],
      );
      const data = typeof rows[0].data === 'string'
        ? JSON.parse(rows[0].data as string)
        : (rows[0].data as Record<string, unknown>);
      expect(data.slug).toBe('inbox/visual/abc123');
    });
  });
});
