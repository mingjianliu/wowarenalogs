import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { describeStorageAdapterContract } from '../storage/adapterContract';
import { LocalDirStorageAdapter } from '../storage/LocalDirStorageAdapter';
import { MemoryStorageAdapter } from '../storage/MemoryStorageAdapter';

describeStorageAdapterContract('MemoryStorageAdapter', async () => new MemoryStorageAdapter());
describeStorageAdapterContract(
  'LocalDirStorageAdapter',
  async () => new LocalDirStorageAdapter(mkdtempSync(join(tmpdir(), 'wal-store-'))),
);

describe('LocalDirStorageAdapter concurrent puts', () => {
  it('same-key concurrent puts do not corrupt or throw', async () => {
    const adapter = new LocalDirStorageAdapter(mkdtempSync(join(tmpdir(), 'wal-store-')));
    await Promise.all([
      adapter.put('k/same', Buffer.from('aaaa')),
      adapter.put('k/same', Buffer.from('bbbb')),
      adapter.put('k/same', Buffer.from('cccc')),
    ]);
    const result = (await adapter.get('k/same')).toString();
    expect(['aaaa', 'bbbb', 'cccc']).toContain(result); // one winner, intact
    expect(await adapter.list('k/')).toEqual(['k/same']); // no tmp leftovers
  });
});
