import { englishSpellName } from '../englishSpellName';

test('maps a spellId to its English name', () => {
  expect(englishSpellName('2061')).toBe('Flash Heal'); // id confirmed in Step 4
});

test('falls back to the provided name when the id is unknown', () => {
  expect(englishSpellName('999999999', 'Réversion')).toBe('Réversion');
});
