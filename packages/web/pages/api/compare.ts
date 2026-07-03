import Anthropic from '@anthropic-ai/sdk';
import { Firestore } from '@google-cloud/firestore';
import { AtomicArenaCombat, CombatUnitReaction, CombatUnitType, WoWCombatLogParser } from '@wowarenalogs/parser';
import fs from 'fs';
import type { NextApiRequest, NextApiResponse } from 'next';
import path from 'path';

import { checkClaims } from '../../../shared/src/components/CombatReport/CombatAIAnalysis/claimChecker';
import {
  buildStatsLedPrompt,
  collectServerNumbers,
} from '../../../shared/src/components/CombatReport/CombatAIAnalysis/comparativePrompt';
import { buildExemplarLedPrompt } from '../../../shared/src/components/CombatReport/CombatAIAnalysis/comparativePrompt.exemplar';
import { MetricKey } from '../../../shared/src/components/CombatReport/CombatAIAnalysis/metricRegistry';
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
import { vectorizeMatch } from '../../../shared/src/utils/vectorEmbedding';
import { loadCellRecords, loadReferenceModel } from '../../../shared/src/utils/vectorSearch';

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

function deriveBracket(combat: AtomicArenaCombat): string {
  if (combat.startInfo?.bracket) return String(combat.startInfo.bracket);
  const friendly = Object.values(combat.units).filter(
    (u) => u.type === CombatUnitType.Player && u.reaction === CombatUnitReaction.Friendly,
  ).length;
  return friendly >= 3 ? '3v3' : '2v2';
}

/** Shared preamble: resolve the log, parse it, find the owner, and vectorize the match. Used by
 * both the legacy nearest-neighbor path and the new stats-led path. */
interface MatchContext {
  owner: { name: string };
  raw: BuiltEmbeddingRecord;
  embedding: number[];
  specDisplay: string;
  bracket: string;
}
async function resolveMatchContext(matchId: string): Promise<MatchContext | null> {
  const logObjectUrl = await resolveLogObjectUrl(matchId);
  if (!logObjectUrl) return null;
  const res = await fetch(logObjectUrl);
  if (!res.ok) return null;
  const combats = parseLog(await res.text());
  const combat = combats.find((c) => c.id === matchId) ?? combats[0];
  if (!combat) return null;

  const owner = combat.units[combat.playerId];
  if (!owner || !isHealerSpec(owner.spec)) return null; // healer gate

  const model = await loadReferenceModel();
  if (!model) return null;

  const raw = buildMatchEmbeddingRecord(combat, owner.name);
  const embedding = vectorizeMatch(raw, model);
  const specDisplay = specToString(owner.spec);
  const bracket = deriveBracket(combat);

  return { owner, raw, embedding, specDisplay, bracket };
}

const MAX_PRO_CRISES = 6;
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

