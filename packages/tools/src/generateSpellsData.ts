/* eslint-disable no-console */
import fs from 'fs-extra';
import fetch from 'node-fetch';
import path from 'path';

import { awcSpellIds } from '../../shared/src/data/awcSpells';
import taggedSpellsDump from '../../shared/src/data/spells.json';
import talentIdMap from '../../shared/src/data/talentIdMap.json';

const taggedSpellIds = Object.keys(taggedSpellsDump);

// Walk talentIdMap and collect every `type: "active"` spellId from class/spec/hero/subtree nodes.
// Any active talent button is a potential CD worth tracking — including this set future-proofs
// the metadata library against new talents that Blizzard hasn't flagged in SpellMisc.
function collectTalentActiveSpellIds(): string[] {
  const ids = new Set<string>();
  type Entry = { type?: string; spellId?: number };
  type Node = { entries?: Entry[] };
  type Spec = { classNodes?: Node[]; specNodes?: Node[]; heroNodes?: Node[]; subTreeNodes?: Node[] };
  const nodeBuckets: (keyof Spec)[] = ['classNodes', 'specNodes', 'heroNodes', 'subTreeNodes'];
  for (const spec of talentIdMap as unknown as Spec[]) {
    for (const bucket of nodeBuckets) {
      const nodes = spec[bucket];
      if (!nodes) continue;
      for (const node of nodes) {
        if (!node.entries) continue;
        for (const entry of node.entries) {
          if (entry.type === 'active' && typeof entry.spellId === 'number' && entry.spellId > 0) {
            ids.add(entry.spellId.toString());
          }
        }
      }
    }
  }
  return Array.from(ids);
}

const talentActiveSpellIds = collectTalentActiveSpellIds();

import { WAGO_BUILD, withBuild } from './wagoConfig';
const SOURCE_TABLES = {
  spellCooldowns: withBuild('SpellCooldowns'),
  spellCategory: withBuild('SpellCategory'),
  spellCategories: withBuild('SpellCategories'),
  spellCastTimes: withBuild('SpellCastTimes'),
  spellEffect: withBuild('SpellEffect'),
  spellName: withBuild('SpellName'),
  spellDuration: withBuild('SpellDuration'),
  spellMisc: withBuild('SpellMisc'),
};

let spellCategory: {
  id: number;
  maxCharges: number;
  chargeRecoveryTime: number;
}[] = [];
let spellCategories: {
  spellId: number;
  difficultyId: number;
  chargeCategoryId: number;
  dispelType: number;
}[] = [];
let spellNames: { id: number; name: string }[] = [];
let spellCDs: {
  spellId: number;
  difficultyId: number;
  categoryCooldown: number;
  cooldown: number;
}[] = [];
let spellDurations: { id: number; durationMs: number }[] = [];
let spellCastTimes: { id: number; baseMs: number; minimumMs: number }[] = [];
let spellEffects: { spellId: number; difficultyId: number }[] = [];
let spellMiscInfo: {
  spellId: number;
  difficultyId: number;
  castingTimeId: number;
  durationId: number;
}[] = [];

// DispelType values from SpellCategories.db2: 0=None, 1=Magic, 2=Curse, 3=Disease, 4=Poison
const DISPEL_TYPE_MAP: Record<number, 'Magic' | 'Curse' | 'Disease' | 'Poison'> = {
  1: 'Magic',
  2: 'Curse',
  3: 'Disease',
  4: 'Poison',
};

interface ISpellDbEntry {
  spellId: string;
  name: string;
  charges?: {
    charges: number;
    chargeCooldownSeconds: number;
  };
  durationSeconds: number;
  cooldownSeconds: number;
  /** Dispel type from SpellCategories.db2. null means the aura cannot be dispelled by normal means. */
  dispelType: 'Magic' | 'Curse' | 'Disease' | 'Poison' | null;
}

type CsvRow = Record<string, string>;

