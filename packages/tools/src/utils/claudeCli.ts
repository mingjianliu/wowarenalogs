/* eslint-disable no-console */
/**
 * claudeCli.ts — analysis backend that invokes the local Claude Code CLI
 * (`claude -p`, headless print mode) instead of the Anthropic API. Uses the
 * machine's logged-in Claude subscription: no ANTHROPIC_API_KEY, no per-token
 * billing.
 *
 * Backend selection (resolveAnalysisBackend):
 *   ANALYSIS_BACKEND=api   force the Anthropic API (requires ANTHROPIC_API_KEY)
 *   ANALYSIS_BACKEND=cli   force the local Claude CLI (requires `claude` on PATH)
 *   unset                  api if ANTHROPIC_API_KEY is set, else cli if
 *                          available, else none (callers skip AI, as before)
 *
 * ANALYSIS_CLI_MODEL overrides the CLI model (default "opus", per user
 * preference; set ANALYSIS_CLI_MODEL=sonnet if Opus weekly caps become a
 * problem for large batches).
 */
import { spawn, spawnSync } from 'child_process';

export type AnalysisBackend = 'api' | 'cli' | 'none';

export const DEFAULT_CLI_MODEL = 'opus';
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // generous: CLI boot + long analyses

let cliAvailable: boolean | null = null;

export function isClaudeCliAvailable(): boolean {
  if (cliAvailable === null) {
    try {
      cliAvailable = spawnSync('claude', ['--version'], { timeout: 15_000 }).status === 0;
    } catch {
      cliAvailable = false;
    }
  }
  return cliAvailable;
}

export function resolveAnalysisBackend(): AnalysisBackend {
  const forced = process.env.ANALYSIS_BACKEND;
  if (forced === 'api') {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANALYSIS_BACKEND=api but ANTHROPIC_API_KEY is not set');
    }
    return 'api';
  }
  if (forced === 'cli') {
    if (!isClaudeCliAvailable()) {
      throw new Error('ANALYSIS_BACKEND=cli but the `claude` CLI was not found on PATH');
    }
    return 'cli';
  }
  if (forced) {
    throw new Error(`Unknown ANALYSIS_BACKEND "${forced}" — use "api" or "cli"`);
  }
  if (process.env.ANTHROPIC_API_KEY) return 'api';
  if (isClaudeCliAvailable()) return 'cli';
  return 'none';
}

/**
 * One-shot headless call: prompt via stdin, response on stdout. `--tools ""`
 * makes it pure text-in/text-out (no file/tool access), and
 * `--no-session-persistence` keeps calls independent. Rejects on non-zero
 * exit (the error carries the CLI's own message — e.g. usage-limit text — so
 * callers record `[AI call failed: ...]` instead of storing it as analysis)
 * and on empty output.
 */
export function callClaudeCli(opts: {
  prompt: string;
  systemPrompt: string;
  model?: string;
  timeoutMs?: number;
}): Promise<string> {
  const model = opts.model ?? process.env.ANALYSIS_CLI_MODEL ?? DEFAULT_CLI_MODEL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<string>((resolve, reject) => {
    const child = spawn(
      'claude',
      ['-p', '--system-prompt', opts.systemPrompt, '--tools', '', '--no-session-persistence', '--model', model],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`claude CLI timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`claude CLI failed to spawn: ${err.message}`));
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const detail = (stderr.trim() || stdout.trim()).slice(0, 500);
      if (code !== 0) {
        reject(new Error(`claude CLI exited ${code}: ${detail || '(no output)'}`));
      } else if (!stdout.trim()) {
        reject(new Error(`claude CLI returned empty output${stderr.trim() ? `: ${detail}` : ''}`));
      } else {
        resolve(stdout.trim());
      }
    });

    child.stdin.on('error', () => undefined); // EPIPE if the child dies first — close handler reports the real cause
    child.stdin.write(opts.prompt);
    child.stdin.end();
  });
}
