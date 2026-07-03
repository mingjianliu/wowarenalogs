import { checkClaims } from '../claimChecker';

const allow = { spells: ['Penance', 'Power Word: Shield'], numbers: [9, 14] };

test('flags a fabricated percentage the server did not compute', () => {
  const r = checkClaims('In 80% of similar spots, pros used Penance.', allow);
  expect(r.ok).toBe(false);
  expect(r.violations.map((v) => v.text).join(' ')).toContain('80');
});

test('passes a draft that only cites allowed numbers and spells', () => {
  const r = checkClaims('9 of 14 comparable pros opened with Penance.', allow);
  expect(r.ok).toBe(true);
});

test('flags a known spell the server did not provide', () => {
  // Apotheosis is a real spell in spellNames.json but not in the allowlist
  const r = checkClaims('In a similar spot pros used Apotheosis.', allow);
  expect(r.ok).toBe(false);
  expect(r.violations.map((v) => v.text).join(' ')).toContain('Apotheosis');
});

test('allows an allowlisted spell', () => {
  expect(checkClaims('They cast Penance.', allow).ok).toBe(true);
});

test('does not flag ordinary coaching prose that happens to contain common-word spell names', () => {
  const sentence =
    'Shield yourself before the stun. Focus the healer, Fear their pet, and Silence the caster while you Charge in. Heal up when safe.';
  expect(checkClaims(sentence, { spells: [], numbers: [] }).ok).toBe(true);
});

test('flags a multi-word non-allowlisted spell even though it contains common words', () => {
  const r = checkClaims('Pros opened with Divine Toll here.', allow);
  expect(r.ok).toBe(false);
  expect(r.violations.map((v) => v.text).join(' ')).toContain('Divine Toll');
});
