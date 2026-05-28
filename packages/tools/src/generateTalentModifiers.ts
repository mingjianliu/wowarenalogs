/* eslint-disable no-console */
import fs from 'fs-extra';
import fetch from 'node-fetch';
import path from 'path';

import talentIdMap from '../../shared/src/data/talentIdMap.json';
import { CUSTOM_TALENT_MODIFIERS } from './customTalentModifiers';
import { WAGO_BUILD, withBuild } from './wagoConfig';

// ── Configuration ───────────────────────────────────────────────────

const SOURCE_TABLES = {
  spellEffect: withBuild('SpellEffect'),
  spellClassOptions: withBuild('SpellClassOptions'),
  spellCategories: withBuild('SpellCategories'),
  spellName: withBuild('SpellName'),
};

const EFFECT_MOD_CHARGES = 121;
const EFFECT_MOD_COOLDOWN = 148;
const EFFECT_APPLY_AURA = 6;

const AURA_MOD_MAX_CHARGES = 411;
const AURA_MOD_COOLDOWN = 108;
const AURA_MOD_RECOVERY_SPEED = 107;
const AURA_MOD_CATEGORY_COOLDOWN = 453; // Matches ChargeCategory
const AURA_OVERRIDE_ACTION_SPELL = 332; // Replaces base spell with another

// Mapping of ClassID to SpellFamilyName (SpellClassSet)
const CLASS_ID_TO_FAMILY: Record<number, number> = {
  1: 4, // Warrior
  2: 10, // Paladin
  3: 9, // Hunter
  4: 8, // Rogue
  5: 6, // Priest
  6: 15, // Death Knight
  7: 11, // Shaman
  8: 3, // Mage
  9: 5, // Warlock
  10: 126, // Monk
  11: 7, // Druid
  12: 127, // Demon Hunter
  13: 128, // Evoker
};

