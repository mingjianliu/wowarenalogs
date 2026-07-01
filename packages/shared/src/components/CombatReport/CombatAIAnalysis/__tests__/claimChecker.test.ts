import { checkClaims } from '../claimChecker';

const allow = { spells: ['Penance', 'Power Word: Shield'], numbers: [9, 14] };

test('flags a fabricated percentage the server did not compute', () => {
  const r = checkClaims('In 80% of similar spots, pros used Penance.', allow);
  expect(r.ok).toBe(false);
  expect(r.violations.join(' ')).toContain('80');
});

test('passes a draft that only cites allowed numbers and spells', () => {
  const r = checkClaims('9 of 14 comparable pros opened with Penance.', allow);
  expect(r.ok).toBe(true);
});

test('flags a known spell the server did not provide', () => {
  // Apotheosis is a real spell in spellNames.json but not in the allowlist
  const r = checkClaims('In a similar spot pros used Apotheosis.', allow);
  expect(r.ok).toBe(false);
  expect(r.violations.join(' ')).toContain('Apotheosis');
});

test('allows an allowlisted spell', () => {
  expect(checkClaims('They cast Penance.', allow).ok).toBe(true);
});
