import { AI_MODEL_OPTIONS, DEFAULT_AI_MODEL, resolveAIModel } from '../aiModels';

// aiModels is the single source of truth for the Settings dropdown AND for server-side
// validation in /api/analyze and /api/compare. A wrong entry here can send `temperature` to a
// model that rejects it (400) or let an untrusted model string reach Anthropic — so the list
// invariants and the resolver are worth locking down directly.

// The models documented (in aiModels.ts) as rejecting sampling params — passing `temperature`
// to any of these returns a 400, so they MUST carry supportsTemperature: false.
const NO_SAMPLING_MODEL_IDS = ['claude-sonnet-5', 'claude-opus-4-7', 'claude-opus-4-8', 'claude-fable-5'];

describe('AI_MODEL_OPTIONS invariants', () => {
  it('is non-empty', () => {
    expect(AI_MODEL_OPTIONS.length).toBeGreaterThan(0);
  });

  it('has unique ids', () => {
    const ids = AI_MODEL_OPTIONS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every id is a claude-* model string', () => {
    for (const m of AI_MODEL_OPTIONS) {
      expect(typeof m.id).toBe('string');
      expect(m.id).toMatch(/^claude-/);
    }
  });

  it('every option has a human label and a pricing hint', () => {
    for (const m of AI_MODEL_OPTIONS) {
      expect(m.label.length).toBeGreaterThan(0);
      expect(m.pricingHint.length).toBeGreaterThan(0);
      expect(typeof m.supportsTemperature).toBe('boolean');
    }
  });

  it('marks every sampling-param-rejecting model as supportsTemperature: false', () => {
    for (const id of NO_SAMPLING_MODEL_IDS) {
      const option = AI_MODEL_OPTIONS.find((m) => m.id === id);
      // Only assert on models that are actually offered; the list may drop one over time.
      if (option) {
        expect(option.supportsTemperature).toBe(false);
      }
    }
  });
});

describe('DEFAULT_AI_MODEL', () => {
  it('references a model that exists in AI_MODEL_OPTIONS', () => {
    expect(AI_MODEL_OPTIONS.some((m) => m.id === DEFAULT_AI_MODEL)).toBe(true);
  });

  it('is not one of the sampling-param-rejecting models (default sends temperature)', () => {
    expect(NO_SAMPLING_MODEL_IDS).not.toContain(DEFAULT_AI_MODEL);
    expect(resolveAIModel(DEFAULT_AI_MODEL).supportsTemperature).toBe(true);
  });
});

describe('resolveAIModel', () => {
  it('returns the exact option for a known model id', () => {
    for (const known of AI_MODEL_OPTIONS) {
      const resolved = resolveAIModel(known.id);
      expect(resolved.id).toBe(known.id);
      expect(resolved).toBe(known); // identity — returns the option object itself
    }
  });

  it('falls back to the default option for an unknown string', () => {
    expect(resolveAIModel('gpt-4o').id).toBe(DEFAULT_AI_MODEL);
    expect(resolveAIModel('claude-does-not-exist').id).toBe(DEFAULT_AI_MODEL);
    expect(resolveAIModel('').id).toBe(DEFAULT_AI_MODEL);
  });

  it('falls back to the default option for non-string values', () => {
    expect(resolveAIModel(undefined).id).toBe(DEFAULT_AI_MODEL);
    expect(resolveAIModel(null).id).toBe(DEFAULT_AI_MODEL);
    expect(resolveAIModel(123).id).toBe(DEFAULT_AI_MODEL);
    expect(resolveAIModel({ id: 'claude-opus-4-8' }).id).toBe(DEFAULT_AI_MODEL);
    expect(resolveAIModel(['claude-opus-4-8']).id).toBe(DEFAULT_AI_MODEL);
  });

  it('always returns an option with a boolean supportsTemperature (never undefined)', () => {
    expect(typeof resolveAIModel('anything-invalid').supportsTemperature).toBe('boolean');
  });
});
