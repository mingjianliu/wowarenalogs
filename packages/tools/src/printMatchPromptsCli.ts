/* eslint-disable no-console */
/**
 * printMatchPromptsCli.ts — CLI entry point for running printMatchPrompts on its own.
 * Usage:
 *   npm run -w @wowarenalogs/tools start:printMatchPrompts
 *   npm run -w @wowarenalogs/tools start:printMatchPrompts -- --count 10
 *   npm run -w @wowarenalogs/tools start:printMatchPrompts -- --count 5 --bracket 3v3
 *   npm run -w @wowarenalogs/tools start:printMatchPrompts -- --local
 *   npm run -w @wowarenalogs/tools start:printMatchPrompts -- --count 3 --ai
 *   npm run -w @wowarenalogs/tools start:printMatchPrompts -- --count 3 --ai --test-prompt
 *   npm run -w @wowarenalogs/tools start:printMatchPrompts -- --count 1 --new-prompt
 *   npm run -w @wowarenalogs/tools start:printMatchPrompts -- --count 5 --spec Priest_Discipline --result Win --min-duration 60 --verbose
 *
 * Kept separate from printMatchPrompts.ts so that printMatchPrompts.ts (imported/bundled into
 * pipeline-app's main.ts via localBatchAnalysis.ts/collectorService.ts) has no top-level side
 * effects. See printMatchPrompts.ts's `main` comment for why a `require.main === module` guard
 * there would be unsafe once bundled.
 */
import { main } from './printMatchPrompts';

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