type CsvRow = Record<string, string>;

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
  console.log(`  Downloading ${url.split('/db2/')[1]?.split('/csv')[0] ?? url} ...`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}. HTTP ${response.status}`);
  }
  const csv = await response.text();
  return parseCsv(csv);
}

function toInt(value: string): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

interface ICDModifier {
  talentSpellId: string;
  effect: 'extra_charge' | 'reduce_cd' | 'replace_spell';
  value: number;
  isConditional?: boolean;
}

async function main() {
  console.log(`Downloading DB2 CSVs from wago.tools (build=${WAGO_BUILD})\n`);

  const [spellEffectRows, spellClassOptionsRows, spellCategoriesRows, spellNameRows] = await Promise.all([
    loadCsv(SOURCE_TABLES.spellEffect),
    loadCsv(SOURCE_TABLES.spellClassOptions),
    loadCsv(SOURCE_TABLES.spellCategories),
    loadCsv(SOURCE_TABLES.spellName),
  ]);

  const spellNames = new Map<string, string>();
  for (const row of spellNameRows) {
    spellNames.set(row.ID, row.Name_lang || '');
  }

  // 1. Index all player talent spell IDs and their class IDs
  const talentClassMap = new Map<string, number>();
  for (const tree of talentIdMap) {
    const classId = tree.classId as number;
    const allNodes = [...(tree.classNodes || []), ...(tree.specNodes || [])];
    for (const node of allNodes) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const entry of (node as any).entries || []) {
        const spellId = String(entry.spellId || entry.visibleSpellId || '');
        if (spellId && spellId !== '0') {
          talentClassMap.set(spellId, classId);
        }
      }
    }
  }

  // 2. Index target spells by their class mask
  const targetSpellMasks = new Map<string, { family: number; masks: number[] }>();
  for (const row of spellClassOptionsRows) {
    const spellId = row.SpellID;
    if (!spellId || spellId === '0') continue;
    targetSpellMasks.set(spellId, {
      family: toInt(row.SpellClassSet),
      masks: [
        toInt(row.SpellClassMask_0),
        toInt(row.SpellClassMask_1),
        toInt(row.SpellClassMask_2),
        toInt(row.SpellClassMask_3),
      ],
    });
  }

  // 3. Index target spells by their ChargeCategory
  const chargeCategorySpells = new Map<number, string[]>();
  for (const row of spellCategoriesRows) {
    const spellId = row.SpellID;
    const chargeCategory = toInt(row.ChargeCategory);
    if (!spellId || chargeCategory === 0) continue;

    if (!chargeCategorySpells.has(chargeCategory)) {
      chargeCategorySpells.set(chargeCategory, []);
    }
    const categoryTargets = chargeCategorySpells.get(chargeCategory);
    if (categoryTargets) {
      categoryTargets.push(spellId);
    }
  }

  const results: Record<string, ICDModifier[]> = {};

  function addModifier(targetSpellId: string, mod: ICDModifier) {
    if (!results[targetSpellId]) {
      results[targetSpellId] = [];
    }
    // Avoid duplicates
    if (!results[targetSpellId].some((m) => m.talentSpellId === mod.talentSpellId && m.effect === mod.effect)) {
      results[targetSpellId].push(mod);
    }
  }

  // 4. Scan SpellEffect for modifiers
  for (const row of spellEffectRows) {
    const talentSpellId = row.SpellID;
    const talentClassInfo = talentClassMap.get(talentSpellId);
    if (!talentClassInfo) continue;

    const classId = talentClassInfo;
    const familyId = CLASS_ID_TO_FAMILY[classId];
    if (familyId === undefined) continue;

    const effect = toInt(row.Effect);
    const aura = toInt(row.EffectAura);
    const miscValue0 = toInt(row.EffectMiscValue_0);

    let modifierType: 'extra_charge' | 'reduce_cd' | 'replace_spell' | null = null;
    let value = toInt(row.EffectBasePointsF);

    if (effect === EFFECT_MOD_CHARGES || (effect === EFFECT_APPLY_AURA && aura === AURA_MOD_MAX_CHARGES)) {
      modifierType = 'extra_charge';
      value = Math.abs(value);
    } else if (
      effect === EFFECT_MOD_COOLDOWN ||
      (effect === EFFECT_APPLY_AURA &&
        (aura === AURA_MOD_COOLDOWN || aura === AURA_MOD_RECOVERY_SPEED || aura === AURA_MOD_CATEGORY_COOLDOWN))
    ) {
      modifierType = 'reduce_cd';
      value = Math.abs(value);
      // If it's reduction in ms, convert to seconds.
      // Reduction amounts > 500 are almost certainly ms.
      if (value > 500) {
        value = Math.round(value / 1000);
      }
    } else if (effect === EFFECT_APPLY_AURA && aura === AURA_OVERRIDE_ACTION_SPELL) {
      modifierType = 'replace_spell';
      // Replacement ID is in value
    }

    if (!modifierType) continue;

    const effectMasks = [
      toInt(row.EffectSpellClassMask_0),
      toInt(row.EffectSpellClassMask_1),
      toInt(row.EffectSpellClassMask_2),
      toInt(row.EffectSpellClassMask_3),
    ];

    const hasMask = effectMasks.some((m) => m !== 0);

    // Path A: Match via bitmask
    if (hasMask) {
      for (const [targetId, targetInfo] of targetSpellMasks.entries()) {
        if (targetInfo.family !== familyId) continue;

        const intersects =
          (effectMasks[0] & targetInfo.masks[0]) !== 0 ||
          (effectMasks[1] & targetInfo.masks[1]) !== 0 ||
          (effectMasks[2] & targetInfo.masks[2]) !== 0 ||
          (effectMasks[3] & targetInfo.masks[3]) !== 0;

        if (intersects) {
          addModifier(targetId, {
            talentSpellId,
            effect: modifierType,
            value,
          });
        }
      }
    }

    // Path B: Match via ChargeCategory (stored in MiscValue_0)
    const chargeTargets = chargeCategorySpells.get(miscValue0);
    if (miscValue0 > 0 && chargeTargets) {
      for (const targetId of chargeTargets) {
        addModifier(targetId, {
          talentSpellId,
          effect: modifierType,
          value,
        });
      }
    }

    // Path C: Direct Target Spell ID (stored in MiscValue_0)
    // Used for Effect 332 overrides (e.g. Ice Block -> Ice Cold)
    if (miscValue0 > 0 && !chargeCategorySpells.has(miscValue0)) {
      addModifier(String(miscValue0), {
        talentSpellId,
        effect: modifierType,
        value,
      });
    }
  }

  // 5. Merge Custom Modifiers
  for (const [targetId, mods] of Object.entries(CUSTOM_TALENT_MODIFIERS)) {
    mods.forEach((mod) => addModifier(targetId, mod));
  }

  // 6. Sanity filter: Only include modifiers for spells that are "important" enough to be tracked.
  const spellClassMapPath = path.resolve(__dirname, '../../shared/src/data/spellClassMap.json');
  const spellClassMap = await fs.readJson(spellClassMapPath);
  const trackedSpellIds = new Set<string>();
  ['bigDefensive', 'externalDefensive', 'important', 'interrupts'].forEach((cat) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (spellClassMap[cat] || []).forEach((e: any) => trackedSpellIds.add(e.spellId));
  });

  const filteredResults: Record<string, ICDModifier[]> = {};
  for (const [targetId, mods] of Object.entries(results)) {
    if (trackedSpellIds.has(targetId)) {
      filteredResults[targetId] = mods;
    }
  }

  console.log(`Generated talent modifiers for ${Object.keys(filteredResults).length} tracked spells.`);

  const outputPath = path.resolve(__dirname, '../../shared/src/data/talentModifiers.json');
  await fs.writeJson(outputPath, filteredResults, { spaces: 2 });
  console.log(`Wrote generated talent modifiers to ${outputPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
