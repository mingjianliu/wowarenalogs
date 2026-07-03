/* eslint-disable no-console */
/**
 * localBatchAnalysisCli.ts — CLI entry point for running the local batch analysis on its own.
 * Usage:
 *   npm run -w @wowarenalogs/tools start:localBatchAnalysis
 *   npm run -w @wowarenalogs/tools start:localBatchAnalysis -- --phase1-only
 *   npm run -w @wowarenalogs/tools start:localBatchAnalysis -- --phase2-only
 *   npm run -w @wowarenalogs/tools start:localBatchAnalysis -- --max-matches 20
 *
 * Kept separate from localBatchAnalysis.ts so that localBatchAnalysis.ts (imported/bundled into
 * pipeline-app's main.ts via collectorService.ts) has no top-level side effects. See
 * localBatchAnalysis.ts's `main` comment for why a `require.main === module` guard there would be
 * unsafe once bundled.
 */
import { main } from './localBatchAnalysis';

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
