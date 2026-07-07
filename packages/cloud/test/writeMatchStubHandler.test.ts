/**
 * Fixture harness for the GCS-triggered writeMatchStubHandler (verifiability C8).
 *
 * Exercises the real pipeline — real combat log fixture → real parser →
 * real createStubDTOFromArenaMatch — with only the external boundaries mocked:
 * node-fetch (serves the fixture as the GCS object), Firestore (in-memory),
 * logCombatStatsAsync (prisma) and the webhook publisher.
 */
import fs from 'fs';
import path from 'path';

process.env.ENV_MATCH_STUBS_FIRESTORE = 'match-stubs-test';

const FIXTURE = fs.readFileSync(path.join(__dirname, '../../parser/test/testlogs/3v3_tww_1120_reduced.txt'), 'utf8');

const firestoreDocs: Record<string, unknown> = {};

jest.mock('@google-cloud/firestore', () => ({
  Firestore: jest.fn().mockImplementation(() => ({
    doc: (docPath: string) => ({
      get: async () => ({ exists: docPath in firestoreDocs }),
      set: async (data: unknown) => {
        firestoreDocs[docPath] = data;
      },
    }),
  })),
}));

jest.mock('node-fetch', () => ({
  __esModule: true,
  default: jest.fn(async () => ({
    status: 200,
    text: async () => FIXTURE,
    headers: {
      get: (name: string) =>
        ({
          'x-goog-meta-ownerid': 'harness-owner',
          'x-goog-meta-wow-version': 'retail',
          'x-goog-meta-client-timezone': 'America/Los_Angeles',
        })[name] ?? null,
    },
  })),
}));

jest.mock('../src/utils', () => {
  const actual = jest.requireActual('../src/utils');
  return { ...actual, logCombatStatsAsync: jest.fn(async () => undefined) };
});

jest.mock('../src/webhookPublisher', () => ({
  publishWebhookStubAsync: jest.fn(async () => undefined),
}));

import { handler } from '../src/writeMatchStubHandler';

describe('writeMatchStubHandler fixture harness', () => {
  beforeAll(async () => {
    await handler({ bucket: 'test-bucket', name: 'logs/harness.txt' }, {});
  });

  it('writes exactly one match stub to the configured collection', () => {
    const paths = Object.keys(firestoreDocs);
    expect(paths).toHaveLength(1);
    expect(paths[0]).toMatch(/^match-stubs-test\//);
  });

  it('produces a stub whose shape matches the FirebaseDTO contract', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stub = Object.values(firestoreDocs)[0] as any;
    expect(typeof stub.id).toBe('string');
    expect(stub.id.length).toBeGreaterThan(0);
    expect(stub.ownerId).toBe('harness-owner');
    expect(stub.wowVersion).toBe('retail');
    expect(stub.logObjectUrl).toBe('https://storage.googleapis.com/test-bucket/logs/harness.txt');
    expect(stub.timezone).toBe('America/Los_Angeles');
    expect(Array.isArray(stub.combatantNames)).toBe(true);
    expect(stub.combatantNames.length).toBeGreaterThan(0);
    expect(Array.isArray(stub.combatantGuids)).toBe(true);
    expect(stub.expires).toBeDefined();
    expect(stub.extra).toBeDefined();
  });

  it('is idempotent: re-running the handler does not overwrite the existing stub', async () => {
    const before = Object.values(firestoreDocs)[0];
    await handler({ bucket: 'test-bucket', name: 'logs/harness.txt' }, {});
    expect(Object.keys(firestoreDocs)).toHaveLength(1);
    expect(Object.values(firestoreDocs)[0]).toBe(before);
  });
});
