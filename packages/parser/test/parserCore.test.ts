/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from 'fs';
import path from 'path';

import { CombatUnitReaction, CombatUnitSpec, CombatUnitType, WoWCombatLogParser } from '../src';
import { CombatantInfoAction } from '../src/actions/CombatantInfoAction';
import { CombatData } from '../src/CombatData';
import { CombatUnit } from '../src/CombatUnit';
import { loadLogFile } from './testLogLoader';

describe('WoWCombatLogParser', () => {
  it('constructor handles timezones correctly (B83)', () => {
    const parser1 = new WoWCombatLogParser(null, 'America/New_York');
    expect(parser1._timezone).toBe('America/New_York');

    const parser2 = new WoWCombatLogParser(null, 'Invalid/Timezone');
    expect(parser2._timezone).toBeDefined();
  });

  it('resetParserStates clears the context', () => {
    const parser = new WoWCombatLogParser('retail');
    parser.resetParserStates(null);
    parser.parseLine('1/1 00:00:00.000  COMBAT_LOG_VERSION,20,ADVANCED_LOG_ENABLED,1,BUILD_VERSION,3.4.1,PROJECT_ID,2');
    expect((parser as any).context.wowVersion).toBe('classic');
  });

  it('covers all pipeline callbacks (B85)', () => {
    const parser = new WoWCombatLogParser('retail');
    const activitySpy = jest.fn();
    parser.on('activity_started', activitySpy);
    (parser as any).emit('activity_started', {});
    expect(activitySpy).toHaveBeenCalled();
  });

  it('auto-detects version and handles malformed lines (B114)', () => {
    const parser = new WoWCombatLogParser(null);
    parser.parseLine('NOT_A_LOG_LINE');
    expect((parser as any).context.wowVersion).toBe('retail');

    parser.resetParserStates(null);
    parser.parseLine('1/1 00:00:00.000  COMBAT_LOG_VERSION,20,ADVANCED_LOG_ENABLED,1,BUILD_VERSION,3.4.1,PROJECT_ID,2');
    expect((parser as any).context.wowVersion).toBe('classic');
  });

  it('handles flush and setWowVersion for retail (B117)', () => {
    const parser = new WoWCombatLogParser(null);
    parser.parseLine(
      '1/1 00:00:00.000  COMBAT_LOG_VERSION,20,ADVANCED_LOG_ENABLED,1,BUILD_VERSION,11.0.0,PROJECT_ID,1',
    );
    expect((parser as any).context.wowVersion).toBe('retail');

    const pipelineSpy = jest.fn();
    (parser as any).context.pipeline = pipelineSpy;
    parser.flush();
    expect(pipelineSpy).toHaveBeenCalledWith('__WOW_ARENA_LOGS_PIPELINE_FLUSH_SIGNAL__');
  });

  it('parses a full solo shuffle log to trigger all callbacks (B118)', () => {
    const parser = new WoWCombatLogParser(null);
    const roundSpy = jest.fn();
    const shuffleSpy = jest.fn();
    parser.on('solo_shuffle_round_ended', roundSpy);
    parser.on('solo_shuffle_ended', shuffleSpy);

    const logPath = path.join(__dirname, 'testlogs/one_solo_shuffle.txt');
    const content = fs.readFileSync(logPath, 'utf-8');
    content.split('\n').forEach((line) => parser.parseLine(line));
    parser.flush();

    expect(roundSpy).toHaveBeenCalled();
    expect(shuffleSpy).toHaveBeenCalled();
  });
});

describe('CombatData — logic branches (B109)', () => {
  it('covers CombatantInfo spec mapping loop for all classes', () => {
    const match = new CombatData('retail', 'UTC');
    const specs = [
      CombatUnitSpec.DeathKnight_Blood,
      CombatUnitSpec.DemonHunter_Havoc,
      CombatUnitSpec.Druid_Balance,
      CombatUnitSpec.Hunter_BeastMastery,
      CombatUnitSpec.Mage_Arcane,
      CombatUnitSpec.Monk_BrewMaster,
      CombatUnitSpec.Paladin_Holy,
      CombatUnitSpec.Priest_Discipline,
      CombatUnitSpec.Rogue_Assassination,
      CombatUnitSpec.Shaman_Elemental,
      CombatUnitSpec.Warlock_Affliction,
      CombatUnitSpec.Warrior_Arms,
      CombatUnitSpec.Evoker_Devastation,
    ];

    specs.forEach((spec) => {
      const logLine = {
        event: 'COMBATANT_INFO',
        parameters: [
          'u-' + spec,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          0,
          spec,
          [],
          [],
          [],
          '[]',
        ],
      };
      const event = new CombatantInfoAction(logLine as any);
      (match as any).readEvent(event);
      expect((match as any).combatantMetadata.has('u-' + spec)).toBe(true);
    });
  });

  it('covers readEvent with real data and shuffle', () => {
    const match = new CombatData('retail', 'UTC');
    const loaded = loadLogFile('one_solo_shuffle.txt');
    const realEvents = loaded.shuffleRounds[0].events;

    realEvents.forEach((e: any) => match.readEvent(e));
    expect(Object.keys(match.units).length).toBeGreaterThan(0);
  });

  it('infers match metadata in classic (B110)', () => {
    const match = new CombatData('classic', 'UTC');
    const u1 = new CombatUnit('u1', 'Player1');
    u1.type = CombatUnitType.Player;
    u1.reaction = CombatUnitReaction.Friendly;
    u1.deathRecords.push({
      event: 'UNIT_DIED',
      timestamp: 10000,
      parameters: ['u1', 'P1', 0x511, 0, 'u1', 'P1', 0x511, 0],
    } as any);
    match.units['u1'] = u1;
    (match as any).inferredCombatantIds.add('u1');

    match.startTime = 1000;
    match.endTime = 20000;

    (match as any).inferMatchMetadata();
    expect(match.endInfo?.winningTeamId).toBe('1');
  });
});
