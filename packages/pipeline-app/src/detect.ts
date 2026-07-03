import { existsSync, readdirSync } from 'fs';

export interface FsProbe {
  exists(p: string): boolean;
  listDir(p: string): string[];
}

export function realFsProbe(): FsProbe {
  return {
    exists: (p) => existsSync(p),
    listDir: (p) => {
      try {
        return readdirSync(p);
      } catch {
        return [];
      }
    },
  };
}

export function detectSyncFolderCandidates(opts: {
  platform: NodeJS.Platform;
  home: string;
  probe: FsProbe;
}): string[] {
  const { platform, home, probe } = opts;
  if (platform === 'darwin') {
    const cloudStorage = `${home}/Library/CloudStorage`;
    return probe
      .listDir(cloudStorage)
      .filter((name) => name.startsWith('GoogleDrive-'))
      .map((name) => `${cloudStorage}/${name}/My Drive`)
      .filter((p) => probe.exists(p));
  }
  if (platform === 'win32') {
    const candidates: string[] = [];
    for (let c = 'G'.charCodeAt(0); c <= 'Z'.charCodeAt(0); c++) {
      const p = `${String.fromCharCode(c)}:\\My Drive`;
      if (probe.exists(p)) candidates.push(p);
    }
    const homeDrive = `${home}\\My Drive`;
    if (probe.exists(homeDrive)) candidates.push(homeDrive);
    return candidates;
  }
  return [];
}

export function detectWowDirCandidates(opts: { platform: NodeJS.Platform; probe: FsProbe }): string[] {
  if (opts.platform !== 'win32') return [];
  return [
    'C:\\Program Files (x86)\\World of Warcraft\\_retail_',
    'C:\\Program Files\\World of Warcraft\\_retail_',
  ].filter((dir) => opts.probe.exists(dir) && opts.probe.exists(`${dir}\\Logs`));
}
