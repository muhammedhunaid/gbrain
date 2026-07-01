# Visual document retrieval — research notes

## Reproducibility & cost (US4)

Re-ingesting the same visual document is deterministic by **content-hash
idempotency-skip**, not by asking the vision LLM to repeat itself. The parent
page stores the PDF's SHA-256 in `frontmatter.content_hash`; a re-ingest whose
hash is unchanged returns `{status:'skipped'}` and leaves the stored units
untouched. Those already-persisted units ARE the frozen output — the layout
detection and embeddings that ran once are what every later query sees.

The concrete models and prompt version are **pinned into each unit's
provenance** (FR-013): `layout_model`, `embed_model`, and `prompt_version`
(`PROMPT_VERSION` from `detect-layout.ts`) are spread into the `provenance`
JSONB at insert time. This makes the audit trail name exactly what produced a
unit, and lets a future re-run detect a model/prompt drift that should force a
rebuild rather than a skip.

Per-job cost is **bounded by `visual.budget_per_job_usd`**. The ingest body runs
inside a `BudgetTracker` scope (`withBudgetTracker`), so the vision calls
(`detectLayout → visionChat → gateway.chat`) auto-record and auto-cap via the
gateway's AsyncLocalStorage. `embedMultimodal` does not auto-record, so the
handler records each embed explicitly (a fixed per-image token estimate against
the multimodal embed price) — the cap therefore spans **vision + embed**
holistically. On exhaustion the handler returns
`{status:'budget_exhausted', spentUsd, budgetCapUsd, units}` and RETAINS the
units persisted so far (partial progress is reported, never silently discarded).
The final `spentUsd` is also reported on the success result and fed to
`job.updateProgress`, and every record/reserve lands in the BudgetTracker audit
JSONL (`~/.gbrain/audit/budget-YYYY-Www.jsonl`).

**Honesty caveats.** Reproducibility holds by skip-and-reuse, not because the
vision LLM is deterministic — a forced rebuild (changed hash) re-runs the model
and may produce different layout units. The per-image embed cost uses a fixed
token estimate because the Voyage multimodal endpoint does not return a
per-call usage count; the cap is therefore approximate at the sub-cent level.
`visual.budget_daily_usd` (a rolling cross-job cap) is **deferred** — today the
budget bound is strictly per-job.
