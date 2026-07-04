import path from 'path';

/**
 * Resolves a user-supplied path (env var / CLI arg) against the REPO ROOT
 * rather than process.cwd(). `npm run -w @wowarenalogs/tools …` sets cwd to
 * packages/tools, so cwd-relative resolution turns the documented
 * `packages/tools/local-batch/…` paths into
 * `packages/tools/packages/tools/local-batch/…`. Absolute paths pass through
 * unchanged.
 */
export function resolveRepoPath(p: string): string {
  if (path.isAbsolute(p)) return p;
  return path.resolve(__dirname, '../../..', p);
}
