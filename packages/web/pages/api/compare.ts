import Anthropic from '@anthropic-ai/sdk';
import { Firestore } from '@google-cloud/firestore';
import { AtomicArenaCombat, CombatUnitType, WoWCombatLogParser } from '@wowarenalogs/parser';
import fs from 'fs';
import type { NextApiRequest, NextApiResponse } from 'next';
import path from 'path';

import { checkRateLimit, clientIpFrom } from '../../../shared/src/api/rateLimit';
import { checkClaims } from '../../../shared/src/components/CombatReport/CombatAIAnalysis/claimChecker';
import {
  buildStatsLedPrompt,
  collectServerNumbers,
} from '../../../shared/src/components/CombatReport/CombatAIAnalysis/comparativePrompt';
import { buildExemplarLedPrompt } from '../../../shared/src/components/CombatReport/CombatAIAnalysis/comparativePrompt.exemplar';
import {
  diversifiedProCrises,
  toUserMetrics,
} from '../../../shared/src/components/CombatReport/CombatAIAnalysis/compareCrises';
import {
  CompareLocalContext,
  deriveBracket,
} from '../../../shared/src/components/CombatReport/CombatAIAnalysis/compareLocalContext';
import {
  buildVerifiedComparison,
  VerifiedComparison,
} from '../../../shared/src/components/CombatReport/CombatAIAnalysis/verifiedComparison';
import { resolveAIModel } from '../../../shared/src/utils/aiModels';
import { specToString } from '../../../shared/src/utils/cooldowns';
import {
  buildMatchEmbeddingRecord,
  BuiltEmbeddingRecord,
  isHealerSpec,
} from '../../../shared/src/utils/matchEmbeddingRecord';
import { loadCellRecords } from '../../../shared/src/utils/vectorSearch';

const isDev = process.env.NODE_ENV === 'development';
const COMPARE_TIMEOUT_MS = 20_000;

let cachedFirestore: Firestore | null = null;
function getFirestore(): Firestore {
  if (!cachedFirestore) {
    cachedFirestore = new Firestore({
      projectId: isDev ? 'wowarenalogs-public-dev' : 'wowarenalogs',
      credentials: isDev
        ? JSON.parse(fs.readFileSync(path.join(process.cwd(), '../cloud/wowarenalogs-public-dev.json'), 'utf8'))
        : undefined,
    });
  }
  return cachedFirestore;
}

async function resolveLogObjectUrl(matchId: string): Promise<string | null> {
  const snap = await getFirestore().collection('match-stubs-prod').where('id', '==', matchId).limit(1).get();
  if (snap.empty) return null;
  return (snap.docs[0].data() as { logObjectUrl?: string }).logObjectUrl ?? null;
}

function parseLog(text: string): AtomicArenaCombat[] {
  const parser = new WoWCombatLogParser('retail');
  const combats: AtomicArenaCombat[] = [];
  parser.on('arena_match_ended', (c) => combats.push(c));
  parser.on('solo_shuffle_ended', (m) => combats.push(...m.rounds));
  for (const line of text.split('\n')) parser.parseLine(line);
  parser.flush();
  return combats;
}

/** Shared preamble: resolve the user's side of the comparison. Two sources:
 *  1. `local` — the desktop client computed everything from its locally parsed combat
 *     (buildCompareLocalContext). No Firestore/GCS needed; this is the only path that works in
 *     the packaged app, where this route runs on the user's machine without GCP credentials.
 *  2. Firestore fallback — resolve the uploaded log by matchId, download and re-parse it.
 *     Kept for hosted-web deployments where the server has credentials. */
interface MatchContext {
  owner: { name: string };
  raw: BuiltEmbeddingRecord;
  specDisplay: string;
  bracket: string;
  /** Team damage taken per second — B151 pressure-matching for the offensiveIndex percentile. */
  teamDtps: number;
}