/** One crisis sequence per distinct pro player, up to MAX_PRO_CRISES — real diversification. */
function diversifiedProCrises(cell: { playerName: string; crisisEvents?: string[] }[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const spellCount = (s: string) => (s.split('): ')[1] ?? s).split(' -> ').length;
  for (const r of cell) {
    if (out.length >= MAX_PRO_CRISES) break;
    if (seen.has(r.playerName)) continue;
    const crises = (r.crisisEvents ?? []).filter((s) => s && s.trim().length > 0);
    if (crises.length === 0) continue;
    // Pick this pro's MOST instructive crisis (most casts) — avoids surfacing a thin single-spell
    // "crisis" (e.g. a lone racial like Bag of Tricks) as a comparable pro when a richer one exists.
    const c = crises.reduce((best, s) => (spellCount(s) > spellCount(best) ? s : best));
    seen.add(r.playerName);
    out.push(c);
  }
  return out;
}

/** Maps the user's computed metrics onto MetricKey (note: the record stores legacy `reactionLatency`). */
function toUserMetrics(raw: BuiltEmbeddingRecord): Partial<Record<MetricKey, number | null>> {
  return {
    offensiveIndex: raw.offensiveIndex,
    ccDensity: raw.ccDensity,
    responseLatencySec: raw.reactionLatency,
    defensiveOverlapRatio: raw.defensiveOverlapRatio,
    effectiveCastRatio: raw.effectiveCastRatio,
    ccAvoidanceRate: raw.ccAvoidanceRate,
  };
}

// Legacy nearest-neighbor path (buildComparativePrompt) removed — arena reindex complete,
// exemplar-led is now the default. See docs/superpowers/compare-endpoint-handoff.md §4.

/** Stats-led path (flag-gated behind `variant === 'stats'`): loads the FULL spec+bracket cohort
 * cell (not the nearest 5) and builds a VerifiedComparison — full-cohort mean/median/p25/p75 and
 * a disclosed nReal per metric, never a fabricated average. */
async function buildStatsComparison(matchId: string): Promise<VerifiedComparison | null> {
  const ctx = await resolveMatchContext(matchId);
  if (!ctx) return null;
  const { owner, raw, specDisplay, bracket } = ctx;

  const cellRecords = (await loadCellRecords(specDisplay, bracket)).filter((r) => r.matchId !== matchId);
  if (cellRecords.length < 1) return null;

  const verifiedComparison = buildVerifiedComparison(cellRecords, toUserMetrics(raw), {
    player: owner.name,
    spec: specDisplay,
    bracket,
  });

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
async function buildExemplarComparison(matchId: string): Promise<ExemplarComparison | null> {
  const ctx = await resolveMatchContext(matchId);
  if (!ctx) return null;
  const { owner, raw, specDisplay, bracket } = ctx;

  const cellRecords = (await loadCellRecords(specDisplay, bracket)).filter((r) => r.matchId !== matchId);
  if (cellRecords.length < 1) return null;

  const verifiedComparison = buildVerifiedComparison(cellRecords, toUserMetrics(raw), {
    player: owner.name,
    spec: specDisplay,
    bracket,
  });
  if (verifiedComparison.cohort.n < 1) return null;

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
  const {
    matchId,
    apiKey: bodyApiKey,
    variant,
    model,
  } = (req.body ?? {}) as {
    matchId?: string;
    apiKey?: string;
    variant?: string;
    model?: string;
  };
  if (!matchId) return res.status(200).json({});
  const apiKey = bodyApiKey || process.env.ANTHROPIC_API_KEY;

  // Stats-led path: opt-in fallback (more accurate percentiles, 0% hallucination, but less
  // actionable than exemplar for games with a clear crisis). Useful for the ~10% of games with
  // no <40%-HP event (where exemplar has no personal sequence to show).
  if (variant === 'stats') {
    try {
      const verifiedComparison = await withTimeout(buildStatsComparison(matchId), COMPARE_TIMEOUT_MS);
      if (!verifiedComparison) return res.status(200).json({});

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
        } catch {
          // report is optional; verifiedComparison still renders without it
        }
      }
      return res.status(200).json({ verifiedComparison, statsReport });
    } catch {
      return res.status(200).json({});
    }
  }

  // Exemplar-led path: DEFAULT. Full-cohort standing + real diversified pro crisis sequences.
  // Won A/B 86% (actionability 4.70 vs 2.78). Arena reindex complete as of 2026-07-01.
  // No `variant` check needed — hits here when variant is 'exemplar' OR unset.
  if (!variant || variant === 'exemplar') {
    try {
      const built = await withTimeout(buildExemplarComparison(matchId), COMPARE_TIMEOUT_MS);
      if (!built) return res.status(200).json({});
      const { verifiedComparison, userCrises, proCrises } = built;

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
        } catch {
          // report is optional; the comparison still renders without it
        }
      }
      return res.status(200).json({ verifiedComparison, userCrises, proCrises, report });
    } catch {
      return res.status(200).json({});
    }
  }

  // Fallthrough: unknown variant — return empty rather than serving the retired legacy path.
  return res.status(200).json({});
}
