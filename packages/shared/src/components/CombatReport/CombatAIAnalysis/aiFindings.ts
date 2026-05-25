// AI findings: the structured contract the model returns, a tolerant parser that
// turns model text into typed findings, and a renderer that reproduces the legacy
// "## Finding" prose so the eval/benchmark pipeline (which consumes the prose
// string) keeps working unchanged.

export type FindingSeverity = 'Critical' | 'High' | 'Medium' | 'Low';
export type FindingConfidence = 'High' | 'Medium' | 'Low';

export interface AIFinding {
  rank: number;
  title: string;
  severity: FindingSeverity;
  confidence: FindingConfidence;
  confidenceNote: string;
  /** Seconds into the match — the timeline anchor and centre of the evidence window. */
  atSeconds: number;
  /** AI estimate of impact, e.g. "+140k effective HP saved". */
  impactDelta: string;
  summary: string;
  whatHappened: string;
  alternative: string;
  impact: string;
  /** Expanded "what if" estimate shown in the evidence drawer. */
  counterfactual: string;
}

const SEVERITIES: readonly FindingSeverity[] = ['Critical', 'High', 'Medium', 'Low'];
const CONFIDENCES: readonly FindingConfidence[] = ['High', 'Medium', 'Low'];

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function asSeverity(value: unknown): FindingSeverity {
  return SEVERITIES.includes(value as FindingSeverity) ? (value as FindingSeverity) : 'Medium';
}

function asConfidence(value: unknown): FindingConfidence {
  return CONFIDENCES.includes(value as FindingConfidence) ? (value as FindingConfidence) : 'Medium';
}

/**
 * Extract the first balanced JSON value (object or array) from arbitrary model
 * text. Handles code fences and surrounding prose. Returns the parsed value or
 * throws if no JSON can be recovered.
 */
function extractJson(raw: string): unknown {
  const trimmed = raw.trim();

  // Fast path: the whole thing is JSON.
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through to extraction
  }

  // Strip a single fenced block if present (```json … ``` or ``` … ```).
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenceMatch ? fenceMatch[1].trim() : trimmed;
  try {
    return JSON.parse(body);
  } catch {
    // fall through to brace scanning
  }

  // Scan for the first balanced { … } or [ … ].
  const start = body.search(/[{[]/);
  if (start === -1) {
    throw new Error('No JSON object found in AI response');
  }
  const open = body[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        return JSON.parse(body.slice(start, i + 1));
      }
    }
  }
  throw new Error('Unbalanced JSON in AI response');
}

function normalizeFinding(input: Record<string, unknown>): AIFinding {
  return {
    rank: asNumber(input.rank, 1),
    title: asString(input.title, 'Untitled finding'),
    severity: asSeverity(input.severity),
    confidence: asConfidence(input.confidence),
    confidenceNote: asString(input.confidenceNote),
    atSeconds: asNumber(input.atSeconds, 0),
    impactDelta: asString(input.impactDelta),
    summary: asString(input.summary),
    whatHappened: asString(input.whatHappened),
    alternative: asString(input.alternative),
    impact: asString(input.impact),
    counterfactual: asString(input.counterfactual),
  };
}

/**
 * Parse a model response into typed findings. Accepts a `{ findings: [...] }`
 * envelope or a bare array, tolerates fences/prose, fills defaults for missing
 * fields, and renumbers ranks sequentially after sorting.
 */
export function parseFindingsResponse(raw: string): AIFinding[] {
  const parsed = extractJson(raw);
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { findings?: unknown }).findings)
      ? (parsed as { findings: unknown[] }).findings
      : null;

  if (!list) {
    throw new Error('AI response did not contain a findings array');
  }

  const findings = list
    .filter((f): f is Record<string, unknown> => typeof f === 'object' && f !== null)
    .map(normalizeFinding)
    .sort((a, b) => a.rank - b.rank)
    .map((f, i) => ({ ...f, rank: i + 1 }));

  return findings;
}

/**
 * Render findings back into the legacy "## Finding N" markdown so existing
 * eval/benchmark consumers that read the prose `analysis` string keep working.
 * The four core fields match the original SYSTEM_PROMPT output format exactly.
 */
export function renderFindingsAsProse(findings: AIFinding[]): string {
  return findings
    .map((f, i) => {
      const lines = [
        `## Finding ${i + 1}: ${f.title}`,
        `**What happened:** ${f.whatHappened}`,
        `**Alternative:** ${f.alternative}`,
        `**Impact:** ${f.impact}`,
        `**Confidence:** ${f.confidence} — ${f.confidenceNote}`,
      ];
      return lines.join('\n');
    })
    .join('\n\n');
}
