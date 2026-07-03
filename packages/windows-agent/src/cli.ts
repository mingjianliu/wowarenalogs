/* eslint-disable no-console */
/**
 * cli.ts — CLI entry point for the standalone Windows agent (`dist/wal-agent.js`).
 *
 * Kept separate from index.ts so that index.ts (imported/bundled into pipeline-app's main.ts via
 * streamerService.ts) has no top-level side effects. See index.ts's `main` comment for why a
 * `require.main === module` guard there would be unsafe once bundled elsewhere.
 */
import { main } from './index';

main().catch((e) => {
  console.error(`[wal-agent] fatal: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
