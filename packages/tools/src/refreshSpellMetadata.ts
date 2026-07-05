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

        // B147 Healer CD tags override (Tree of Life + Nature's Swiftness)
        if (normalizedSpellId === '33891') {
          spellEntry.type = 'buffs_defensive';
        } else if (normalizedSpellId === '132158' || normalizedSpellId === '378081') {
          spellEntry.type = 'buffs_other';
        }

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

  const outputPath = path.resolve(__dirname, '../../shared/src/data/spells.json');
  await fs.writeFile(outputPath, JSON.stringify(spells, null, 2));
}

main();