function contextFromLocal(local: CompareLocalContext): MatchContext | null {
  if (!local.playerName || !local.raw || typeof local.teamDtps !== 'number') {
    console.warn('[compare] localContext rejected: malformed (playerName/raw/teamDtps)');
    return null;
  }
  if (!isHealerSpec(local.specId)) {
    console.warn(`[compare] localContext rejected: specId ${local.specId} is not a healer`);
    return null; // healer gate, re-checked server-side
  }
  return {
    owner: { name: local.playerName },
    raw: local.raw,
    specDisplay: specToString(local.specId),
    bracket: local.bracket,
    teamDtps: local.teamDtps,
  };
}

/** Out-param diagnostics: distinguishes the stub-miss (7-day TTL expiry) null from other nulls so
 * the handler can report `expired` without a second Firestore lookup. */
interface CompareDiag {
  stubMissing?: boolean;
}

async function resolveMatchContext(
  matchId: string,
  local?: CompareLocalContext,
  diag?: CompareDiag,
): Promise<MatchContext | null> {
  if (local) return contextFromLocal(local);

  console.warn('[compare] no localContext in request; falling back to Firestore/GCS resolution');
  const logObjectUrl = await resolveLogObjectUrl(matchId);
  if (!logObjectUrl) {
    console.warn(`[compare] no match stub found in Firestore for ${matchId}`);
    if (diag) diag.stubMissing = true;
    return null;
  }
  const res = await fetch(logObjectUrl);
  if (!res.ok) {
    console.warn(`[compare] log download failed: HTTP ${res.status}`);
    return null;
  }
  const combats = parseLog(await res.text());
  const combat = combats.find((c) => c.id === matchId);
  if (!combat) {
    console.warn(`[compare] re-parsed log did not contain a combat matching id: ${matchId}`);
    return null;
  }

  const owner = combat.units[combat.playerId];
  if (!owner || !isHealerSpec(owner.spec)) {
    console.warn(`[compare] log owner missing or not a healer (spec=${owner?.spec})`);
    return null; // healer gate
  }

  const raw = buildMatchEmbeddingRecord(combat, owner.name);
  const specDisplay = specToString(owner.spec);
  const bracket = deriveBracket(combat);
  const durationSeconds = Math.max((combat.endTime - combat.startTime) / 1000, 1);
  const teamDtps =
    Object.values(combat.units)
      .filter((u) => u.type === CombatUnitType.Player && u.reaction === owner.reaction)
      .reduce((s, u) => s + u.damageIn.reduce((x, d) => x + Math.abs(d.effectiveAmount), 0), 0) / durationSeconds;

  return { owner, raw, specDisplay, bracket, teamDtps };
}

const NUM_RE = /\d+(?:\.\d+)?%?/g;

/** Numbers a draft is allowed to cite = those present in the prompt text. */
function numbersIn(text: string): number[] {
  return Array.from(
    new Set((text.match(NUM_RE) ?? []).map((t) => Math.round(parseFloat(t.replace('%', '')) * 100) / 100)),
  );
}

/** The spell names shown in a set of crisis sequences (the exemplar allow-list). */
function spellsFromCrises(crises: string[]): string[] {
  const spells = new Set<string>();
  for (const c of crises) {
    const colon = c.indexOf('): ');
    const resp = colon >= 0 ? c.slice(colon + 3) : c;
    for (const s of resp
      .split('->')
      .map((x) => x.trim())
      .filter(Boolean))
      spells.add(s);
  }
  return Array.from(spells);
}

// Legacy nearest-neighbor path (buildComparativePrompt) removed — arena reindex complete,
// exemplar-led is now the default. See docs/superpowers/compare-endpoint-handoff.md §4.

/** Stats-led path (flag-gated behind `variant === 'stats'`): loads the FULL spec+bracket cohort
 * cell (not the nearest 5) and builds a VerifiedComparison — full-cohort mean/median/p25/p75 and
 * a disclosed nReal per metric, never a fabricated average. */
