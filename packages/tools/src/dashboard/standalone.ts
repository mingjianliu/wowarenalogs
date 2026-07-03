/* eslint-disable no-console */
/**
 * standalone.ts — CLI entry point for running the dashboard on its own.
 * Usage: npm run -w @wowarenalogs/tools dashboard   →  http://127.0.0.1:5178
 *
 * Kept separate from server.ts so that server.ts (imported/bundled into pipeline-app's main.ts)
 * has no top-level side effects. See server.ts's header comment for why a
 * `require.main === module` guard inside server.ts itself is unsafe once bundled.
 */
import { createDashboardServer } from './server';

void createDashboardServer().then(({ port }) => console.log(`[dashboard] http://127.0.0.1:${port}`));
