import { getEnglishSpellName } from '../spellEffectData';

describe('getEnglishSpellName', () => {
  it('resolves standard spells in the dictionary', () => {
    // 33206 is Pain Suppression
    expect(getEnglishSpellName('33206')).toBe('Pain Suppression');
  });

  it('resolves non-cooldown filler spells from spellNames.json', () => {
    // 85673 is Word of Glory
    expect(getEnglishSpellName('85673', 'Fallback')).toBe('Word of Glory');
  });

  it('returns the fallback if spell is missing from all dictionaries', () => {
    expect(getEnglishSpellName('9999999', 'My Fallback')).toBe('My Fallback');
  });

  it('returns the spell ID if no fallback is provided and spell is missing', () => {
    expect(getEnglishSpellName('9999999')).toBe('9999999');
  });
});
