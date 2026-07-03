# WoW Arena Logs — CLAUDE.md

WoW arena combat logging and analysis platform. Desktop Electron app records local logs; web platform hosts match browsing, analytics, and AI-powered cooldown analysis.

See [docs/repo-overview.md](docs/repo-overview.md) for monorepo structure, core commands, engineering standards, and tech stack.

<architecture_highlights>

## Architecture Highlights

### Desktop ↔ Web separation

- Desktop behavior is gated on `typeof window.wowarenalogs !== 'undefined'`
- The `app` package's preload script injects `window.wowarenalogs` via Electron IPC
- Web package has zero knowledge of Electron; never import from `app` in `web` or `shared`
- Preload API is auto-generated from `packages/app/src/nativeBridge/modules/`

### Parser

- `WoWCombatLogParser` extends `EventEmitter3` (not Node.js EventEmitter)
- Emits: `arena_match_ended`, `solo_shuffle_ended`, `malformed_arena_match_detected`, `parser_error`
- Lazy pipeline init (WoW version detected from first log line)
- Performance-critical: handles thousands of lines/second; keep it lean

### Data flow

1. Desktop watches `WoWCombatLog.txt` → parser emits match → recorder clips video
2. Client requests signed GCS URL → uploads log buffer with headers `x-wlogs-locale`, `x-wlogs-year`
3. Cloud function fires on GCS trigger → parses → writes Firestore stub
4. Web fetches via GraphQL (Apollo Client + Apollo Server Micro at `pages/api/graphql`)

### State management (React)

- `ClientContext` — GraphQL client, auth user, match cache
- `AppConfigContext` — Desktop app configuration (localStorage + Electron IPC)
- `LocalCombatsContext` — In-memory local combat logs (desktop only)
- `VideoRecordingContext` — Recording session state (desktop only)
  </architecture_highlights>

<source_locations>

### Key source locations

- Combat report UI: `packages/shared/src/components/CombatReport/`
- AI cooldown analysis: `packages/shared/src/components/CombatReport/CombatAIAnalysis/`
- Cooldown utilities: `packages/shared/src/utils/cooldowns.ts`
- Enemy CD data: `packages/shared/src/utils/enemyCDs.ts`
- GraphQL queries: `packages/shared/src/graphql/queries.graphql`
- GraphQL server resolvers: `packages/shared/src/graphql-server/`
- Electron IPC handlers: `packages/app/src/nativeBridge/modules/`
- Cloud functions entry: `packages/cloud/src/index.ts`
- Prisma schema: `packages/sql/prisma/schema.prisma`
- Static spell data: `packages/shared/src/data/` (spellEffects.json, spellIdLists.json, talentIdMap.json)
- AI analysis API: `packages/web/pages/api/analyze.ts`
- AI utils detail + benchmark pipeline: `AI_UTILS.md`
- Log streaming agent (Windows): `packages/windows-agent/src/` (protocol + storage adapters shared with collector)
- Log collector + pipeline dashboard: `packages/tools/src/collectLogs.ts`, `packages/tools/src/dashboard/`
- wal-pilot tray app (both machines): `packages/pipeline-app/src/`
  </source_locations>

<git_workflow>

## Git Workflow

- Always push to `origin` (mingjianliu's fork), never to `upstream`.
- Never create PRs against the upstream repo (`wowarenalogs/wowarenalogs`). If a PR is needed, create it on origin. When commits land directly on `main`, a PR is usually unnecessary.

## Git Worktree Workflow (AI Agent Guidelines)

- The project has local Git commands for worktree management:
  - `git start-dev <branch>`: Creates a worktree in `.worktrees/<branch>` and runs `npm install`.
  - `git push-clean`: Run inside a worktree to push to origin.
- Interactive slash commands and natural language triggers are available in Claude, Gemini, and Antigravity:
  - **Start Development**: Triggered by `/start-dev <branch>` or when the user says "develop <branch>". The agent MUST run `git start-dev <branch>` and switch its context to `.worktrees/<branch>/` for subsequent edits.
  - **Commit, Push, and Clean Up**: Triggered by `/push-clean` or when the user says "commit and push" (or implicitly when the task is done). The agent MUST commit changes inside the worktree, run `git push-clean` inside the worktree, and then run `git worktree remove --force .worktrees/<branch>` and `git worktree prune` from the main repository root directory to clean up.
    </git_workflow>

## Active Work

- AI-powered cooldown analysis (`CombatAIAnalysis` component + `/api/analyze` endpoint)
- See `TRACKER.md` for feature/bug status, `AI_FEATURES.md` for design philosophy, `AI_UTILS.md` for per-utility detail
- Detailed workflows: [docs/commands/analyze-arena.md](docs/commands/analyze-arena.md), [docs/commands/collect-benchmarks.md](docs/commands/collect-benchmarks.md), [docs/prompt-ab-testing-workflow.md](docs/prompt-ab-testing-workflow.md)
- **Anthropic API Key Bypass (For All AIs)**: You do not need an Anthropic API key. You can simply create a new sub-agent and role-play the response AI to verify prompts.
