import fs from 'fs-extra';
import * as luainjs from 'lua-in-js';
import fetch from 'node-fetch';
import path from 'path';

import taggedSpellsDump from '../../shared/src/data/spells.json';
import { WAGO_BUILD, WAGO_DB2_BASE } from './wagoConfig';

function extractSpellIdsFromSpellCsv(csv: string): Set<string> {
  const ids = new Set<string>();
  const matches = csv.matchAll(/(?:^|\n)(\d+),/g);
  for (const match of matches) {
    ids.add(match[1]);
  }
  return ids;
}

async function main() {
  const spellCsvResponse = await fetch(`${WAGO_DB2_BASE}/Spell/csv?build=${encodeURIComponent(WAGO_BUILD)}`);
  if (spellCsvResponse.status !== 200) {
    throw new Error(`Failed to fetch Spell.csv: ${spellCsvResponse.status} ${spellCsvResponse.statusText}`);
  }
  const spellCsv = await spellCsvResponse.text();
  const validSpellIds = extractSpellIdsFromSpellCsv(spellCsv);

  const response = await fetch('https://raw.githubusercontent.com/jordonwow/bigdebuffs/v59/BigDebuffs_Mainline.lua');
  if (response.status !== 200) {
    throw new Error(`Failed to fetch BigDebuffs_Mainline.lua: ${response.status} ${response.statusText}`);
  }

  let text = await response.text();
  // do some necessary post-processing to make the lua parseable
  text = text.replace('local addonName, addon = ...', 'local addon = {}');
  text = text + '\nreturn addon';

  // execute the lua script and get the addon table
  const lua = luainjs.createEnv();
  const addon = (lua.parse(text).exec() as luainjs.Table).toObject() as Record<string, unknown>;

  const rawSpellsData = addon['Spells'] as Record<string, unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const spells = { ...taggedSpellsDump } as Record<string, any>;
  Object.keys(rawSpellsData).forEach((spellId) => {
    if (rawSpellsData[spellId]) {
      const normalizedSpellId = (parseInt(spellId, 10) + 1).toFixed();
      if (validSpellIds.has(normalizedSpellId)) {
        const spellEntry = rawSpellsData[spellId] as { type?: string; parent?: number };

        const existing = spells[normalizedSpellId];
        if (existing) {
          spells[normalizedSpellId] = {
            ...existing,
            ...spellEntry,
            type: existing.type || spellEntry.type,
          };
        } else {
          spells[normalizedSpellId] = spellEntry;
        }
      }
    }
  });

  // B147: healer throughput/utility CDs mis-tagged `buffs_offensive` upstream (BigDebuffs) — they are
  // not burst enablers and were creating false enemy "burst windows". Applied AFTER the merge so the
  // correction wins regardless of what the previous dump or BigDebuffs carries (the pre-merge variant
  // of this override was silently defeated by `type: existing.type || spellEntry.type`).
  const TAG_OVERRIDES: Record<string, string> = {
    '33891': 'buffs_defensive', // Incarnation: Tree of Life (Resto Druid healing CD)
    '132158': 'buffs_other', // Nature's Swiftness (instant utility/heal enabler)
    '378081': 'buffs_other', // Nature's Swiftness (variant id)
    // 2026-07-07 corpus audit: top false solo "burst windows" — utility CDs, zero damage output
    '414664': 'buffs_other', // Mass Invisibility (stealth utility; 300s CD alone qualified it as a solo window in 235/1151 corpus games)
    '29166': 'buffs_other', // Innervate (ally mana regen)
  };
  for (const [id, type] of Object.entries(TAG_OVERRIDES)) {
    if (spells[id]) {
      spells[id] = { ...spells[id], type };
    }
  }

  const outputPath = path.resolve(__dirname, '../../shared/src/data/spells.json');
  await fs.writeFile(outputPath, JSON.stringify(spells, null, 2));
}

main();
