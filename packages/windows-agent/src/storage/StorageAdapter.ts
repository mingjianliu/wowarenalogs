/**
 * Minimal storage contract shared by the Windows agent (write side) and the
 * Mac collector (read side). Deliberately tiny — 4 methods, flat keys, no
 * streaming/multipart — so S3 / Google Drive / R2 adapters are drop-in later.
 */
export interface StorageAdapter {
  put(key: string, body: Buffer): Promise<void>;
  /** Returns keys under prefix in lexicographic order. */
  list(prefix: string): Promise<string[]>;
  get(key: string): Promise<Buffer>;
  /** Idempotent: deleting a missing key resolves silently. */
  delete(key: string): Promise<void>;
}
