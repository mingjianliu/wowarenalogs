import fs from 'fs-extra';
import path from 'path';

export interface CollectorStatus {
  phase: 'idle' | 'collecting' | 'analyzing';
  updatedAt: string;
  detail: string;
}

export interface RunRecord {
  startedAt: string;
  finishedAt: string;
  segmentsFetched: number;
  bytesAppended: number;
  filesUpdated: string[];
  gaps: string[];
  analysisExitCode: number | null;
  error: string | null;
}

export function writeStatus(syncDir: string, status: CollectorStatus): void {
  const p = path.join(syncDir, 'status.json');
  fs.ensureDirSync(syncDir);
  fs.writeJsonSync(`${p}.tmp`, status, { spaces: 2 });
  fs.renameSync(`${p}.tmp`, p);
}

export function appendRun(syncDir: string, run: RunRecord): void {
  fs.ensureDirSync(syncDir);
  fs.appendFileSync(path.join(syncDir, 'runs.jsonl'), `${JSON.stringify(run)}\n`);
}

export function readRuns(syncDir: string, limit: number): RunRecord[] {
  const p = path.join(syncDir, 'runs.jsonl');
  if (!fs.pathExistsSync(p)) return [];
  const lines = fs.readFileSync(p, 'utf-8').split('\n').filter(Boolean);
  return lines.slice(-limit).flatMap((l) => {
    try {
      return [JSON.parse(l) as RunRecord];
    } catch {
      return [];
    }
  });
}
