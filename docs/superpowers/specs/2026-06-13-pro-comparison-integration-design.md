# Pro Comparison (Part II) — Prod Integration Design

**Date:** 2026-06-13
**Status:** Approved, ready for implementation plan
**Goal:** Wire the "Pro comparison" vector comparative-coaching feature into `CombatAIAnalysis` as
**Part II**, working in production for healer matches, without slowing or breaking the existing
Part I (decision-review findings).

Source of the provided code: `~/Downloads/arena.zip` → `reflected-codebase/` (extracted to
`/tmp/arena-integrate`), with `INTEGRATION.md` notes. The zip's two new files are concrete code;
its server section was pseudocode and is superseded by this design.

---

## 1. Problem & Goal

`CombatAIAnalysis` currently shows only Part I (ranked cooldown/decision findings). The vector /
dynamic-archetyping pipeline (embeddings + nearest-pro search + comparative coaching) exists but is
**not wired to prod**. This design adds **Part II · Pro comparison**: for a healer match, embed the
match, find the nearest same-spec/same-bracket pro games in the reference corpus, and render a
metric-gap + crisis-response comparison plus a Claude-written coaching summary.

**In scope:** healer matches; live embedding at request time; a new server endpoint; relocating the
vector code so `web` can use it; shipping the reference index to prod.
**Out of scope:** non-healer matches; caching; streaming; renaming the tab; corpus re-ingestion.

---

## 2. Locked Decisions

| Decision                | Choice                                                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Coverage                | **Live-embed, healers only.** Non-healer matches omit Part II.                                                                             |
| Pipeline location       | **Server re-parses** the raw log (self-contained); client change is minimal.                                                               |
| Delivery                | **Separate `/api/compare` endpoint**, fired in parallel with `/api/analyze`; Part II loads independently with its own loading/empty state. |
| Vector code location    | **Relocate** the pure embedding+search code from `packages/cloud` → `packages/shared` (clean layering; vs. coupling web→cloud).            |
| Reference index in prod | **Bundle** `reference_vectors.json` + `reference_model.json` into the standalone build via `next.config.js` `outputFileTracingIncludes`.   |
| Comparison report       | **2nd Claude call** (Sonnet 4.6, existing client/model) inside `/api/compare`.                                                             |

---

## 3. Architecture & Components

### Relocate (cloud → shared)

Create **`packages/shared/src/utils/vectorSearch.ts`** housing the request-time-needed, pure pieces
currently in `packages/cloud/src/vectorSearch.ts` and `packages/cloud/src/vectorIndexer.ts`:

- `ReferenceVectorRecord`, `NearestMatchResult` types
- `normalizeBracket`
- `findNearestProMatchesLocal`
- `parseMatchEmbeddingData`, `generateMatchVector`
- reference index/model loading (path resolves in dev **and** standalone)

Repoint existing importers (`packages/cloud/src/*`, `packages/tools/src/*` such as
`processAndUploadVectors.ts`, `demoDynamicAnalysis.ts`, `vectorIndexer.ts`) to the new shared module.
`healerMetrics.ts` and `comparativePrompt.ts` already live in shared.

### Extract the playstyle-data transform (the key risk — see §9)

The transform that turns a parsed `AtomicArenaCombat` into the `matchData` (playstyle JSON) shape that
`parseMatchEmbeddingData` consumes currently runs offline in `packages/tools/src/buildHealerPlaystyleCorpus.ts`.
Extract its **single-match** core into shared (e.g. `packages/shared/src/utils/playstyleData.ts`) so
`/api/compare` can build it per request.

### New server endpoint

**`packages/web/pages/api/compare.ts`** — the orchestrator (see §4).

### New client files (provided, copied verbatim into the tree)

- `packages/shared/src/components/CombatReport/CombatAIAnalysis/proComparisonData.ts`
- `packages/shared/src/components/CombatReport/CombatAIAnalysis/components/ProComparison.tsx`

### Client wiring

`packages/shared/src/components/CombatReport/CombatAIAnalysis/index.tsx` — fire `/api/compare`
alongside `/api/analyze`; new `comparison` / `comparisonReport` / `comparisonLoading` state; render
Part II.

---

## 4. `/api/compare` Flow

Request body: `{ matchId: string, apiKey?: string }`. Fully guarded — **returns `{}` on any miss or
failure**, never throws to the client.

1. Resolve `logObjectUrl` from `match-stubs-prod` by `matchId` (reuse the pattern from
   `analysisCapture.ts` / `combatUploadSignatureHandler.ts`). Miss → `{}`.
2. Fetch the raw log (public GCS) and re-parse with `WoWCombatLogParser`; locate the match by id.
3. **Healer gate:** if the log owner's spec is not a healer → `{}`.
4. Build playstyle-data (extracted transform) → `parseMatchEmbeddingData` → `generateMatchVector`
   (using `reference_model.json`).
