# Handoff: User-Logs Meta-Eval (2026-06-20)

Strict, evidence-based meta-evaluation of the AI coaching **prompt builder**, run against the
user's **own** recent arena games (not downloaded high-rated matches).

## Division of labor

- **Part 1 — Antigravity (Gemini):** build a fresh corpus from the user's logs, then generate a
  **real** coaching response for **every** game (full corpus, ~370). Output prompts + responses
  only. **No scoring.**
- **Part 2 — Claude (resumes after Part 1):** read each prompt + response, perform **strict
  log-verified scoring** (trace every coach claim back to exact log timestamps), write
  `scores/NNN.json`, then synthesize a consolidated **issues report** for the user.

Antigravity writes the prompts + responses; Claude reads them and summarizes the issues.

---

## Current state (post-cleanup, 2026-06-20)

- Source logs: **26 files** in `scratch/user-logs/wow/` (already extracted from the two
  `~/Downloads/wow-20260620T085053Z-3-00{1,2}.zip` archives). Span Jun 14–20.
- The prior stale run at `~/.gemini/tmp/wowarenalogs/healer-eval-user/` was **deleted** (it had 374
  prompts built at 05:04 — pre-dating today's M1 refactor + 8 builder commits — plus 50 responses/
  scores in the _lighter_ rubric format). Clean slate.
- New npm script added: `@wowarenalogs/tools` → `start:buildUserPromptCorpus`.
- Untouched: `~/.gemini/tmp/wowarenalogs/healer-eval-data/` (historical 06-18 run, kept for
  reference only).

**Why fresh corpus is mandatory:** the prompt builder changed today — M1 refactor pointing
`printMatchPrompts` at production `buildMatchContext` (commits `78002967`, `1eee4efc`), plus H13/H11
and timeline fixes M-a/M-b/next-spike (up to `ace3e049`). Evaluating old prompts would grade a
builder that no longer exists.

---

## Part 1 — Antigravity

All paths below are under the working dir:
`/Users/mingjianliu/.gemini/tmp/wowarenalogs/healer-eval-user/` (call it `$WORK`).

### 1a. Build the corpus

```bash
cd /Users/mingjianliu/code/wowarenalogs
NODE_OPTIONS=--max-old-space-size=8192 npm run -w @wowarenalogs/tools start:buildUserPromptCorpus
```

- Reads `scratch/user-logs/wow/*.txt`, parses arena matches + Solo Shuffle rounds, keeps only
  combats ≥ 60s that contain a **friendly healer** (the user's perspective), and writes one prompt
  per game.
- Heap flag is required — some logs are up to ~300 MB; default heap OOMs.
- Output: `$WORK/prompts/NNN-Spec-W|L-<logname>-cK.txt` and `$WORK/index.json`.
- `index.json` is an array of `{ ordinal, file, matchId, spec, bracket, result, durationSec }`.
- Expected scale (prior build, as a guide — recompute from the fresh `index.json`): ~370 games
  across Mistweaver, Preservation, Discipline, Resto Shaman, Holy Paladin, Holy Priest, Resto Druid.
- If you re-run, `rm -rf $WORK` first — the builder does not clear stale prompt files.

### 1b. Scope — evaluate EVERY game

**Evaluate the entire corpus** — every entry in `index.json` (~370 games), no sampling. This is a
large run (one real response + one strict verification per game); pace the sub-agents in batches so
you do not exhaust resources, but every ordinal must end up with a response.

### 1c. Generate REAL responses

For **every** game in `index.json`, generate an actual coaching response (spawn a background
sub-agent per game;
you are the coach — no external API, no stub/templated text). Sub-agent prompt:

```
You are a WoW arena coach. Read the match prompt from:
/Users/mingjianliu/.gemini/tmp/wowarenalogs/healer-eval-user/prompts/FILENAME

Produce coaching advice for the healer. Focus on:
- What went wrong or right in this match
- Specific decisions that affected the outcome
- Concrete adjustments for next time

Write ONLY the coaching response (no preamble, no meta-commentary) to:
/Users/mingjianliu/.gemini/tmp/wowarenalogs/healer-eval-user/responses/NNN.txt
where NNN is the zero-padded 3-digit ordinal from the index entry. Create responses/ if needed.
```

`FILENAME` = the entry's `file` field (basename under `prompts/`); `NNN` = its `ordinal`,
zero-padded to 3 digits.

### 1d. Before handing back — verify file mapping

The prior run had a **063/064 file-swap bug**. Confirm: for every ordinal `NNN` in `index.json`,
`responses/NNN.txt` exists, is non-empty, and corresponds to the same ordinal's prompt. Report the
count of responses written (should equal the corpus size) and any ordinals skipped.

**Do not** write `scores/` or any report — that's Part 2.

---

## Part 2 — Claude (resume signal: "responses are ready")

For each game with both a prompt and a `responses/NNN.txt`, apply the **strict meta-eval format**.
Write `$WORK/scores/NNN.json`:

```json
{
  "ordinal": 1,
  "matchId": "...",
  "spec": "...",
  "result": "Win|Loss",
  "verification": {
    "coachClaim": "Exact quote / major claim from the response.",
    "coachReasoning": "How the coach arrived at it from the prompt's layout.",
    "logEvidence": "Exact timestamp + event in the prompt that proves or disproves it.",
    "isAccurate": true
  },
  "prompt": {
    "labelBias": "1-5 + the EXACT label/framing that biased (if any)",
    "noise": "1-5 + the EXACT line/spam pattern",
    "sufficiency": "1-5 + the EXACT missing event type/context"
  },
  "response": {
    "accuracy": "1-5",
    "exactProblem": "If inaccurate, the EXACT discrepancy vs the raw log.",
    "misleadingInfo": "Hallucinations / factual bugs.",
    "noisyInfo": "Exact prompt info that confused the AI.",
    "usefulInfo": "Exact prompt info that was most useful.",
    "promptStructureSuggestions": "Concrete, non-heuristic structural fixes."
  }
}
```

Rules (non-negotiable): no approximations; every claim cross-referenced against an exact prompt
timestamp; name the **exact** problem, never "model hallucinated."

Then write the consolidated report (present it to the user directly):

1. **Exact issues, merged by topic** — group `exactProblem` / `misleadingInfo` /
   `promptStructureSuggestions` by underlying cause.
2. **Evidence & related matches** — under each issue, cite the exact ordinals/matchIds and their
   `logEvidence` / `exactProblem`.
3. **Regression watchlist** (did today's fixes hold?): check each prior-handoff issue —
   actor attribution (team-wide stats mis-credited to the player), inline `| trinket: used` vs the
   real `[TRINKET]`/`[CC BREAK]` timestamp, `Cleanse → 3` identity notation, `[RES] rdy:Δ` resource
   noise / "phantom cast" hallucinations, dispel-summary mislabeling, untracked interrupts
   (Quell/Kick), inactivity-timer "logging while dead", dampening danger-scaling. Flag any that
   recur or regressed. See `HANDOFF-2026-06-18-META-EVAL.md` for the originals.

---

## Gotchas

- **Heap:** always run the builder with `NODE_OPTIONS=--max-old-space-size=8192`.
- **Fresh only:** do not reuse any pre-existing prompts — the corpus must come from this run.
- **Real responses:** Part 1 must contain genuine coaching, not stubs; verification depends on it.
- **Ordinal integrity:** `responses/NNN.txt` must match prompt ordinal `NNN` exactly (063/064 bug).
- **Full coverage:** every ordinal in `index.json` gets a response in Part 1 and a score in Part 2 —
  no sampling. Part 2 scores exactly the set of ordinals present in `index.json`.
