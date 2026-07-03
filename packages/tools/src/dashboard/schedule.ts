import fs from 'fs-extra';
import os from 'os';
import path from 'path';

const PLIST_PATH = path.join(os.homedir(), 'Library/LaunchAgents/com.wowarenalogs.collect.plist');

export function readScheduleInterval(): number | null {
  if (!fs.pathExistsSync(PLIST_PATH)) return null;
  const m = /<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/.exec(fs.readFileSync(PLIST_PATH, 'utf-8'));
  return m ? parseInt(m[1], 10) : null;
}

export function nextRunAt(lastRunAt: string | null, intervalSeconds: number | null): string | null {
  if (!lastRunAt || !intervalSeconds) return null;
  return new Date(new Date(lastRunAt).getTime() + intervalSeconds * 1000).toISOString();
}
