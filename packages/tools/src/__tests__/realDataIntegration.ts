/* eslint-disable no-console */
import fetch from 'node-fetch';

import { buildMatchPromptNew, fetchStubs, parseLogText } from '../printMatchPrompts';

/**
 * Real-Data Integration Test
 *
 * Downloads 1 recent match from the production API, parses it,
 * and runs it through the full prompt-building pipeline.
 */
async function run() {
  console.log('--- Real-Data Integration Test ---');

  try {
    console.log('Fetching 1 recent Solo Shuffle stub...');
    const stubs = await fetchStubs('Rated Solo Shuffle', 1);

    if (stubs.length === 0) {
      console.warn('No recent matches found. Trying 3v3...');
      const fallbackStubs = await fetchStubs('3v3', 1);
      if (fallbackStubs.length === 0) {
        throw new Error('API returned no matches for Shuffle or 3v3. Is the API down?');
      }
      stubs.push(...fallbackStubs);
    }

    const stub = stubs[0];
    console.log(`Downloading log for match ${stub.id}...`);
    const resp = await fetch(stub.logObjectUrl);
    if (!resp.ok) {
      throw new Error(`Failed to download log: ${resp.status} ${resp.statusText}`);
    }

    const text = await resp.text();
    console.log(`Downloaded ${text.length} bytes. Parsing...`);

    const combats = await parseLogText(text);
    console.log(`Parsed ${combats.length} combat segment(s).`);

    if (combats.length === 0) {
      throw new Error('No valid combat segments found in real log data.');
    }

    const combat = combats[0];
    console.log(`Processing segment 1 (${(combat.endTime - combat.startTime) / 1000}s duration)...`);

    const prompt = buildMatchPromptNew(combat);

    console.log('--- Pipeline Output Verification ---');

    // Core sanity checks on the generated prompt
    const checks = [
      { key: 'metadata', exists: prompt.includes('<metadata>') },
      { key: 'player_loadout', exists: prompt.includes('<player_loadout>') },
      { key: 'match_timeline', exists: prompt.includes('<match_timeline>') },
      { key: '[MATCH END]', exists: prompt.includes('[MATCH END]') },
      { key: 'No NaN values', exists: !prompt.includes('NaN') },
      { key: 'No undefined labels', exists: !prompt.includes('undefined') },
      { key: 'Duration is positive', exists: !prompt.includes('Duration: 0:00') },
    ];

    let allPassed = true;
    for (const check of checks) {
      if (!check.exists) {
        console.error(`❌ FAIL: ${check.key} check failed!`);
        allPassed = false;
      } else {
        console.log(`✅ PASS: ${check.key}`);
      }
    }

    if (!allPassed) {
      console.log('\n--- FULL PROMPT FOR DEBUGGING ---');
      console.log(prompt);
      console.log('--------------------------------\n');
      process.exit(1);
    }

    console.log('\nIntegration Test SUCCESS: Real-world log processed through full AI pipeline without errors.');
  } catch (err) {
    console.error('❌ Integration Test FAILED with error:');
    console.error(err);
    process.exit(1);
  }
}

run();
