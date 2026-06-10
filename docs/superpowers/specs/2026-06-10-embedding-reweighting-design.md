# Design Spec: Embedding Reweighting & Exact Vocabulary

**Date:** 2026-06-10
**Bundles findings:** F5 (block weighting), F6 (scalar standardization), F8 (exact vocabulary),
F9 (dead dimensions), F10 (IDF smoothing) — from
[2026-06-10-vector-analysis-review.md](2026-06-10-vector-analysis-review.md).
**Out of scope:** F1/F2 (production wiring), F11 (dot-product micro-opt), F14 (matchId+spec keying).

## Problem

The match embedding (`vectorIndexer.ts`) concatenates three blocks — talent binary, rotation
TF-IDF, behavioral scalars — and L2-normalizes the whole vector. Three defects:

1. **Talent block dominates (F5).** ~30–45 talent bits = `1` own most of the magnitude; rotation
   TF-IDF values are tiny fractions, so the "same rotational style" pitch contributes almost nothing
   to neighbor selection. Because the single L2 factor depends on talent count, the same raw scalar
   maps to different post-norm values across matches — behavioral scalars aren't comparable in cosine
   space.
2. **Scalars unstandardized (F6).** `reactionLatency` (seconds, ~1.5) vs 0–1 ratios — mixed scales;
   within the scalar sub-block, latency dominates.
3. **Hash collisions + dead dims (F8/F9).** Sequences hash into 200 buckets (weak additive hash,
   unrelated sequences collide); talents into 300 buckets (birthday collisions). `VECTOR_DIMENSIONS`
   is a fixed 516 with dims 506–515 permanently zero.

The F13 audit established which behavioral scalars carry signal: keep `offensiveIndex` + `ccDensity`;
`reactionLatency` is usable but 58% sentinel-defaulted; `effectiveCastRatio` / `defensiveOverlapRatio`
/ `ccAvoidanceRate` are near-dead.

## Goals

- Similarity = a controllable **weighted average of per-block similarities**, independent of how many
  talents/sequences a match has.
- Behavioral scalars genuinely influence neighbor selection, standardized and comparable.
- Rotation/talent blocks are collision-free and interpretable.
- A fresh match vectorizes into the exact same space (live path preserved).

## Design decisions (from brainstorming)

| Decision                   | Choice                                                               |
| :------------------------- | :------------------------------------------------------------------- |
| Similarity basis           | Holistic: build + rotation + behavior all in the embedding           |
| Behavioral metrics encoded | `offensiveIndex`, `ccDensity`, `reactionLatency` (drop the 3 dead)   |
| Block weights              | Equal thirds: talent ⅓, rotation ⅓, behavior ⅓                       |
| Behavior block combination | Direction-normalized (L2 the 3 z-scored dims → shape, not magnitude) |
| Vocabulary                 | Exact `sequence→index` / `talentId→index` (F8)                       |
| Latency sentinel           | Exclude `reactionLatency === 1.5` from norm stats; absent → `z = 0`  |

## Architecture

### Vector construction

Each block is built, **L2-normalized to a unit sub-vector**, scaled by `√(weight)`, concatenated,
then the full vector is L2-normalized once more (robust to an empty block):

```
embedding = L2( [ √w_t · talentUnit | √w_r · rotationUnit | √w_b · behaviorUnit ] )
            w_t = w_r = w_b = 1/3
```

With unit blocks and weights summing to 1, `cosine(A,B) = Σ_block w · cos_block(A,B)` — the desired
weighted average. The final L2 makes a match with a zero block (e.g. behavior exactly at the mean,
or no talents) renormalize over its present blocks rather than shrinking.

- **Talent block** — length `|talentVocab|`; `1.0` at `talentVocab[id]` for each owned talent; L2.
- **Rotation block** — length `|sequenceVocab|`; value = smoothed TF-IDF at `sequenceVocab[seq]`; L2.
- **Behavior block** — length 3: `[z(offensiveIndex), z(ccDensity), z(reactionLatency)]`; L2.
  If the block is all-zero (player at the mean, or latency absent and others at mean), it stays zero
  and the final L2 redistributes weight to the other blocks.

Total dimensions: `|talentVocab| + |sequenceVocab| + 3` (exact; resolves F9). Dimension count is no
longer a hardcoded constant — it is derived from the vocab and recorded in the model artifact.

### Behavioral standardization (F6)

- Corpus mean/std per metric computed once (pass 1), persisted as `behaviorNormParams`.
- `reactionLatency`: the `1.5` sentinel means "no crisis happened," not a reaction time. Exclude
  sentinels from the mean/std; a match whose `reactionLatency === 1.5` (or absent) gets `z = 0` for
  that dimension. (Heuristic on the exact sentinel value — clean without re-enriching the corpus. A
  fully-clean variant would change `healerMetrics` to return `null`; deferred.)
