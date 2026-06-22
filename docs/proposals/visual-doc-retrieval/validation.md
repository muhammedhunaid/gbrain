# Visual document retrieval — layout validation gate

## Running the layout validation gate (T015)

T015 is an env-gated integration test that validates `detectLayout` on a
dense-table page of the RAG paper (arXiv 2005.11401) reproduces the
manual table-separation result from the design spec.

**It is skipped by default** (no API cost in CI). Enable it with
`GBRAIN_VISUAL_E2E=1` plus a local copy of the PDF and a configured API key.

### Command

```bash
GBRAIN_VISUAL_E2E=1 GBRAIN_VISUAL_E2E_PDF=/path/to/rag-2005.11401.pdf ANTHROPIC_API_KEY=... \
  bun test test/visual-doc-validation.e2e.test.ts --timeout=120000
```

### Required env vars

| Variable | Description |
|---|---|
| `GBRAIN_VISUAL_E2E` | Must be `1` to enable the suite (any other value skips it). |
| `GBRAIN_VISUAL_E2E_PDF` | Absolute path to the RAG paper PDF on the local filesystem. The file must be readable. |
| `ANTHROPIC_API_KEY` | Anthropic API key — used by the gateway for the vision model call. |

### Optional env vars

| Variable | Default | Description |
|---|---|---|
| `GBRAIN_VISUAL_E2E_PAGE` | `6` | 1-based page number to analyze (page 6 is the dense-table page). |
| `GBRAIN_VISUAL_E2E_LAYOUT_MODEL` | gateway default | Model override passed to `detectLayout`. |

### Expected outcome

The test passes when `detectLayout` on page 6 returns:

1. **≥ 2 regions of type `table`** — both tables on the dense-table page are detected.
2. **Spatial separation** — at least one pair of table regions does not overlap
   vertically (one table's `y1 ≤` the other's `y0`, within a 0.005 tolerance).
   This reproduces the sibling-table separation that the design requires.
3. **Normalized bboxes** — every region's `bbox` coordinates are in `[0, 1]` with
   `x0 < x1` and `y0 < y1`.

A concise summary (region count, types, bboxes, confidence) is printed to stdout
so a human running the gate can review the result directly.

### Cost

One vision model call per run. At claude-3-5-sonnet pricing this is typically
well under $0.01.
