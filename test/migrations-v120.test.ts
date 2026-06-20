import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MIGRATIONS, LATEST_VERSION } from '../src/core/migrate.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

// PR2 visual-doc-foundation: units table (T004 + T005)
//
// Pinned contracts:
// 1. Migration v120 exists with name 'units_table'.
// 2. Migration v121 exists with name 'units_embedding_hnsw'.
// 3. LATEST_VERSION >= 121.
// 4. 'units' table is created and queryable after initSchema().
// 5. Expected columns present with correct nullability.
// 6. Scalar indexes (document_id, type, reading_order) all created.
// 7. document_id FK references pages(id) ON DELETE CASCADE.
// 8. type CHECK constraint rejects invalid values.
// 9. HNSW index idx_units_embedding_hnsw created on the embedding column.

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

describe('PR2 T004: units_table migration v120', () => {
  test('v120 exists in MIGRATIONS with canonical name', () => {
    const v120 = MIGRATIONS.find(m => m.version === 120);
    expect(v120).toBeDefined();
    expect(v120?.name).toBe('units_table');
  });

  test('v121 exists in MIGRATIONS with canonical name', () => {
    const v121 = MIGRATIONS.find(m => m.version === 121);
    expect(v121).toBeDefined();
    expect(v121?.name).toBe('units_embedding_hnsw');
  });

  test('LATEST_VERSION >= 121', () => {
    expect(LATEST_VERSION).toBeGreaterThanOrEqual(121);
  });

  test('units table is created and queryable after initSchema()', async () => {
    const rows = await engine.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM units`
    );
    expect(rows[0].count).toBe(0);
  });

  test('units table has expected columns with expected nullability', async () => {
    const cols = await engine.executeRaw<{ column_name: string; data_type: string; is_nullable: string }>(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_name = 'units'
        ORDER BY ordinal_position`
    );
    const byName = Object.fromEntries(cols.map(c => [c.column_name, c]));
    const colNames = Object.keys(byName).sort();
    expect(colNames).toContain('id');
    expect(colNames).toContain('document_id');
    expect(colNames).toContain('type');
    expect(colNames).toContain('page_numbers');
    expect(colNames).toContain('bbox');
    expect(colNames).toContain('reading_order');
    expect(colNames).toContain('provenance');
    expect(colNames).toContain('confidence');
    expect(colNames).toContain('embedding');
    expect(colNames).toContain('source_image_ref');
    expect(colNames).toContain('created_at');
    expect(colNames).toContain('updated_at');

    // NOT NULL columns
    expect(byName.document_id.is_nullable).toBe('NO');
    expect(byName.type.is_nullable).toBe('NO');
    expect(byName.created_at.is_nullable).toBe('NO');
    expect(byName.updated_at.is_nullable).toBe('NO');

    // Nullable columns
    expect(byName.page_numbers.is_nullable).toBe('YES');
    expect(byName.bbox.is_nullable).toBe('YES');
    expect(byName.reading_order.is_nullable).toBe('YES');
    expect(byName.provenance.is_nullable).toBe('YES');
    expect(byName.confidence.is_nullable).toBe('YES');
    expect(byName.embedding.is_nullable).toBe('YES');
    expect(byName.source_image_ref.is_nullable).toBe('YES');
  });

  test('scalar index idx_units_document_id is created', async () => {
    const rows = await engine.executeRaw<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE tablename = 'units'
          AND indexname = 'idx_units_document_id'`
    );
    expect(rows.length).toBe(1);
  });

  test('scalar index idx_units_type is created', async () => {
    const rows = await engine.executeRaw<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE tablename = 'units'
          AND indexname = 'idx_units_type'`
    );
    expect(rows.length).toBe(1);
  });

  test('composite index idx_units_reading_order is created', async () => {
    const rows = await engine.executeRaw<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE tablename = 'units'
          AND indexname = 'idx_units_reading_order'`
    );
    expect(rows.length).toBe(1);
  });

  test('HNSW index idx_units_embedding_hnsw is created', async () => {
    const rows = await engine.executeRaw<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE tablename = 'units'
          AND indexname = 'idx_units_embedding_hnsw'`
    );
    expect(rows.length).toBe(1);
  });

  test('document_id FK ON DELETE CASCADE removes units when page is deleted', async () => {
    await engine.putPage('test/units-cascade', {
      title: 'cascade page',
      type: 'note',
      compiled_truth: '',
      frontmatter: {},
      timeline: '',
    });
    const pageRow = await engine.executeRaw<{ id: number }>(
      `SELECT id FROM pages WHERE slug = 'test/units-cascade' LIMIT 1`
    );
    const pageId = pageRow[0].id;

    await engine.executeRaw(
      `INSERT INTO units (document_id, type) VALUES ($1, 'text')`,
      [pageId]
    );
    expect(
      (await engine.executeRaw<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM units WHERE document_id = $1`,
        [pageId]
      ))[0].count
    ).toBe(1);

    await engine.executeRaw(`DELETE FROM pages WHERE id = $1`, [pageId]);
    expect(
      (await engine.executeRaw<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM units WHERE document_id = $1`,
        [pageId]
      ))[0].count
    ).toBe(0);
  });

  test('type CHECK constraint rejects invalid values', async () => {
    await engine.putPage('test/units-check', {
      title: 'check page',
      type: 'note',
      compiled_truth: '',
      frontmatter: {},
      timeline: '',
    });
    const pageRow = await engine.executeRaw<{ id: number }>(
      `SELECT id FROM pages WHERE slug = 'test/units-check' LIMIT 1`
    );
    const pageId = pageRow[0].id;

    let threw = false;
    try {
      await engine.executeRaw(
        `INSERT INTO units (document_id, type) VALUES ($1, 'invalid_type')`,
        [pageId]
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  test('type CHECK constraint allows all valid values', async () => {
    await engine.putPage('test/units-valid-types', {
      title: 'valid types page',
      type: 'note',
      compiled_truth: '',
      frontmatter: {},
      timeline: '',
    });
    const pageRow = await engine.executeRaw<{ id: number }>(
      `SELECT id FROM pages WHERE slug = 'test/units-valid-types' LIMIT 1`
    );
    const pageId = pageRow[0].id;

    const validTypes = ['table', 'figure', 'chart', 'text', 'caption', 'section'];
    for (const t of validTypes) {
      await engine.executeRaw(
        `INSERT INTO units (document_id, type) VALUES ($1, $2)`,
        [pageId, t]
      );
    }
    const rows = await engine.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM units WHERE document_id = $1`,
      [pageId]
    );
    expect(rows[0].count).toBe(validTypes.length);
  });

  test('v120 idempotent flag is set', () => {
    const v120 = MIGRATIONS.find(m => m.version === 120);
    expect(v120?.idempotent).toBe(true);
  });

  test('v121 idempotent flag is set and transaction is false', () => {
    const v121 = MIGRATIONS.find(m => m.version === 121);
    expect(v121?.idempotent).toBe(true);
    expect(v121?.transaction).toBe(false);
  });
});
