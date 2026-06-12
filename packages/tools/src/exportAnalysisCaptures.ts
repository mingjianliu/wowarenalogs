/* eslint-disable no-console */
/**
 * exportAnalysisCaptures.ts — pull the production AI-analysis capture corpus locally.
 *
 * Reads the `ai-analysis-logs-prod` Firestore collection (written by /api/analyze) and
 * writes one JSON object per line to a local JSONL file for offline prompt optimization.
 * With --with-logs, also downloads each record's GCS raw-log snapshot.
 *
 * Output (gitignored):
 *   packages/tools/analysis-captures/captures.jsonl
 *   packages/tools/analysis-captures/logs/{captureId}.log   (only with --with-logs)
 *
 * Prerequisites:
 *   Application-default credentials for the `wowarenalogs` project:
 *     gcloud auth application-default login   (or GOOGLE_APPLICATION_CREDENTIALS=<sa-key.json>)
 *
 * Usage:
 *   npm run -w @wowarenalogs/tools start:exportAnalysisCaptures
 *   npm run -w @wowarenalogs/tools start:exportAnalysisCaptures -- --with-logs
 */

import { Firestore } from '@google-cloud/firestore';
import { Storage } from '@google-cloud/storage';
import fs from 'fs-extra';
import path from 'path';

const COLLECTION = 'ai-analysis-logs-prod';
const OUT_DIR = path.join(__dirname, '..', 'analysis-captures');
const OUT_FILE = path.join(OUT_DIR, 'captures.jsonl');
const LOG_DIR = path.join(OUT_DIR, 'logs');

async function main() {
  const withLogs = process.argv.includes('--with-logs');
  const firestore = new Firestore({ projectId: 'wowarenalogs' });
  const storage = new Storage({ projectId: 'wowarenalogs' });

  await fs.ensureDir(OUT_DIR);
  if (withLogs) await fs.ensureDir(LOG_DIR);

  const snap = await firestore.collection(COLLECTION).orderBy('timestamp', 'asc').get();
  console.log(`Found ${snap.size} capture(s) in ${COLLECTION}`);

  const lines: string[] = [];
  let logCount = 0;
  for (const doc of snap.docs) {
    const data = doc.data();
    lines.push(JSON.stringify(data));

    if (withLogs && typeof data.rawLogSnapshotUrl === 'string' && data.rawLogSnapshotUrl.startsWith('gs://')) {
      try {
        const without = data.rawLogSnapshotUrl.replace('gs://', '');
        const bucketName = without.slice(0, without.indexOf('/'));
        const objectPath = without.slice(without.indexOf('/') + 1);
        const dest = path.join(LOG_DIR, `${data.captureId}.log`);
        await storage.bucket(bucketName).file(objectPath).download({ destination: dest });
        logCount += 1;
      } catch (err) {
        console.warn(`  skip log for ${data.captureId}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  await fs.writeFile(OUT_FILE, lines.join('\n') + (lines.length ? '\n' : ''));
  console.log(`Wrote ${lines.length} record(s) → ${OUT_FILE}`);
  if (withLogs) console.log(`Downloaded ${logCount} raw-log snapshot(s) → ${LOG_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
