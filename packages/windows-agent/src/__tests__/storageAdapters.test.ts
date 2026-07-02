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
