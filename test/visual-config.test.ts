/**
 * T003 — visual.* file-plane config keys.
 *
 * Verifies (a) the four visual.* keys are in KNOWN_CONFIG_KEYS and the
 * 'visual.' prefix is in KNOWN_CONFIG_KEY_PREFIXES, and (b) loadConfig()
 * passes a visual block through from the JSON config file unchanged
 * (file-plane round-trip — no DB merge involved).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  KNOWN_CONFIG_KEYS,
  KNOWN_CONFIG_KEY_PREFIXES,
} from '../src/core/config.ts';

// ─── (a) key-registration tests ──────────────────────────────────────────────

describe('KNOWN_CONFIG_KEYS — visual.* registration', () => {
  test('visual.embedding_model is registered', () => {
    expect(KNOWN_CONFIG_KEYS).toContain('visual.embedding_model');
  });

  test('visual.layout_model is registered', () => {
    expect(KNOWN_CONFIG_KEYS).toContain('visual.layout_model');
  });

  test('visual.budget_per_job_usd is registered', () => {
    expect(KNOWN_CONFIG_KEYS).toContain('visual.budget_per_job_usd');
  });

  test('visual.budget_daily_usd is registered', () => {
    expect(KNOWN_CONFIG_KEYS).toContain('visual.budget_daily_usd');
  });

  test('no duplicate entries after adding visual.* keys', () => {
    const set = new Set(KNOWN_CONFIG_KEYS);
    expect(set.size).toBe(KNOWN_CONFIG_KEYS.length);
  });
});

describe('KNOWN_CONFIG_KEY_PREFIXES — visual. registration', () => {
  test("'visual.' prefix is registered", () => {
    expect(KNOWN_CONFIG_KEY_PREFIXES).toContain('visual.');
  });
});

// ─── (b) loadConfig file-plane round-trip ────────────────────────────────────
//
// loadConfig() reads ~/.gbrain/config.json. We override the config dir via
// the GBRAIN_CONFIG_DIR env var (the same escape hatch used by other tests
// that need an isolated config).

describe('loadConfig — visual block round-trips from config file', () => {
  let tmpDir: string;
  let origDir: string | undefined;

  beforeAll(() => {
    // configDir() reads GBRAIN_HOME and appends '.gbrain'.
    // We set GBRAIN_HOME to a temp parent dir so configPath() points to
    // <tmpParent>/.gbrain/config.json — isolated from the real ~/.gbrain.
    const tmpParent = join(tmpdir(), `gbrain-t003-${Date.now()}`);
    tmpDir = join(tmpParent, '.gbrain');
    mkdirSync(tmpDir, { recursive: true });

    const cfg = {
      engine: 'pglite',
      visual: {
        embedding_model: 'voyage:voyage-multimodal-3.5',
        layout_model: 'anthropic:claude-sonnet-4-6',
        budget_per_job_usd: 5,
        budget_daily_usd: 25,
      },
    };
    writeFileSync(join(tmpDir, 'config.json'), JSON.stringify(cfg, null, 2));

    origDir = process.env.GBRAIN_HOME;
    process.env.GBRAIN_HOME = tmpParent;
  });

  afterAll(() => {
    if (origDir === undefined) {
      delete process.env.GBRAIN_HOME;
    } else {
      process.env.GBRAIN_HOME = origDir;
    }
    // tmpDir is <tmpParent>/.gbrain; remove the parent
    rmSync(join(tmpDir, '..'), { recursive: true, force: true });
  });

  test('visual block is present after loadConfig()', async () => {
    // Dynamic import so the env var is already set when config.ts initialises
    // its paths. We re-import each time to get a fresh read.
    const { loadConfig } = await import('../src/core/config.ts');
    const cfg = loadConfig();
    expect(cfg?.visual).toBeDefined();
  });

  test('visual.embedding_model round-trips', async () => {
    const { loadConfig } = await import('../src/core/config.ts');
    const cfg = loadConfig();
    expect(cfg?.visual?.embedding_model).toBe('voyage:voyage-multimodal-3.5');
  });

  test('visual.layout_model round-trips', async () => {
    const { loadConfig } = await import('../src/core/config.ts');
    const cfg = loadConfig();
    expect(cfg?.visual?.layout_model).toBe('anthropic:claude-sonnet-4-6');
  });

  test('visual.budget_per_job_usd round-trips', async () => {
    const { loadConfig } = await import('../src/core/config.ts');
    const cfg = loadConfig();
    expect(cfg?.visual?.budget_per_job_usd).toBe(5);
  });

  test('visual.budget_daily_usd round-trips', async () => {
    const { loadConfig } = await import('../src/core/config.ts');
    const cfg = loadConfig();
    expect(cfg?.visual?.budget_daily_usd).toBe(25);
  });

  test('visual block absent when not in config file', async () => {
    // Write a config with NO visual key to verify the field stays undefined
    writeFileSync(
      join(tmpDir, 'config.json'),
      JSON.stringify({ engine: 'pglite' }, null, 2),
    );
    const { loadConfig } = await import('../src/core/config.ts');
    const cfg = loadConfig();
    expect(cfg?.visual).toBeUndefined();
  });
});
