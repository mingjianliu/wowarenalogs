# WoW Arena Logs — Project Instructions

WoW arena combat logging and analysis platform. Desktop Electron app records local logs; web platform hosts match browsing, analytics, and AI-powered cooldown analysis.

## Monorepo Structure

NPM workspaces with 9 packages under `packages/`:

| Package    | Type            | Purpose                                                                                                                                                      |
| ---------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `parser`   | Library         | WoW combat log parser. Performance critical. (TSDX, 200KB limit).                                                                                            |
| `shared`   | Library         | UI components (React 19), GraphQL client, utilities, and static data.                                                                                        |
| `web`      | Next.js 15 app  | Public website and AI analysis API routes.                                                                                                                   |
| `app`      | Electron 38 app | Desktop app. Loads `web` in a BrowserWindow; adds `window.wowarenalogs` IPC bridge.                                                                          |
| `cloud`    | Cloud Functions | GCP serverless functions: log ingestion, parsing, Firestore writes, stat aggregation.                                                                        |
| `recorder` | Library         | Video recording via OBS/FFmpeg.                                                                                                                              |
| `sql`      | ORM config      | Prisma schema + migrations for CockroachDB.                                                                                                                  |
| `tools`    | Scripts         | Data extraction, benchmarks, and AI prompt engineering tools.                                                                                                |
| `linter`   | Config          | Shared ESLint config (`eslint-config-wowarenalogs`).                                                                                                         |

## Core Commands

```bash
# Development
npm run dev:web           # Next.js dev server (Turbopack, port 3000)
npm run dev:app           # Next.js + Electron together

# Building (order matters: SQL → parser → recorder → web → app)
npm run build             # Full build all packages
npm run build:web         # Next.js production build
npm run build:parser      # TSDX build (200KB size limit enforced)
npm run build:app         # Electron + preload bundles

# Linting & tests
npm run lint              # ESLint all packages (0 warnings allowed)
npm run lint:fix          # Auto-fix lint errors
npm run test              # Run tests across workspaces

# GraphQL codegen (run after editing queries.graphql)
npm run -w @wowarenalogs/shared codegen

# Generate Electron preload API (run after editing nativeBridge modules)
npm run gen:app:preload
```

## Engineering Standards

- **Zero Warnings:** `npm run lint` must have 0 warnings.
- **Strict Typing:** `strict: true` everywhere. Avoid `any`.
- **Build Order:** SQL → Parser → Recorder → Web/Desktop → App.
- **Parser Constraints:** Keep the parser lean. Size limit is 200KB (enforced at build time).
- **Isolation:** Never import `@wowarenalogs/app` in `web` or `shared`.
- **Build on Edit:** If you edit `packages/parser/src`, run `npm run build:parser` to ensure dependents see the changes.
- **Auto-Formatting:** After editing any file, run `npx prettier --write <file_path>` to ensure consistent formatting.

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

## Tech Stack

- **Frontend**: React 19, Next.js 15 (Turbopack), TailwindCSS 3 + DaisyUI 2, Apollo Client 3.7, Pixi.js 8, Recharts 3
- **Backend**: Apollo Server Micro, Google Cloud Functions, Firestore, GCS
- **DB**: CockroachDB via Prisma 4.9
- **Desktop**: Electron 38, Webpack 5
- **Node**: 22+, npm 8.6.0+

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

## Specialized Workflows

### 1. Match Analysis
To analyze a local WoW log:
1. Identify the latest log file (usually in `~/Library/Application Support/World of Warcraft/_retail_/Logs/`).
2. Run `npm run -w @wowarenalogs/tools start:printMatchPrompts -- --count 1 --new-prompt --test-prompt --log "<path>"`.
3. Read the output and provide the analysis yourself as the agent.

### 2. Testing with Logs
Use `packages/parser/test/testlogs/` for development:
- `3v3_tww_1120_reduced.txt`: Best general-purpose 3v3 log.
- `one_solo_shuffle.txt`: Solo shuffle testing.
- Use `--dry-run` with `scripts/testAnalyze.mjs` to verify scoring changes without spending API credits.

### 3. Calibration (Benchmarks)
Run the benchmark pipeline after major WoW patches to update `PANIC_PRESS_DAMAGE_THRESHOLD_*` in `cooldowns.ts`:
```bash
npm run -w @wowarenalogs/tools start:collectBenchmarks
```
Downloads recent matches from public API, parses, and extracts reference stats to `packages/tools/benchmarks/benchmark_data.json`.

### 4. Healer Prompt Improvement
Workflows for evaluating and improving healer-specific AI analysis:
- `eval-healer-prompts.md` and `improve-healer-prompts.md` in `.claude/commands/` describe the methodology.

## Sub-Agent Delegation
For complex tasks, use specialized agents:
- `invoke_agent(agent_name="codebase_investigator", prompt="Analyze the impact of changing spell ID X in spells.json")`
- `invoke_agent(agent_name="generalist", prompt="Run the full benchmark pipeline and update cooldowns.ts thresholds")`

## Git Workflow
- Always push to `origin` (mingjianliu's fork), never to `upstream`.
- Never create PRs against the upstream repo.

## Documentation Index

Refer to these files for deep context on specific areas:

### AI & Analysis Design
- [AI_FEATURES.md](AI_FEATURES.md) — High-level AI design philosophy and goals.
- [AI_UTILS.md](AI_UTILS.md) — Detailed breakdown of analysis utilities and benchmark pipeline.
- [AI_CONTEXT_REFACTOR.md](AI_CONTEXT_REFACTOR.md) — Context management and prompt-building strategy.
- [design-dispel-analysis.md](docs/design-dispel-analysis.md) — Technical spec for talent-aware dispel logic.
- [design-enemy-cd-timeline.md](docs/design-enemy-cd-timeline.md) — Technical spec for buff-expiry tracking.

### Project Management & Audits
- [TRACKER.md](TRACKER.md) — Active tasks, feature status, and known bugs.
- [CONSOLIDATION_PLAN.md](CONSOLIDATION_PLAN.md) — Architecture refactoring and package cleanup roadmap.
- [DATA_AUDIT.md](DATA_AUDIT.md) — Comprehensive audit of combat data coverage and quality.
- [TRACKER_ARCHIVE.md](TRACKER_ARCHIVE.md) — Historical task records.

### Development Workflows
- [healer-eval-improvement-workflow.md](docs/healer-eval-improvement-workflow.md) — Standardized workflow for healer eval cycles.

### Technical Data Specs (Deep Lore)
- [PET_ABILITY_RESOLUTION.md](packages/tools/docs/PET_ABILITY_RESOLUTION.md) — How pet casts are attributed to owners.
- [DB2_SPELL_DATA_ISSUES.md](packages/tools/docs/DB2_SPELL_DATA_ISSUES.md) — Known inconsistencies in Blizzard's spell database.

