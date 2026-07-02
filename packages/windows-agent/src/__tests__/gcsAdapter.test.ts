import { GcsClientLike, GcsStorageAdapter } from '../storage/GcsStorageAdapter';

function makeStub() {
  const calls: Record<string, unknown[]> = { save: [], download: [], getFiles: [] };
  const stub: GcsClientLike = {
    bucket: (bucketName: string) => ({
      file: (key: string) => ({
        save: async (body: Buffer, opts: unknown) => {
          calls.save.push([bucketName, key, body, opts]);
        },
        download: async () => {
          calls.download.push([bucketName, key]);
          return [Buffer.from(`content-of-${key}`)] as [Buffer];
        },
      }),
      getFiles: async (opts: { prefix: string }) => {
        calls.getFiles.push([bucketName, opts]);
        return [[{ name: 'raw/h/f/g/000000000010.seg' }, { name: 'raw/h/f/g/000000000002.seg' }]] as [
          { name: string }[],
        ];
      },
    }),
  };
  return { stub, calls };
}

describe('GcsStorageAdapter', () => {
  it('put maps to file(key).save with resumable disabled', async () => {
    const { stub, calls } = makeStub();
    const adapter = new GcsStorageAdapter({ bucket: 'my-bucket' }, stub);
    await adapter.put('k/a', Buffer.from('x'));
    expect(calls.save).toEqual([['my-bucket', 'k/a', Buffer.from('x'), { resumable: false }]]);
  });

  it('list maps to getFiles(prefix) and sorts the names', async () => {
    const { stub } = makeStub();
    const adapter = new GcsStorageAdapter({ bucket: 'my-bucket' }, stub);
    expect(await adapter.list('raw/')).toEqual(['raw/h/f/g/000000000002.seg', 'raw/h/f/g/000000000010.seg']);
  });

  it('get maps to file(key).download', async () => {
    const { stub } = makeStub();
    const adapter = new GcsStorageAdapter({ bucket: 'my-bucket' }, stub);
    expect((await adapter.get('k/a')).toString()).toBe('content-of-k/a');
  });
});