async function buildStatsComparison(
  matchId: string,
  local?: CompareLocalContext,
  diag?: CompareDiag,
): Promise<VerifiedComparison | null> {
  const ctx = await resolveMatchContext(matchId, local, diag);
  if (!ctx) return null;
  const { owner, raw, specDisplay, bracket } = ctx;

  const cellRecords = (await loadCellRecords(specDisplay, bracket)).filter((r) => r.matchId !== matchId);
  if (cellRecords.length < 1) {
    console.warn(`[compare] empty cohort cell for spec="${specDisplay}" bracket="${bracket}"`);
    return null;
  }

  const verifiedComparison = buildVerifiedComparison(
    cellRecords,
    toUserMetrics(raw),
    { player: owner.name, spec: specDisplay, bracket },
    ctx.teamDtps,
  );

  // Guard: if buildVerifiedComparison drops all records (null metrics), cohort.n will be 0.
  // Don't call the LLM on a degenerate cohort.
  if (verifiedComparison.cohort.n < 1) return null;

  return verifiedComparison;
}

interface ExemplarComparison {
  verifiedComparison: VerifiedComparison;
  userCrises: string[];
  proCrises: string[];
}

/** Exemplar-led path (`variant === 'exemplar'`): full-cohort VerifiedComparison for the standing +
 * diversified real pro crisis sequences for concrete contrast. This is the winning A/B approach. */
