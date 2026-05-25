import { AIFinding, parseFindingsResponse, renderFindingsAsProse } from '../aiFindings';

function makeFinding(overrides: Partial<AIFinding> = {}): AIFinding {
  return {
    rank: 1,
    title: 'Hammer of Justice eaten untrinketed',
    severity: 'Critical',
    confidence: 'High',
    confidenceNote: 'Trinket CD elapsed; no defensive overlap to justify holding.',
    atSeconds: 112,
    impactDelta: '+140k effective HP saved',
    summary: 'You ate a 4.5s Hammer of Justice while focusing the Mage.',
    whatHappened: 'Stunned at 1:52 for 4.5s during the second burst window.',
    alternative: 'Trinket on application and continue pressure into the soft target.',
    impact: 'Highest-impact micro-decision of the match.',
    counterfactual: 'Trinket at 1:52 → kill at ~1:55 instead of 2:00.',
    ...overrides,
  };
}

describe('parseFindingsResponse', () => {
  it('parses a clean JSON object', () => {
    const raw = JSON.stringify({ findings: [makeFinding()] });
    const findings = parseFindingsResponse(raw);
    expect(findings).toHaveLength(1);
    expect(findings[0].title).toContain('Hammer of Justice');
    expect(findings[0].severity).toBe('Critical');
  });

  it('strips ```json code fences', () => {
    const raw = '```json\n' + JSON.stringify({ findings: [makeFinding()] }) + '\n```';
    expect(parseFindingsResponse(raw)).toHaveLength(1);
  });

  it('tolerates leading and trailing prose around the JSON object', () => {
    const raw =
      'Here is the analysis:\n' + JSON.stringify({ findings: [makeFinding({ title: 'Wrapped' })] }) + '\nDone.';
    const findings = parseFindingsResponse(raw);
    expect(findings).toHaveLength(1);
    expect(findings[0].title).toBe('Wrapped');
  });

  it('accepts a bare array as well as a {findings:[]} envelope', () => {
    const raw = JSON.stringify([makeFinding(), makeFinding({ rank: 2 })]);
    expect(parseFindingsResponse(raw)).toHaveLength(2);
  });

  it('fills defaults for missing optional fields', () => {
    const raw = JSON.stringify({ findings: [{ title: 'Bare finding', whatHappened: 'x' }] });
    const findings = parseFindingsResponse(raw);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('Medium');
    expect(findings[0].confidence).toBe('Medium');
    expect(findings[0].rank).toBe(1);
    expect(findings[0].title).toBe('Bare finding');
  });

  it('sorts by rank and renumbers ranks sequentially', () => {
    const raw = JSON.stringify({
      findings: [makeFinding({ rank: 3 }), makeFinding({ rank: 1 }), makeFinding({ rank: 2 })],
    });
    const findings = parseFindingsResponse(raw);
    expect(findings.map((f) => f.rank)).toEqual([1, 2, 3]);
  });

  it('throws on input with no JSON at all', () => {
    expect(() => parseFindingsResponse('the model refused to answer')).toThrow();
  });

  it('coerces an out-of-range severity to Medium', () => {
    const raw = JSON.stringify({ findings: [makeFinding({ severity: 'Catastrophic' as AIFinding['severity'] })] });
    expect(parseFindingsResponse(raw)[0].severity).toBe('Medium');
  });
});

describe('renderFindingsAsProse', () => {
  it('reproduces the legacy ## Finding markdown contract', () => {
    const prose = renderFindingsAsProse([makeFinding()]);
    expect(prose).toContain('## Finding 1: Hammer of Justice eaten untrinketed');
    expect(prose).toContain('**What happened:** Stunned at 1:52');
    expect(prose).toContain('**Alternative:** Trinket on application');
    expect(prose).toContain('**Impact:** Highest-impact');
    expect(prose).toContain('**Confidence:** High — Trinket CD elapsed');
  });

  it('numbers multiple findings sequentially with blank-line separators', () => {
    const prose = renderFindingsAsProse([makeFinding(), makeFinding({ rank: 2, title: 'Second' })]);
    expect(prose).toContain('## Finding 1:');
    expect(prose).toContain('## Finding 2: Second');
    expect(prose.indexOf('## Finding 1:')).toBeLessThan(prose.indexOf('## Finding 2:'));
  });

  it('round-trips through parse → render without losing the four core fields', () => {
    const original = [makeFinding(), makeFinding({ rank: 2, title: 'Second', confidence: 'Medium' })];
    const reparsed = parseFindingsResponse(JSON.stringify({ findings: original }));
    const prose = renderFindingsAsProse(reparsed);
    expect(prose).toContain('## Finding 2: Second');
    expect(prose).toContain('**Confidence:** Medium —');
  });
});
