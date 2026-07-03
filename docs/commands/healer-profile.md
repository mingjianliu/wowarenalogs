---
name: healer-profile
description: Use when the user asks "what should I work on", "coach me from my games", or wants their per-spec playing profile refreshed — builds the profile from the corpus and synthesizes prioritized, caveat-aware coaching advice.
---

Regenerate the user's per-spec healer profile from their log corpus and synthesize coaching advice.
This is the one-command version of the 2026-07-03 "coach me from my 1000 games" session.

## Pipeline

1. **Profile + percentiles** — `packages/tools/src/buildHealerProfile.ts` (then `buildProfileHtml.ts`
   for the dashboard). Outputs one JSON per spec to `scratch/healer-profile/profiles/` with
   `metrics` (percentiles vs the pro cohort), `suggestions`, `failureModes`. Inputs: the corpus index
   at `~/.gemini/tmp/wowarenalogs/healer-eval-user/index.json` + `reference_vectors.json`.
2. **F40 recurring mistakes** — role-play the production coach (sub-agents, per CLAUDE.md's
   Anthropic-API-key bypass) on ~6 loss-weighted games per spec; extract per-spec recurring CAUSAL
   mistakes with cited games. Prior art + output shape: `scratch/healer-profile/F40-RECURRING-MISTAKES-2026-07-02.md`.
3. **Synthesize** the report for the user (see Report format below).

## Known caveats — bake these into any advice (hard-won, do not re-learn)

- **Offensive Index is pressure-confounded (B151)**: OI = damage/healing; the denominator scales with
  team damage taken. Quartile the user's games by team-DTPS before citing OI percentiles — in Q1
  low-pressure games the user's MW OI already matches the pro median. The habit signal that survives:
  own-DPS stays flat across pressure quartiles (free GCDs are not converted to damage).
- **Proactive-CD rate over-counts pre-CC insurance (B146)**: ~37% of "early" Healing Tide and 33% of
  Chi-Ji casts are followed ≤5s by hard CC on the caster — insurance, not waste. Divine Hymn shows 0%
  (that finding stands). Discount accordingly until the profile counter excludes pre-CC casts.
- **Utility casts have non-HP value (F173)**: 21% of Rescues break a root ≤1.5s; never call a utility
  cast wasted on HP grounds alone.
- **Chain Heal on Shaman is hardcast** (~16/game with CAST_START), not totem-proc'd — self-targeting is
  likely a no-target UI fallback → coach a mouseover/focus macro, don't accuse intent.
- **Translate spell names carefully** in zh output (e.g. Pain Suppression = 痛苦压制, NOT 真言术:障) —
  only name tools that exist in the player's current toolkit.
- If a finding feels wrong to the user, **verify it via `corpus-audit.md` before defending it** —
  pushbacks have been right about the model twice and wrong once; the audit settles it either way.

## Report format that worked

1. One cross-spec root cause with the number that proves it (e.g. proactive-CD rate per spec).
2. Percentile table vs pros — flag strengths explicitly (CC avoidance p75–p93 is elite; keep).
3. One prescription per spec, ordered by the user's games played, each citing a real game.
4. A practice plan: ONE habit per 1–2 weeks, highest-leverage first.
5. Confidence labels: separate findings that survived audits from ones resting on HP-only cost/benefit.

## Refresh triggers

- New batch of games imported into the corpus
- After coaching-pipeline accuracy fixes (profiles inherit them only after a rebuild)
- Season rollover (rebuild AFTER `season-refresh.md` so cohort/benchmarks are current)
