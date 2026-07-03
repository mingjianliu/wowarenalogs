/* eslint-disable no-console */
/**
 * collectLogsCli.ts — CLI entry point for running the collector on its own.
 * Usage: npm run -w @wowarenalogs/tools start:collectLogs
 *
 * Kept separate from collectLogs.ts so that collectLogs.ts (imported/bundled into pipeline-app's
 * main.ts via collectorService.ts) has no top-level side effects. See collectLogs.ts's header
 * comment for why a `require.main === module` guard inside collectLogs.ts itself is unsafe once
 * bundled.
 */
import { loadCollectorConfig } from './collect/collectorConfig';
import { runCollection } from './collectLogs';

runCollection(loadCollectorConfig()).catch((e) => {
  console.error(e);
  process.exit(1);
});