- `z(x) = std > 0 ? (x - mean) / std : 0`.

### IDF smoothing (F10)

`computeTfIdf` uses `idf = log((1 + N) / (1 + df)) + 1` (always ≥ ~0; never negative for ubiquitous
sequences). Per-block L2 normalizes absolute scale, so this mainly removes the negative-weight
pathology for very common sequences.

### Persisted model artifact

Consolidate everything needed to vectorize a fresh match into one **`reference_model.json`**
(supersedes `reference_idf.json` from F4 — same session, not yet relied upon downstream):

```jsonc
{
  "totalDocs": 1390,
  "sequenceDocFrequency": { "<seq>": <df>, ... },
  "sequenceVocab":        { "<seq>": <index>, ... },
  "talentVocab":          { "<talentId>": <index>, ... },
  "behaviorNormParams":   { "offensiveIndex": {"mean":_, "std":_}, "ccDensity": {...}, "reactionLatency": {...} },
  "blockWeights":         { "talent": 0.3333, "rotation": 0.3333, "behavior": 0.3333 },
  "dims":                 { "talent": _, "rotation": _, "behavior": 3, "total": _ }
}
```

`vectorizeMatch(raw, model)` is the single live entry point; the corpus builder uses the same model.

## Components & changes

| File                                            | Change                                                                                                                                                                                                                                                     |
| :---------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/cloud/src/vectorIndexer.ts`           | Rewrite `generateMatchVector` for 3-block construction; add `IReferenceModel`, vocab/normParams builders; `vectorizeMatch(raw, model)`. Remove `VECTOR_DIMENSIONS` constant + hashing.                                                                     |
| `packages/shared/src/utils/vectorMath.ts`       | Smoothed IDF (F10); add `weightedConcat(blocks, weights)` helper (per-block L2 + √w scale + final L2).                                                                                                                                                     |
| `packages/tools/src/processAndUploadVectors.ts` | Two passes: (1) build `sequenceVocab`, `talentVocab`, `sequenceDocFrequency`, `behaviorNormParams` (excluding latency sentinels); (2) vectorize all matches. Write `reference_model.json` + `reference_vectors.json`. Keep `metrics: null` flagging (F15). |
| `packages/cloud/src/vectorSearch.ts`            | Unchanged — still cosine over stored embeddings; F7 bracket normalization intact.                                                                                                                                                                          |
| `packages/tools/src/buildSoloShuffleCorpus.ts`  | Unchanged.                                                                                                                                                                                                                                                 |

## Data flow

1. **Build (offline):** corpus files → pass 1 (vocab + IDF + behavior norm params) → pass 2
   (`generateMatchVector` per match) → `reference_vectors.json` + `reference_model.json`.
2. **Search:** `findNearestProMatchesLocal(spec, userEmbedding, bracket, k)` — unchanged.
3. **Live (future, F1):** fresh match → `vectorizeMatch(raw, model)` → same space → search.

## Error handling / edge cases

- Empty talent or rotation block → that block is zero; final L2 redistributes weight. (A match with
  no talents is degenerate but won't divide-by-zero.)
- Behavior block all-zero (mean player / latency absent + others at mean) → contributes nothing; the
  match is matched on build + rotation only.
- Unknown sequence/talent at live time (not in vocab) → skip it (out-of-vocabulary terms contribute
  nothing), matching how an unseen hash bucket would have been empty.
- `std === 0` for a metric → `z = 0` (no spurious blow-up).

## Testing

- **Unit (`vectorIndexer.test.ts`):**
  - Dimension count = `|talentVocab| + |sequenceVocab| + 3`.
  - Two matches identical except one extra talent → talent-block cosine drops predictably; rotation
    and behavior cosines unchanged (proves block independence / F5).
  - Equal-weight property: construct A, B with known per-block cosines → overall cosine ≈ mean of the
    three (within tolerance).
  - Latency sentinel: a match with `reactionLatency === 1.5` → behavior dim 3 contributes `z = 0`.
  - Smoothed IDF never negative.
- **Round-trip:** `vectorizeMatch(raw, model)` reproduces the stored embedding exactly (as F4).
- **Validation (manual):** rebuild; for a known build, confirm neighbors are same-build/rotation with
  sensible behavior proximity; diff a few neighbor lists vs. the old index to confirm talent no
  longer dominates.

## Success criteria

- Cosine similarity decomposes as the ⅓/⅓/⅓ weighted average of per-block cosines (unit-tested).
- Behavioral scalars are comparable across matches (z-scored, block-normalized).
- No hash collisions; dimension count derived from vocab; zero dead dims.
- Live round-trip exact; cloud suite green.
- Neighbor quality: rotation and behavior visibly affect neighbor selection (no longer talent-only).