async function buildExemplarComparison(
  matchId: string,
  local?: CompareLocalContext,
  diag?: CompareDiag,
): Promise<ExemplarComparison | null> {
  const ctx = await resolveMatchContext(matchId, local, diag);
  if (!ctx) return null;
  const { owner, raw, specDisplay, bracket } = ctx;

  const cellRecords = (await loadCellRecords(specDisplay, bracket)).filter((r) => r.matchId !== matchId);
  if (cellRecords.length < 1) {
    console.warn(`[compare] empty cohort cell for spec="${specDisplay}" bracket="${bracket}"`);
    return null;
  }

  const verifiedComparison = buildVerifiedComparison(
    cellRecords,
    toUserMetrics(raw),
    { player: owner.name, spec: specDisplay, bracket },
    ctx.teamDtps,
  );
  if (verifiedComparison.cohort.n < 1) {
    console.warn('[compare] degenerate cohort (all records dropped as null-metrics)');
    return null;
  }

  return {
    verifiedComparison,
    userCrises: raw.rotations.crisisEvents ?? [],
    proCrises: diversifiedProCrises(cellRecords),
  };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('compare timed out')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

async function generateReport(apiKey: string, prompt: string, requestedModel?: string): Promise<string | undefined> {
  const client = new Anthropic({ apiKey });
  // User-selectable model (Settings → AI Analysis); unknown ids fall back to the default.
  const modelOption = resolveAIModel(requestedModel);
  const msg = await client.messages.create({
    model: modelOption.id,
    max_tokens: 2048,
    // Sonnet 5 / Opus 4.7+ / Fable 5 reject sampling params with a 400.
    ...(modelOption.supportsTemperature ? { temperature: 0.3 } : {}),
    messages: [{ role: 'user', content: prompt }],
  });
  // Fable 5 safety classifiers can decline with an empty content array.
  const part = msg.content[0];
  return part?.type === 'text' ? part.text : undefined;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({});

  // T14: minimum-bar abuse protection for the Anthropic-spending endpoint.
  // In-memory = per-serverless-instance; good enough to stop naive loops.
  const rl = checkRateLimit(`compare:${clientIpFrom(req)}`, 20, 60_000);
  if (!rl.allowed) {
    res.setHeader('Retry-After', String(rl.retryAfterSeconds));
    return res.status(429).json({ error: 'Too many requests. Try again shortly.' });
  }

  const {
    matchId,
    apiKey: bodyApiKey,
    variant,
    model,
    localContext,
  } = (req.body ?? {}) as {
    matchId?: string;
    apiKey?: string;
    variant?: string;
    model?: string;
    localContext?: CompareLocalContext;
  };
  if (!matchId) return res.status(200).json({});
  const apiKey = bodyApiKey || process.env.ANTHROPIC_API_KEY;
  console.warn(
    `[compare] request matchId=${matchId} variant=${variant ?? 'exemplar'} localContext=${
      localContext ? 'yes' : 'no'
    } apiKey=${apiKey ? 'yes' : 'no'}`,
  );

  // Stats-led path: opt-in fallback (more accurate percentiles, 0% hallucination, but less
  // actionable than exemplar for games with a clear crisis). Useful for the ~10% of games with
  // no <40%-HP event (where exemplar has no personal sequence to show).
  if (variant === 'stats') {
    try {
      const diag: CompareDiag = {};
      const verifiedComparison = await withTimeout(
        buildStatsComparison(matchId, localContext, diag),
        COMPARE_TIMEOUT_MS,
      );
      if (!verifiedComparison) {
        return res.status(200).json({ expired: !!diag.stubMissing });
      }

      let statsReport: string | undefined;
      if (apiKey) {
        try {
          const draft = await generateReport(apiKey, buildStatsLedPrompt(verifiedComparison), model);
          if (draft) {
            // Gate on NUMBERS only: the stats-led prompt cites no pro spell names, so a
            // "spells" allow-list here is deliberately permissive (empty) and any spell
            // violation it produces (e.g. a registry label word that collides with a known
            // spell, like "Response" in "Defensive Response Latency") is ignored. Only an
            // uncited *number* — one the server did not compute — drops the report.
            const numbers = collectServerNumbers(verifiedComparison);
            const { violations } = checkClaims(draft, { spells: [], numbers });
            const numberViolations = violations.filter((v) => v.kind === 'number');
            if (numberViolations.length === 0) statsReport = draft;
          }
        } catch (err) {
          // report is optional; verifiedComparison still renders without it
          console.warn(`[compare] stats report generation failed: ${err instanceof Error ? err.message : 'unknown'}`);
        }
      }
      return res.status(200).json({ verifiedComparison, statsReport });
    } catch (err) {
      console.warn(`[compare] stats path failed: ${err instanceof Error ? err.message : 'unknown'}`);
      return res.status(200).json({});
    }
  }

  // Exemplar-led path: DEFAULT. Full-cohort standing + real diversified pro crisis sequences.
  // Won A/B 86% (actionability 4.70 vs 2.78). Arena reindex complete as of 2026-07-01.
  // No `variant` check needed — hits here when variant is 'exemplar' OR unset.
  if (!variant || variant === 'exemplar') {
    try {
      const diag: CompareDiag = {};
      const result = await withTimeout(buildExemplarComparison(matchId, localContext, diag), COMPARE_TIMEOUT_MS);
      if (!result) {
        return res.status(200).json({ expired: !!diag.stubMissing });
      }
      const { verifiedComparison, userCrises, proCrises } = result;

      let report: string | undefined;
      if (apiKey) {
        try {
          const prompt = buildExemplarLedPrompt({
            player: verifiedComparison.player,
            spec: verifiedComparison.spec,
            bracket: verifiedComparison.bracket,
            userCrises,
            proCrises,
            vc: verifiedComparison,
          });
          const draft = await generateReport(apiKey, prompt, model);
          if (draft) {
            // Allow: numbers in the prompt PLUS honest counts 0..#proCrises (the over-generalization
            // guardrail makes the model say "in N of the 6 shown"); spells: only those in the shown
            // sequences. Any other cited number or KNOWN spell drops the report.
            const numbers = numbersIn(prompt);
            for (let i = 0; i <= proCrises.length; i++) numbers.push(i);
            const spells = spellsFromCrises([...userCrises, ...proCrises]);
            const { violations } = checkClaims(draft, { spells, numbers });
            if (violations.length === 0) report = draft;
          }
        } catch (err) {
          // report is optional; the comparison still renders without it
          console.warn(
            `[compare] exemplar report generation failed: ${err instanceof Error ? err.message : 'unknown'}`,
          );
        }
      }
      return res.status(200).json({ verifiedComparison, userCrises, proCrises, report });
    } catch (err) {
      console.warn(`[compare] exemplar path failed: ${err instanceof Error ? err.message : 'unknown'}`);
      return res.status(200).json({});
    }
  }

  // Fallthrough: unknown variant — return empty rather than serving the retired legacy path.
  return res.status(200).json({});
}
