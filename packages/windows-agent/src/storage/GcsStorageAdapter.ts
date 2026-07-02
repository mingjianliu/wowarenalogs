import { Storage } from '@google-cloud/storage';

import { StorageAdapter } from './StorageAdapter';

/** Structural subset of the GCS SDK we use — lets tests inject a stub. */
export interface GcsClientLike {
  bucket(name: string): {
    file(key: string): {
      save(body: Buffer, opts: { resumable: boolean }): Promise<void>;
      download(): Promise<[Buffer]>;
    };
    getFiles(opts: { prefix: string }): Promise<[{ name: string }[]]>;
  };
}

export interface GcsStorageConfig {
  bucket: string;
  /** Path to a service-account JSON key. Omit to use ambient ADC credentials. */
  keyFilename?: string;
}

export class GcsStorageAdapter implements StorageAdapter {
  private bucketRef: ReturnType<GcsClientLike['bucket']>;

  constructor(config: GcsStorageConfig, client?: GcsClientLike) {
    const storage = client ?? (new Storage({ keyFilename: config.keyFilename }) as unknown as GcsClientLike);
    this.bucketRef = storage.bucket(config.bucket);
  }

  async put(key: string, body: Buffer): Promise<void> {
    // resumable:false — segments are small (≤ a few MB); resumable uploads add
    // 2 extra round-trips and a session object per call.
    await this.bucketRef.file(key).save(body, { resumable: false });
  }

  async list(prefix: string): Promise<string[]> {
    const [files] = await this.bucketRef.getFiles({ prefix });
    return files.map((f) => f.name).sort();
  }

  async get(key: string): Promise<Buffer> {
    const [body] = await this.bucketRef.file(key).download();
    return body;
  }
}
