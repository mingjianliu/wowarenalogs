# WoW Arena Logs — Project Instructions

WoW arena combat logging and analysis platform. Desktop Electron app records local logs; web platform hosts match browsing, analytics, and AI-powered cooldown analysis.

See [docs/repo-overview.md](docs/repo-overview.md) for monorepo structure, core commands, engineering standards, and tech stack.

<engineering_standards>
## Engineering Standards

### Research Boundary
For any task involving an "Audit," "Investigation," "Check," or "Research," the agent MUST:
1.  Complete the requested investigation.
2.  Provide a clear summary of findings and a proposed implementation plan.
3.  **STOP and wait for user approval** before modifying any files or proceeding with implementation.
4.  Do not take "proactive liberties" to fix identified bugs unless the user has issued an explicit **Directive** to implement the fix (e.g., "Fix it," "Go ahead," "Implement that").
</engineering_standards>

<architecture_highlights>
## Architecture Highlights

### Desktop ↔ Web separation
- Desktop behavior is gated on `typeof window.wowarenalogs !== 'undefined'`
- The `app` package's preload script injects `window.wowarenalogs` via Electron IPC
- Web package has zero knowledge of Electron; never import from `app` in `web` or `shared`
- Preload API is auto-generated from `packages/app/src/nativeBridge/modules/`

### Parser
- `WoWCombatLogParser` extends `EventEmitter3` (not Node.js EventEmitter)
- Performance-critical: handles thousands of lines/second; keep it lean

### Data flow
1. Desktop watches `WoWCombatLog.txt` → parser emits match → recorder clips video
2. Client requests signed GCS URL → uploads log buffer
3. Cloud function fires on GCS trigger → parses → writes Firestore stub
4. Web fetches via GraphQL (Apollo Client + Apollo Server Micro at `pages/api/graphql`)
</architecture_highlights>

<ai_analysis_pipeline>
## AI Analysis Pipeline
The AI analysis uses a **Decision-Centric Format** to evaluate matches.

### Key Utilities (`packages/shared/src/utils/`)
- `cooldowns.ts`: Major CD extraction and panic detection.
- `dispelAnalysis.ts`: Talent-aware cleanse/purge analysis.
- `enemyCDs.ts`: Enemy offensive timeline with buff-expiry tracking.
- `killWindowTargetSelection.ts`: Target "softness" scoring.

### Design Principles
1. **Match Arc:** Summarize Early (Start to first CD), Mid (to first death), and Late (Resolution) phases.
2. **Causal Chains:** Link events (Setup → Consequence → Kill) rather than listing independent facts.
3. **Hallucination Guardrails:** Supporting data (dispels, CD timelines) must be present but summarized to avoid diluting attention.
</ai_analysis_pipeline>

<specialized_workflows>
## Specialized Workflows

### 1. Match Analysis
To analyze a local WoW log:
1. Identify the latest log file (usually in `~/Library/Application Support/World of Warcraft/_retail_/Logs/`).
2. Run `npm run -w @wowarenalogs/tools start:printMatchPrompts -- --count 1 --new-prompt --test-prompt --log "<path>"`.
3. Read the output and provide the analysis yourself as the agent.
- **Detailed Reference**: [docs/commands/analyze-arena.md](docs/commands/analyze-arena.md)

### 2. Testing with Logs
Use `packages/parser/test/testlogs/` for development:
- `3v3_tww_1120_reduced.txt`: Best general-purpose 3v3 log.
- `one_solo_shuffle.txt`: Solo shuffle testing.
- Use `--dry-run` with `scripts/testAnalyze.mjs` to verify scoring changes without spending API credits.
- **Detailed Reference**: [docs/commands/test-with-logs.md](docs/commands/test-with-logs.md)

### 3. Calibration (Benchmarks)
Run the benchmark pipeline after major WoW patches to update `PANIC_PRESS_DAMAGE_THRESHOLD_*` in `cooldowns.ts`:
```bash
npm run -w @wowarenalogs/tools start:collectBenchmarks
```
- **Detailed Reference**: [docs/commands/collect-benchmarks.md](docs/commands/collect-benchmarks.md)

### 4. Healer Prompt Improvement
Workflows for evaluating and improving healer-specific AI analysis:
- **Detailed Reference**: [docs/commands/improve-healer-prompts.md](docs/commands/improve-healer-prompts.md), [docs/commands/eval-healer-prompts.md](docs/commands/eval-healer-prompts.md)

### 5. System Prompt A/B Testing
Workflow for testing modifications to AI system prompts with stateful comparisons and LLM Judge evaluation:
- **Detailed Reference**: [docs/prompt-ab-testing-workflow.md](docs/prompt-ab-testing-workflow.md)
- **Anthropic API Key Bypass (For All AIs)**: You do not need an Anthropic API key. You can simply create a new sub-agent and role-play the response AI to verify prompts.
</specialized_workflows>

