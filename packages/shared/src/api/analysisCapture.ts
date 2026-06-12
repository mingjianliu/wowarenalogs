import crypto from 'crypto';

export type PromptId = 'FINDINGS_JSON' | 'NEW' | 'SYSTEM' | 'custom';

export interface AnalysisCaptureInput {
  matchId?: string;
  model: string;
  promptId: PromptId;
  activeSystemPrompt: string;
  flags: { findingsJson?: boolean; useTimelinePrompt?: boolean };
  matchContext: string;
  analysisProse: string;
  findings: unknown | null;
  parseOk?: boolean;
  parseError?: string;
  rawText: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

export interface AnalysisCaptureDoc {
  captureId: string;
  timestamp: Date;
  model: string;
  promptId: PromptId;
  promptHash: string;
  flags: { findingsJson: boolean; useTimelinePrompt: boolean };
  matchId: string | null;
  logObjectUrl: string | null;
  rawLogSnapshotUrl: string | null;
  input: { matchContext: string };
  output: {
    analysisProse: string;
    findings: unknown | null;
    parseOk: boolean | null;
    parseError: string | null;
    rawText: string;
  };
  usage: { inputTokens: number; outputTokens: number; durationMs: number };
}

/** Pure: build the Firestore document from the input. apiKey is structurally absent. */
export function buildCaptureRecord(
  input: AnalysisCaptureInput,
  opts: { captureId?: string; now?: Date } = {},
): AnalysisCaptureDoc {
  return {
    captureId: opts.captureId ?? crypto.randomUUID(),
    timestamp: opts.now ?? new Date(),
    model: input.model,
    promptId: input.promptId,
    promptHash: crypto.createHash('sha256').update(input.activeSystemPrompt).digest('hex'),
    flags: {
      findingsJson: input.flags.findingsJson ?? false,
      useTimelinePrompt: input.flags.useTimelinePrompt ?? false,
    },
    matchId: input.matchId ?? null,
    logObjectUrl: null, // resolved later in the IO layer
    rawLogSnapshotUrl: null, // set later in the IO layer
    input: { matchContext: input.matchContext },
    output: {
      analysisProse: input.analysisProse,
      findings: input.findings == null ? null : JSON.parse(JSON.stringify(input.findings)),
      parseOk: input.parseOk ?? null,
      parseError: input.parseError ?? null,
      rawText: input.rawText,
    },
    usage: {
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      durationMs: input.durationMs,
    },
  };
}

/** Pure: capture only real production runs (exclude dev and debug/test runs). */
export function shouldCapture(env: { nodeEnv?: string; debug?: boolean }): boolean {
  return env.nodeEnv === 'production' && env.debug !== true;
}
