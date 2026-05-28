import fs from 'fs-extra';
import fetch from 'node-fetch';
import os from 'os';
import path from 'path';

const GLOBAL_CACHE_ROOT = path.join(os.homedir(), '.wowarenalogs/eval-cache');
const CACHE_DIR = path.join(GLOBAL_CACHE_ROOT, 'logs');
const MANIFEST_FILE = path.join(GLOBAL_CACHE_ROOT, 'log_manifest.json');
const TTL_DAYS = 7;

interface ManifestEntry {
  matchId: string;
  logObjectUrl: string;
  downloadedAt: string;
  logFile: string;
}

type Manifest = Record<string, ManifestEntry>;

export class LogCache {
  private manifest: Manifest | null = null;
  private isInitialized = false;

  async init() {
    if (this.isInitialized) return;
    await fs.ensureDir(CACHE_DIR);
    try {
      this.manifest = await fs.readJson(MANIFEST_FILE);
    } catch {
      this.manifest = {};
    }
    await this.prune();
    this.isInitialized = true;
  }

  async prune() {
    if (!this.manifest) return;
    const cutoffMs = Date.now() - TTL_DAYS * 24 * 60 * 60 * 1000;
    let prunedCount = 0;

    for (const [id, entry] of Object.entries(this.manifest)) {
      if (new Date(entry.downloadedAt).getTime() < cutoffMs) {
        try {
          await fs.remove(entry.logFile);
        } catch {
          // already gone
        }
        delete this.manifest[id];
        prunedCount++;
      }
    }

    if (prunedCount > 0) {
      console.error(`  Pruned ${prunedCount} cached log(s) older than ${TTL_DAYS} days`);
      await this.saveManifest();
    }
  }

  private async saveManifest() {
    if (!this.manifest) return;
    await fs.writeJson(MANIFEST_FILE, this.manifest, { spaces: 2 });
  }

  async getLogText(matchId: string, logObjectUrl: string): Promise<string> {
    await this.init();
    if (!this.manifest) throw new Error('Cache not initialized');

    const entry = this.manifest[matchId];
    if (entry) {
      try {
        const text = await fs.readFile(entry.logFile, 'utf-8');
        return text;
      } catch {
        // If file doesn't exist, we will download it again
      }
    }

    // Download
    const res = await fetch(logObjectUrl);
    if (!res.ok) throw new Error(`GCS ${res.status}: ${res.statusText}`);
    const text = await res.text();

    const logFile = path.join(CACHE_DIR, `${matchId}.log`);
    await fs.writeFile(logFile, text, 'utf-8');

    this.manifest[matchId] = {
      matchId,
      logObjectUrl,
      downloadedAt: new Date().toISOString(),
      logFile,
    };

    await this.saveManifest();
    return text;
  }
}

export const logCache = new LogCache();
