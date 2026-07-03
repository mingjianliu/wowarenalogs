import { detectSyncFolderCandidates, detectWowDirCandidates, FsProbe } from '../detect';

function probeOf(existing: string[], listings: Record<string, string[]> = {}): FsProbe {
  return {
    exists: (p) => existing.includes(p),
    listDir: (p) => listings[p] ?? [],
  };
}

describe('detectSyncFolderCandidates', () => {
  it('macOS: finds GoogleDrive-* CloudStorage mounts with My Drive', () => {
    const home = '/Users/me';
    const cs = '/Users/me/Library/CloudStorage';
    const probe = probeOf(['/Users/me/Library/CloudStorage/GoogleDrive-a@gmail.com/My Drive'], {
      [cs]: ['GoogleDrive-a@gmail.com', 'OneDrive-Personal'],
    });
    expect(detectSyncFolderCandidates({ platform: 'darwin', home, probe })).toEqual([
      '/Users/me/Library/CloudStorage/GoogleDrive-a@gmail.com/My Drive',
    ]);
  });
  it('windows: probes G:..Z: drive roots and the home fallback', () => {
    const probe = probeOf(['G:\\My Drive', 'H:\\My Drive', 'C:\\Users\\me\\My Drive']);
    expect(detectSyncFolderCandidates({ platform: 'win32', home: 'C:\\Users\\me', probe })).toEqual([
      'G:\\My Drive',
      'H:\\My Drive',
      'C:\\Users\\me\\My Drive',
    ]);
  });
  it('returns [] when nothing is found', () => {
    expect(detectSyncFolderCandidates({ platform: 'darwin', home: '/u', probe: probeOf([]) })).toEqual([]);
  });
});

describe('detectWowDirCandidates', () => {
  it('keeps only install dirs with an existing Logs subdir (win32)', () => {
    const withLogs = 'C:\\Program Files (x86)\\World of Warcraft\\_retail_';
    const probe = probeOf([withLogs, `${withLogs}\\Logs`, 'C:\\Program Files\\World of Warcraft\\_retail_']);
    expect(detectWowDirCandidates({ platform: 'win32', probe })).toEqual([withLogs]);
  });
  it('non-windows returns []', () => {
    expect(detectWowDirCandidates({ platform: 'darwin', probe: probeOf(['x']) })).toEqual([]);
  });
});
