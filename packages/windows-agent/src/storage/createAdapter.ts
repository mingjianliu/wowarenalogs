import { StorageConfig } from '../config';
import { GcsStorageAdapter } from './GcsStorageAdapter';
import { LocalDirStorageAdapter } from './LocalDirStorageAdapter';
import { StorageAdapter } from './StorageAdapter';

export function createAdapter(storage: StorageConfig): StorageAdapter {
  switch (storage.provider) {
    case 'gcs':
      return new GcsStorageAdapter({ bucket: storage.bucket, keyFilename: storage.keyFilename });
    case 'localDir':
      return new LocalDirStorageAdapter(storage.directory);
  }
}
