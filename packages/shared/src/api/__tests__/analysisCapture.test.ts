import crypto from 'crypto';

import { AnalysisCaptureInput, buildCaptureRecord, captureAnalysisRun, shouldCapture } from '../analysisCapture';

function sampleInput(overrides: Partial<AnalysisCaptureInput> = {}): AnalysisCaptureInput {
  return {
    matchId: 'match-123',
    model: 'claude-sonnet-4-6',
    promptId: 'FINDINGS_JSON',
    activeSystemPrompt: 'SYSTEM PROMPT TEXT',
    flags: { findingsJson: true },
    matchContext: '<match_context>...</match_context>',
    analysisProse: 'You ate a Hammer of Justice.',
    findings: [{ rank: 1, title: 'x' }],
    parseOk: true,
    parseError: undefined,
    rawText: '{"findings":[{"rank":1,"title":"x"}]}',
    inputTokens: 5000,
    outputTokens: 640,
    durationMs: 4200,
    ...overrides,
  };
}

describe('buildCaptureRecord', () => {
  it('maps fields and computes a sha256 promptHash', () => {
    const rec = buildCaptureRecord(sampleInput(), { captureId: 'cap-1', now: new Date('2026-06-12T00:00:00Z') });
    expect(rec.captureId).toBe('cap-1');
    expect(rec.model).toBe('claude-sonnet-4-6');
    expect(rec.promptId).toBe('FINDINGS_JSON');
    expect(rec.promptHash).toBe(crypto.createHash('sha256').update('SYSTEM PROMPT TEXT').digest('hex'));
    expect(rec.matchId).toBe('match-123');
    expect(rec.input.matchContext).toContain('match_context');
    expect(rec.output.analysisProse).toContain('Hammer of Justice');
    expect(rec.output.parseOk).toBe(true);
    expect(rec.usage).toEqual({ inputTokens: 5000, outputTokens: 640, durationMs: 4200 });
  });

  it('never includes an apiKey field anywhere in the record', () => {
    const rec = buildCaptureRecord(sampleInput(), { captureId: 'cap-1' });
    expect(JSON.stringify(rec).toLowerCase()).not.toContain('apikey');
  });

  it('coalesces optional values to null (Firestore-safe) and defaults flags', () => {
    const rec = buildCaptureRecord(
      sampleInput({ matchId: undefined, findings: null, parseOk: undefined, parseError: undefined, flags: {} }),
      { captureId: 'cap-1' },
    );
    expect(rec.matchId).toBeNull();
    expect(rec.logObjectUrl).toBeNull();
    expect(rec.rawLogSnapshotUrl).toBeNull();
    expect(rec.output.findings).toBeNull();
    expect(rec.output.parseOk).toBeNull();
    expect(rec.output.parseError).toBeNull();
    expect(rec.flags).toEqual({ findingsJson: false, useTimelinePrompt: false });
  });
});

describe('shouldCapture', () => {
  it('captures only in production non-debug runs', () => {
    expect(shouldCapture({ nodeEnv: 'production', debug: false })).toBe(true);
    expect(shouldCapture({ nodeEnv: 'production', debug: true })).toBe(false);
    expect(shouldCapture({ nodeEnv: 'development', debug: false })).toBe(false);
    expect(shouldCapture({ nodeEnv: undefined, debug: false })).toBe(false);
  });
});

describe('captureAnalysisRun (guarded IO)', () => {
  const baseInput = (): AnalysisCaptureInput => ({
    model: 'claude-sonnet-4-6',
    promptId: 'FINDINGS_JSON',
    activeSystemPrompt: 'P',
    flags: { findingsJson: true },
    matchContext: 'ctx',
    analysisProse: 'prose',
    findings: null,
    rawText: 'raw',
    inputTokens: 1,
    outputTokens: 1,
    durationMs: 1,
  });

  it('never rejects even when Firestore throws', async () => {
    const throwingFirestore = {
      collection: () => {
        throw new Error('firestore boom');
      },
    } as unknown as import('@google-cloud/firestore').Firestore;
    await expect(
      captureAnalysisRun(baseInput(), {
        firestore: throwingFirestore,
        storage: {} as never,
        fetchImpl: (async () => ({ ok: false })) as never,
      }),
    ).resolves.toBeUndefined();
  });

  it('writes the Firestore doc and skips the snapshot when there is no matchId', async () => {
    const set = jest.fn().mockResolvedValue(undefined);
    const fakeFirestore = {
      collection: () => ({ doc: () => ({ set }) }),
    } as unknown as import('@google-cloud/firestore').Firestore;
    const fetchImpl = jest.fn();
    await captureAnalysisRun(
      { ...baseInput(), matchId: undefined },
      {
        firestore: fakeFirestore,
        storage: {} as never,
        fetchImpl: fetchImpl as never,
      },
    );
    expect(set).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled(); // no matchId → no log resolution/snapshot
    const written = set.mock.calls[0][0];
    expect(written.matchId).toBeNull();
    expect(written.rawLogSnapshotUrl).toBeNull();
  });

  it('still writes the Firestore doc when the raw-log snapshot fails', async () => {
    const set = jest.fn().mockResolvedValue(undefined);
    const stubGet = jest.fn().mockResolvedValue({
      empty: false,
      docs: [{ data: () => ({ logObjectUrl: 'https://gcs.example/log.txt' }) }],
    });
    const fakeFirestore = {
      collection: (name: string) =>
        name === 'match-stubs-prod' ? { where: () => ({ limit: () => ({ get: stubGet }) }) } : { doc: () => ({ set }) },
    } as unknown as import('@google-cloud/firestore').Firestore;
    const fetchImpl = jest.fn().mockRejectedValue(new Error('network down')); // snapshot fetch fails
    await captureAnalysisRun(
      { ...baseInput(), matchId: 'm-1' },
      {
        firestore: fakeFirestore,
        storage: {} as never,
        fetchImpl: fetchImpl as never,
      },
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledTimes(1);
    const written = set.mock.calls[0][0];
    expect(written.matchId).toBe('m-1');
    expect(written.logObjectUrl).toBe('https://gcs.example/log.txt');
    expect(written.rawLogSnapshotUrl).toBeNull();
  });
});
