import { readFileSync, renameSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';

import { CollectorConfig } from '../../tools/src/collect/collectorConfig';
import { AgentConfig, StorageConfig } from '../../windows-agent/src/config';

export type PilotRole = 'streamer' | 'collector';

export interface PilotConfig {
  role?: PilotRole;
  syncFolder: string;
  wowDirectory?: string;
  hostname: string;
  flushIntervalMs: number;
  quietPeriodMs: number;
  ignoreOlderDays: number;
  scheduleHours: number;
  cleanupAfterDays: number;
  storage?: { provider: 'gcs'; bucket: string; keyFilename: string };
}

const DEFAULTS = {
  flushIntervalMs: 60000,
  quietPeriodMs: 30000,
  ignoreOlderDays: 7,
  scheduleHours: 6,
  cleanupAfterDays: 14,
};

export function withDefaults(partial: Partial<PilotConfig> & { syncFolder: string }): PilotConfig {
  return {
    ...DEFAULTS,
    hostname: os.hostname(),
    ...partial,
    syncFolder: partial.syncFolder,
  };
}

export function configPathFor(userDataDir: string): string {
  return process.env.WAL_PILOT_CONFIG ?? path.join(userDataDir, 'wal-pilot.config.json');
}

export function loadPilotConfig(configPath: string): PilotConfig | null {
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch {
    return null; // absent → first-run wizard
  }
  try {
    return withDefaults(JSON.parse(raw) as Partial<PilotConfig> & { syncFolder: string });
  } catch {
    throw new Error(`Malformed config JSON: ${configPath}`);
  }
}

export function savePilotConfig(configPath: string, cfg: PilotConfig): void {
  const tmp = `${configPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  renameSync(tmp, configPath);
}

export function resolveRole(cfg: PilotConfig, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): PilotRole {
  const envRole = env.WAL_PILOT_ROLE;
  if (envRole !== undefined) {
    if (envRole !== 'streamer' && envRole !== 'collector') {
      throw new Error(`WAL_PILOT_ROLE must be "streamer" or "collector", got "${envRole}"`);
    }
    return envRole;
  }
  if (cfg.role) return cfg.role;
  return platform === 'win32' ? 'streamer' : 'collector';
}

export function storageConfigOf(cfg: PilotConfig): StorageConfig {
  return cfg.storage ?? { provider: 'localDir', directory: cfg.syncFolder };
}

export function toAgentConfig(cfg: PilotConfig): AgentConfig {
  if (!cfg.wowDirectory) throw new Error('Config error: "wowDirectory" is required for the streamer role');
  return {
    wowDirectory: cfg.wowDirectory,
    hostname: cfg.hostname,
    flushIntervalMs: cfg.flushIntervalMs,
    quietPeriodMs: cfg.quietPeriodMs,
    ignoreOlderDays: cfg.ignoreOlderDays,
    storage: storageConfigOf(cfg),
  };
}

export function toCollectorConfig(cfg: PilotConfig, syncDir: string): CollectorConfig {
  return { storage: storageConfigOf(cfg), syncDir };
}
