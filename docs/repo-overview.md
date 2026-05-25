# WoW Arena Logs — Repository Overview

WoW arena combat logging and analysis platform. Desktop Electron app records local logs; web platform hosts match browsing, analytics, and AI-powered cooldown analysis.

<monorepo_structure>
## Monorepo Structure

NPM workspaces with 9 packages under `packages/`:

| Package    | Type            | Purpose                                                                               |
| ---------- | --------------- | ------------------------------------------------------------------------------------- |
| `parser`   | Library         | WoW combat log parser. Performance critical. (TSDX, 200KB limit).                     |
| `shared`   | Library         | UI components (React 19), GraphQL client, utilities, and static data.                 |
| `web`      | Next.js 15 app  | Public website and AI analysis API routes.                                            |
| `app`      | Electron 38 app | Desktop app. Loads `web` in a BrowserWindow; adds `window.wowarenalogs` IPC bridge.   |
| `cloud`    | Cloud Functions | GCP serverless functions: log ingestion, parsing, Firestore writes, stat aggregation. |
| `recorder` | Library         | Video recording via OBS/FFmpeg.                                                       |
| `sql`      | ORM config      | Prisma schema + migrations for CockroachDB.                                           |
| `tools`    | Scripts         | Data extraction, benchmarks, and AI prompt engineering tools.                         |
| `linter`   | Config          | Shared ESLint config (`eslint-config-wowarenalogs`).                                  |
</monorepo_structure>

<core_commands>
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
</core_commands>

<engineering_standards>
## Engineering Standards

- **Zero Warnings:** `npm run lint` must have 0 warnings.
- **Strict Typing:** `strict: true` everywhere. Avoid `any`.
- **Build Order:** SQL → Parser → Recorder → Web/Desktop → App.
- **Parser Constraints:** Keep the parser lean. Size limit is 200KB (enforced at build time).
- **Isolation:** Never import `@wowarenalogs/app` in `web` or `shared`.
- **Build on Edit:** If you edit `packages/parser/src`, run `npm run build:parser` to ensure dependents see the changes.
- **Auto-Formatting:** After editing any file, run `npx prettier --write <file_path>` to ensure consistent formatting.
</engineering_standards>

<tech_stack>
## Tech Stack

- **Frontend**: React 19, Next.js 15 (Turbopack), TailwindCSS 3 + DaisyUI 2, Apollo Client 3.7, Pixi.js 8, Recharts 3
- **Backend**: Apollo Server Micro, Google Cloud Functions, Firestore, GCS
- **DB**: CockroachDB via Prisma 4.9
- **Desktop**: Electron 38, Webpack 5
- **Node**: 22+, npm 8.6.0+
</tech_stack>