5. `findNearestProMatchesLocal(spec, embedding, bracket, 6)`, drop the self-match (`n.id === matchId`),
   keep 5. Fewer than 1 neighbor → `{}`.
6. Assemble `ComparativeAnalysisData` with **real** metrics:
   - `userMetrics` from `healerMetrics` on the parsed match
   - `userCrisisEvents` from playstyle-data `rotations.crisisEvents`
   - `nearestNeighbors[]` from `ReferenceVectorRecord.metrics` + `.crisisEvents`
7. `buildComparativePrompt(comparison)` → Claude (Sonnet 4.6) → `comparisonReport` markdown.
8. Return `{ comparison, comparisonReport }`.

`apiKey` is read from the body or `process.env.ANTHROPIC_API_KEY`, mirroring `analyze.ts`; never
persisted.

---

## 5. Contracts

`ComparativeAnalysisData` already exists in `comparativePrompt.ts` and matches the two new client
files exactly (verified): `{ playerName, spec, userMetrics{6}, userCrisisEvents[], nearestNeighbors[
{distance, metrics{6}, crisisEvents[]}] }`.

`/api/compare` response:

```
{ comparison?: ComparativeAnalysisData, comparisonReport?: string }   // {} when unavailable
```

---

## 6. Prod Index Shipping

`reference_vectors.json` (~1390 records) + `reference_model.json` live in `packages/tools/src/data/`.
The shared loader reads them by a path that works in dev. For the standalone web build, add
`outputFileTracingIncludes` in `packages/web/next.config.js` for the `/api/compare` route so both
JSON files are traced into the deployed server. Loader resolves the file location robustly across dev
and standalone layouts.

---

## 7. Client Changes (`index.tsx`)

- Import `ProComparison` (and `ComparativeAnalysisData`).
- In `handleAnalyze`, after firing the existing `/api/analyze` fetch, also fire
  `fetch('/api/compare', { body: { matchId: combatId, apiKey } })` **in parallel** (do not block the
  findings render on it). Track `comparison`, `comparisonReport`, and `comparisonLoading` in state.
- Render Part II after the decision-review grid: a light loading state while `/api/compare` is in
  flight, the `ProComparison` view when `comparison` is present, nothing when it resolves empty.
- Heading rename ("AI match review") is **out** of scope — keep "AI cooldown analysis".

---

## 8. Error Handling

`/api/compare` is fully guarded; each of these returns `{}` (Part II simply omitted): not a healer,
match expired/not found, raw-log fetch/parse failure, no neighbors, embedding failure, Claude failure.
Part I (`/api/analyze`) is fully independent and unchanged. A bounded timeout protects the endpoint
from a hung dependency.

---

## 9. Key Risk & Fallback

**Risk:** the playstyle-data transform (`buildHealerPlaystyleCorpus.ts`) runs offline over the local
corpus. Producing the exact `matchData` shape `parseMatchEmbeddingData` expects, at request time from a
single freshly-parsed combat, is the hardest and least-certain part. If that transform depends on
multi-match/offline context that can't be reconstructed per-request, live-embed is infeasible as-is.

**Mitigation:** the implementation plan spikes this extraction **first**. If it proves offline-bound,
fall back to **corpus-lookup-only** (look the `matchId` up in `reference_vectors.json`; show Part II
only for already-ingested matches; otherwise `{}`). The client and `ComparativeAnalysisData` contract
are identical either way, so the fallback is a server-only change.

---

## 10. Testing

- Relocated pure functions: existing tests keep passing after the move; update import paths.
- `proComparisonData.ts` transforms: `parseCrisisEvent` (the `"At 56.4s (… HP: 36%): A -> B"` format),
  `buildMetricRows` (incl. `dropEmpty`), `deriveArchetype`, `parseCoachingReport` (Global Pacing /
  Crisis Management split), `computeProAverages`, `formatMetric`.
- Playstyle-data extractor: unit test against a known parsed match fixture.
- `/api/compare` orchestration: mock parser/index/Claude; assert it returns `{}` on each miss path and
  never throws; assert real metrics flow through on the happy path.
- Run shared tests via `npx tsdx test`.

---

## 11. Scope Cuts (YAGNI)

Healers only; no comparison caching; no streaming; no heading rename; reuse existing Anthropic
client/model; no corpus re-ingestion.

---

## 12. Open Items for Planning

- Exact `next.config.js` `outputFileTracingIncludes` glob + the shared loader's path resolution for
  dev vs standalone.
- Bounded-timeout value for `/api/compare`.
- Healer-spec detection helper (does one already exist in shared, or add one).
- Whether neighbor `metrics` can ever be `null` in the corpus (handle defensively in the assembler).