function toInt(value: string): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseCsv(csv: string): CsvRow[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < csv.length; i += 1) {
    const char = csv[i];
    const next = csv[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        field += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (!inQuotes && char === ',') {
      row.push(field);
      field = '';
      continue;
    }

    if (!inQuotes && char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }

    if (!inQuotes && char === '\r') {
      continue;
    }

    field += char;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  if (rows.length < 2) {
    throw new Error('CSV payload appears empty.');
  }

  const headers = rows[0];
  return rows.slice(1).map((values) => {
    const result: CsvRow = {};
    headers.forEach((header, index) => {
      result[header] = values[index] ?? '';
    });
    return result;
  });
}

async function loadCsv(url: string): Promise<CsvRow[]> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}. HTTP ${response.status}`);
  }
  const csv = await response.text();
  return parseCsv(csv);
}

function choosePreferredByDifficulty<T extends { difficultyId: number }>(current: T | undefined, candidate: T): T {
  if (!current) {
    return candidate;
  }
  if (current.difficultyId !== 0 && candidate.difficultyId === 0) {
    return candidate;
  }
  return current;
}

async function loadFiles() {
  const [
    spellCooldownRows,
    spellCategoryRows,
    spellCategoriesRows,
    spellCastTimeRows,
    spellEffectRows,
    spellNameRows,
    spellDurationRows,
    spellMiscRows,
  ] = await Promise.all([
    loadCsv(SOURCE_TABLES.spellCooldowns),
    loadCsv(SOURCE_TABLES.spellCategory),
    loadCsv(SOURCE_TABLES.spellCategories),
    loadCsv(SOURCE_TABLES.spellCastTimes),
    loadCsv(SOURCE_TABLES.spellEffect),
    loadCsv(SOURCE_TABLES.spellName),
    loadCsv(SOURCE_TABLES.spellDuration),
    loadCsv(SOURCE_TABLES.spellMisc),
  ]);

  spellCDs = spellCooldownRows.map((r) => ({
    spellId: toInt(r.SpellID),
    difficultyId: toInt(r.DifficultyID),
    categoryCooldown: toInt(r.CategoryRecoveryTime),
    cooldown: toInt(r.RecoveryTime),
  }));

  spellCategory = spellCategoryRows.map((r) => ({
    id: toInt(r.ID),
    maxCharges: toInt(r.MaxCharges),
    chargeRecoveryTime: toInt(r.ChargeRecoveryTime),
  }));

  spellCategories = spellCategoriesRows.map((r) => ({
    spellId: toInt(r.SpellID),
    difficultyId: toInt(r.DifficultyID),
    chargeCategoryId: toInt(r.ChargeCategory),
    dispelType: toInt(r.DispelType),
  }));

  spellNames = spellNameRows.map((r) => ({
    id: toInt(r.ID),
    name: r.Name_lang || 'NAME_NOT_FOUND',
  }));

  spellDurations = spellDurationRows.map((r) => ({
    id: toInt(r.ID),
    durationMs: toInt(r.Duration),
  }));
  spellCastTimes = spellCastTimeRows.map((r) => ({
    id: toInt(r.ID),
    baseMs: toInt(r.Base),
    minimumMs: toInt(r.Minimum),
  }));
  spellEffects = spellEffectRows.map((r) => ({
    spellId: toInt(r.SpellID),
    difficultyId: toInt(r.DifficultyID),
  }));

  spellMiscInfo = spellMiscRows.map((r) => ({
    spellId: toInt(r.SpellID),
    difficultyId: toInt(r.DifficultyID),
    castingTimeId: toInt(r.CastingTimeIndex),
    durationId: toInt(r.DurationIndex),
  }));
}

const newEffectsLibrary: Record<string, ISpellDbEntry> = {};

// Spell IDs from classMetadata that are not in spells.json or awcSpells (e.g. newly added class entries)
const MANUAL_SPELL_IDS: string[] = [
  // Evoker — not in spells.json (class added in Dragonflight)
  '351338', // Quell
  '357210', // Deep Breath
  '368970', // Tail Swipe
  '357214', // Wing Buffet
  '374227', // Zephyr
  '374251', // Cauterizing Flame
  '378441', // Time Stop
  '375087', // Dragonrage
  '363916', // Obsidian Scales
  '370553', // Tip the Scales
  '359816', // Dream Flight
  '363534', // Rewind
  '370960', // Emerald Communion
  '370537', // Stasis
  '370665', // Rescue
  '403631', // Breath of Eons
  '404977', // Time Skip
  '360828', // Blistering Scales
  // Healer utility CDs — tagged in classMetadata but absent from spells.json
  '633', // Lay on Hands (Holy Paladin)
  '62618', // Power Word: Barrier (Disc Priest)
  '311054', // Weapons of Order (Mistweaver Monk)
];

function collectSpellIds(): string[] {
  const rawIds = [...taggedSpellIds, ...awcSpellIds, ...MANUAL_SPELL_IDS, ...talentActiveSpellIds];
  const validIds = rawIds.filter((id) => /^\d+$/.test(id));
  const invalidIds = rawIds.length - validIds.length;
  if (invalidIds > 0) {
    console.log(`Dropped ${invalidIds} invalid spell id entries.`);
  }
  return Array.from(new Set(validIds)).sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
}

const spellIds = collectSpellIds();

const spellNameById = new Map<number, string>();
const spellCooldownBySpellId = new Map<number, { difficultyId: number; cooldown: number; categoryCooldown: number }>();
const spellMiscBySpellId = new Map<number, { difficultyId: number; castingTimeId: number; durationId: number }>();
const spellCategoriesBySpellId = new Map<
  number,
  { difficultyId: number; chargeCategoryId: number; dispelType: number }
>();
const spellCategoryById = new Map<number, { maxCharges: number; chargeRecoveryTime: number }>();
const spellDurationById = new Map<number, number>();
const spellCastTimeById = new Map<number, { baseMs: number; minimumMs: number }>();
const spellEffectsBySpellId = new Map<number, number>();

function findName(id: number): string {
  const maybeMatch = spellNameById.get(id);
  // Every spell id with a missing name must be accounted for!
  if (!maybeMatch) {
    console.log(`MISSING NAME ${id}`);
  }
  return maybeMatch ?? 'NAME_NOT_FOUND';
}

function findCooldown(id: number): number {
  const maybeMatch = spellCooldownBySpellId.get(id);
  // Missing cooldown info is mostly OK.. we have spell effects that have no cd (garrote silence) that we want
  // to track some info about
  // if (!maybeMatch) {
  //   console.log(`Missing cooldown ${id}`);
  // }
  return ((maybeMatch?.cooldown || maybeMatch?.categoryCooldown) ?? 999999) / 1000;
}

const MANUAL_DURATION_OVERRIDES: Record<string, number> = {
  '33891': 30, // Incarnation: Tree of Life
  '132158': 15, // Nature's Swiftness
  '378081': 15, // Nature's Swiftness
  '47568': 20, // Empower Rune Weapon
  '51533': 15, // Feral Spirit
  '51690': 2, // Killing Spree
  '63560': 15, // Dark Transformation
  '114049': 15, // Ascendance
  '114050': 15, // Ascendance
  '115192': 3, // Subterfuge
  '152173': 15, // Seraphim
  '191427': 30, // Metamorphosis
  '288849': 30, // Stitchmaster
  '343294': 5, // Soul Reaper
  '360966': 12, // Spearhead
  '383269': 12, // Graveyard
  '384352': 8, // Doom Winds
  '400456': 30, // Salvo
  '205025': 15, // Presence of Mind
  // Convoke the Spirits variants
  '322431': 4,
  '322442': 4,
  '322457': 4,
  '322458': 4,
  '322459': 4,
  '322460': 4,
  '322461': 4,
  '322462': 4,
  '322463': 4,
  '322464': 4,
  '394902': 4,
};

function findDuration(id: number): number {
  const strId = id.toString();
  if (strId in MANUAL_DURATION_OVERRIDES) {
    return MANUAL_DURATION_OVERRIDES[strId];
  }

  const matchMiscInfo = spellMiscBySpellId.get(id);
  if (!matchMiscInfo) {
    console.log(`Missing duration ${id}`);
    return 0;
  }

  const maybeMatch = spellDurationById.get(matchMiscInfo.durationId);
  return (maybeMatch ?? 0) / 1000; // if spell has no duration (is instant) this field will just not be in the array
}

function findDispelType(id: number): 'Magic' | 'Curse' | 'Disease' | 'Poison' | null {
  const info = spellCategoriesBySpellId.get(id);
  if (!info) return null;
  return DISPEL_TYPE_MAP[info.dispelType] ?? null;
}

function findCharges(id: number) {
  const spellCategoryInfo = spellCategoriesBySpellId.get(id);
  if (!spellCategoryInfo) return;

  const categoryInfo = spellCategoryById.get(spellCategoryInfo.chargeCategoryId);

  return categoryInfo?.maxCharges
    ? { charges: categoryInfo.maxCharges, chargeCooldownSeconds: categoryInfo.chargeRecoveryTime / 1000 }
    : undefined;
}

function buildIndexes() {
  spellNames.forEach((row) => {
    spellNameById.set(row.id, row.name);
  });

  spellCDs.forEach((row) => {
    const current = spellCooldownBySpellId.get(row.spellId);
    spellCooldownBySpellId.set(row.spellId, choosePreferredByDifficulty(current, row));
  });

  spellMiscInfo.forEach((row) => {
    const current = spellMiscBySpellId.get(row.spellId);
    spellMiscBySpellId.set(row.spellId, choosePreferredByDifficulty(current, row));
  });

  spellCategories.forEach((row) => {
    const current = spellCategoriesBySpellId.get(row.spellId);
    // Keep dispelType from the base (difficulty=0) entry when available
    const chosen = choosePreferredByDifficulty(current, row);
    // If we already have a non-zero dispelType from any row, preserve it
    if (current && current.dispelType !== 0 && chosen.dispelType === 0) {
      spellCategoriesBySpellId.set(row.spellId, { ...chosen, dispelType: current.dispelType });
    } else {
      spellCategoriesBySpellId.set(row.spellId, chosen);
    }
  });

  spellCategory.forEach((row) => {
    spellCategoryById.set(row.id, { maxCharges: row.maxCharges, chargeRecoveryTime: row.chargeRecoveryTime });
  });

  spellDurations.forEach((row) => {
    spellDurationById.set(row.id, row.durationMs);
  });
  spellCastTimes.forEach((row) => {
    spellCastTimeById.set(row.id, { baseMs: row.baseMs, minimumMs: row.minimumMs });
  });
  spellEffects.forEach((row) => {
    spellEffectsBySpellId.set(row.spellId, (spellEffectsBySpellId.get(row.spellId) || 0) + 1);
  });
}

async function main() {
  console.log(`Loading data files from wago.tools (build=${WAGO_BUILD})`);
  await loadFiles();
  buildIndexes();
  console.log(
    `Loaded tables: cooldowns=${spellCDs.length} categories=${spellCategory.length} categoryLinks=${spellCategories.length} castTimes=${spellCastTimes.length} effects=${spellEffects.length} names=${spellNames.length} durations=${spellDurations.length} misc=${spellMiscInfo.length}`,
  );

  console.log('Parsing spells');
  let withCastTimeMetadata = 0;
  let withEffectRows = 0;
  spellIds.forEach((spellId) => {
    const spellIdInt = Number.parseInt(spellId, 10);
    const miscInfo = spellMiscBySpellId.get(spellIdInt);
    if (miscInfo?.castingTimeId && spellCastTimeById.has(miscInfo.castingTimeId)) {
      withCastTimeMetadata += 1;
    }
    if ((spellEffectsBySpellId.get(spellIdInt) || 0) > 0) {
      withEffectRows += 1;
    }
    newEffectsLibrary[spellId] = {
      spellId,
      name: findName(spellIdInt),
      cooldownSeconds: findCooldown(spellIdInt),
      charges: findCharges(spellIdInt),
      durationSeconds: findDuration(spellIdInt),
      dispelType: findDispelType(spellIdInt),
    };

    // For spells that have charges the baseline cooldown is effectively junk data
    // see https://www.wowhead.com/spell=33206/pain-suppression
    // Listed cooldown of 1.5s which is nonsense
    newEffectsLibrary[spellId].cooldownSeconds =
      newEffectsLibrary[spellId].charges?.chargeCooldownSeconds || newEffectsLibrary[spellId].cooldownSeconds;
  });
  console.log(`Coverage for tracked spell ids: castTimeMetadata=${withCastTimeMetadata} effectRows=${withEffectRows}`);

  // B148 safety: an offensive-tagged spell with a real cooldown but no buff duration produces a
  // zero-width buff that truncates enemy burst windows at its own cast instant (the runtime
  // DEFAULT_BUFF_SECONDS workaround was removed in favor of correct data — keep the data correct).
  const offensiveNoDuration = taggedSpellIds.filter((id) => {
    const tag = (taggedSpellsDump as Record<string, { type?: string }>)[id]?.type;
    if (tag !== 'buffs_offensive' && tag !== 'debuffs_offensive') return false;
    const e = newEffectsLibrary[id];
    const cd = e?.charges?.chargeCooldownSeconds ?? e?.cooldownSeconds ?? 0;
    return cd >= 30 && cd <= 360 && !e?.durationSeconds;
  });
  if (offensiveNoDuration.length > 0) {
    console.warn(
      `⚠️  B148: ${offensiveNoDuration.length} offensive-tagged CDs have no buff duration and will truncate ` +
        `burst windows at their own cast instant: ${offensiveNoDuration
          .map((id) => `${id} (${newEffectsLibrary[id]?.name})`)
          .join(', ')} — add MANUAL_DURATION_OVERRIDES entries before shipping this regen.`,
    );
  }

  // F143 Grounding Totem absorb feature (commit 21ee6dcd) hand-added spell 204336 to
  // spellEffects.json because upstream data doesn't carry it under a tracked spell id.
  // Commit de7f5765's regen silently dropped it (it isn't in `spellIds`/wago source),
  // killing all `[CD] … Grounding Totem` lines and `[ABSORBED: …]` annotations
  // (268 games → 0 in the 2026-07-09 week-eval corpus that caught this). Re-apply it
  // here, after the main build, so future regens can't drop it again.
  const HAND_CURATED_EFFECTS: Record<string, ISpellDbEntry> = {
    '204336': { spellId: '204336', name: 'Grounding Totem', cooldownSeconds: 30, durationSeconds: 3, dispelType: null },
  };
  for (const [id, entry] of Object.entries(HAND_CURATED_EFFECTS)) {
    newEffectsLibrary[id] = entry;
  }

  console.log('Writing updated spell effects data');
  const outputPath = path.resolve(__dirname, '../../shared/src/data/spellEffects.json');
  await fs.writeFile(outputPath, JSON.stringify(newEffectsLibrary, null, 2));
}

main();