<subagent_delegation>
## Sub-Agent Delegation
For complex tasks, use specialized agents:
- `invoke_agent(agent_name="codebase_investigator", prompt="Analyze the impact of changing spell ID X in spells.json")`
- `invoke_agent(agent_name="generalist", prompt="Run the full benchmark pipeline and update cooldowns.ts thresholds")`
</subagent_delegation>

<git_workflow>
## Git Workflow
- Always push to `origin` (mingjianliu's fork), never to `upstream`.
- Never create PRs against the upstream repo.

## Git Worktree Workflow (AI Agent Guidelines)
- The project has local Git commands for worktree management:
  - `git start-dev <branch>`: Creates a worktree in `.worktrees/<branch>` and runs `npm install`.
  - `git push-clean`: Run inside a worktree to push to origin.
- Interactive slash commands and natural language triggers are available in Claude, Gemini, and Antigravity:
  - **Start Development**: Triggered by `/start-dev <branch>` or when the user says "develop <branch>". The agent MUST run `git start-dev <branch>` and switch its context to `.worktrees/<branch>/` for subsequent edits.
  - **Commit, Push, and Clean Up**: Triggered by `/push-clean` or when the user says "commit and push" (or implicitly when the task is done). The agent MUST commit changes inside the worktree, run `git push-clean` inside the worktree, and then run `git worktree remove --force .worktrees/<branch>` and `git worktree prune` from the main repository root directory to clean up.
</git_workflow>

<documentation_index>
## Documentation Index
Refer to these files for deep context on specific areas:

### AI & Analysis Design
- [AI_FEATURES.md](AI_FEATURES.md) — High-level AI design philosophy and goals.
- [AI_UTILS.md](AI_UTILS.md) — Detailed breakdown of analysis utilities and benchmark pipeline.
- [AI_CONTEXT_REFACTOR.md](AI_CONTEXT_REFACTOR.md) — Context management and prompt-building strategy.
- [docs/design-dispel-analysis.md](docs/design-dispel-analysis.md) — Technical spec for talent-aware dispel logic.
- [docs/design-enemy-cd-timeline.md](docs/design-enemy-cd-timeline.md) — Technical spec for buff-expiry tracking.
- [docs/prompt-ab-testing-workflow.md](docs/prompt-ab-testing-workflow.md) — Standard workflow for system prompt A/B testing and evaluation.


### Project Management & Audits
- [TRACKER.md](TRACKER.md) — Active tasks, feature status, and known bugs.
- [CONSOLIDATION_PLAN.md](CONSOLIDATION_PLAN.md) — Architecture refactoring and package cleanup roadmap.
- [DATA_AUDIT.md](DATA_AUDIT.md) — Comprehensive audit of combat data coverage and quality.
- [TRACKER_ARCHIVE.md](TRACKER_ARCHIVE.md) — Historical task records.

### Technical Data Specs (Deep Lore)
- [packages/tools/docs/PET_ABILITY_RESOLUTION.md](packages/tools/docs/PET_ABILITY_RESOLUTION.md) — How pet casts are attributed to owners.
- [packages/tools/docs/DB2_SPELL_DATA_ISSUES.md](packages/tools/docs/DB2_SPELL_DATA_ISSUES.md) — Known inconsistencies in Blizzard's spell database.
</documentation_index>

Eval run history (append-only, git-tracked): [docs/eval-ledger.md](docs/eval-ledger.md); harness trust order in [docs/healer-eval-improvement-workflow.md](docs/healer-eval-improvement-workflow.md).

<eval_integrity>
## Eval Integrity (Non-negotiable, All AIs)

- **Never generate eval scores with a script, heuristic, regex, or random values.** Every score file under any `healer-eval/**/scores/` (or A/B `control|treatment/scores/`) must come from an actual judge pass that read the full prompt and response. No "scoring for scale", no backfilling missing ordinals with defaults.
- If a scoring run is too large to finish, **stop and report the ordinals completed** — partial honest data beats complete fabricated data. Do not fake the remainder.
- History: `scripts/finish_scoring.js` + `scripts/heuristic_eval.js` (deleted 2026-07-04) fabricated scores 51–100 of a 100-game run with hardcoded 4–5s and `Math.random()`. Every report derived from that run is invalid. Do not recreate them (see TRACKER.md F141).
- Deterministic checks belong in dedicated tools (`annotation-regression-check`, `promptQualityCheck`) that report **measured metrics** (line counts, regex hits, coverage ratios) — never dressed up as rubric scores.
</eval_integrity>
