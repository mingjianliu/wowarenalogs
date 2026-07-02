import fs from 'fs-extra';
import os from 'os';
import path from 'path';

import { StorageConfig } from '../../../windows-agent/src/config';

export interface CollectorConfig {
  storage: StorageConfig;
  syncDir: string;
}

export function syncDirPath(): string {
  return process.env.WAL_SYNC_DIR ?? path.join(os.homedir(), 'wal-sync');
}

export function loadCollectorConfig(): CollectorConfig {
  const syncDir = syncDirPath();
  const configPath = path.join(syncDir, 'collector.config.json');
  if (!fs.pathExistsSync(configPath)) {
    throw new Error(
      `Collector config not found: ${configPath}\n` +
        `Create it, e.g. { "storage": { "provider": "gcs", "bucket": "YOUR-BUCKET", "keyFilename": "${path.join(
          syncDir,
          'reader-key.json',
        )}" } }`,
    );
  }
  const json = fs.readJsonSync(configPath) as { storage?: StorageConfig };
  if (!json.storage) throw new Error(`Collector config error: "storage" block is required in ${configPath}`);
  return { storage: json.storage, syncDir };
}
