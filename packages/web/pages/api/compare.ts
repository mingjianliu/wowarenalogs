import Anthropic from '@anthropic-ai/sdk';
import { Firestore } from '@google-cloud/firestore';
import { AtomicArenaCombat, CombatUnitReaction, CombatUnitType, WoWCombatLogParser } from '@wowarenalogs/parser';
import fs from 'fs';
import type { NextApiRequest, NextApiResponse } from 'next';
import path from 'path';

import {
  buildComparativePrompt,
  ComparativeAnalysisData,
} from '../../../shared/src/components/CombatReport/CombatAIAnalysis/comparativePrompt';
import { specToString } from '../../../shared/src/utils/cooldowns';
import { buildMatchEmbeddingRecord, isHealerSpec } from '../../../shared/src/utils/matchEmbeddingRecord';
import { vectorizeMatch } from '../../../shared/src/utils/vectorEmbedding';
import { findNearestProMatchesLocal, loadReferenceModel } from '../../../shared/src/utils/vectorSearch';

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

async function buildComparison(matchId: string): Promise<ComparativeAnalysisData | null> {
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

  const neighbors = (await findNearestProMatchesLocal(specDisplay, embedding, bracket, 6))
    .filter((n) => n.id !== matchId && n.data.metrics != null)
    .slice(0, 5);
  if (neighbors.length < 1) return null;

  return {
    playerName: owner.name,
    spec: specDisplay,
    userMetrics: {
      offensiveIndex: raw.offensiveIndex,
      ccDensity: raw.ccDensity,
      reactionLatency: raw.reactionLatency,
      defensiveOverlapRatio: raw.defensiveOverlapRatio,
      effectiveCastRatio: raw.effectiveCastRatio,
      ccAvoidanceRate: raw.ccAvoidanceRate,
    },
    userCrisisEvents: raw.rotations.crisisEvents,
    nearestNeighbors: neighbors.map((n) => ({
      distance: n.distance,
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      metrics: n.data.metrics!,
      crisisEvents: n.data.crisisEvents ?? [],
    })),
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

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({});
  const { matchId, apiKey: bodyApiKey } = (req.body ?? {}) as { matchId?: string; apiKey?: string };
  if (!matchId) return res.status(200).json({});

  try {
    const comparison = await withTimeout(buildComparison(matchId), COMPARE_TIMEOUT_MS);
    if (!comparison) return res.status(200).json({});

    let comparisonReport: string | undefined;
    const apiKey = bodyApiKey || process.env.ANTHROPIC_API_KEY;
    if (apiKey) {
      try {
        const client = new Anthropic({ apiKey });
        const msg = await client.messages.create({
          model: 'claude-sonnet-4-6',
          max_tokens: 2048,
          temperature: 0.3,
          messages: [{ role: 'user', content: buildComparativePrompt(comparison) }],
        });
        const part = msg.content[0];
        if (part.type === 'text') comparisonReport = part.text;
      } catch {
        // report is optional; comparison still renders without it
      }
    }
    return res.status(200).json({ comparison, comparisonReport });
  } catch {
    return res.status(200).json({});
  }
}
