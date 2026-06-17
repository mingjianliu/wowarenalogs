import { getSpellSchoolName } from '../spellSchools';

describe('getSpellSchoolName', () => {
  it('returns null for null or undefined', () => {
    expect(getSpellSchoolName(null)).toBeNull();
    expect(getSpellSchoolName(undefined)).toBeNull();
  });

  it('returns Physical for mask 1', () => {
    expect(getSpellSchoolName(1)).toBe('Physical');
  });

  it('returns Holy for mask 2', () => {
    expect(getSpellSchoolName(2)).toBe('Holy');
  });

  it('returns Chaos for mask 124, 126, 127', () => {
    expect(getSpellSchoolName(124)).toBe('Chaos');
    expect(getSpellSchoolName(126)).toBe('Chaos');
    expect(getSpellSchoolName(127)).toBe('Chaos');
  });

  it('returns Frostfire for Fire + Frost (4 + 16 = 20)', () => {
    expect(getSpellSchoolName(20)).toBe('Frostfire');
  });

  it('returns Shadowfrost for Shadow + Frost (32 + 16 = 48)', () => {
    expect(getSpellSchoolName(48)).toBe('Shadowfrost');
  });

  it('returns joined string for unknown multi-school combinations', () => {
    // Holy (2) + Nature (8) = 10
    expect(getSpellSchoolName(10)).toBe('Holy/Nature');
  });

  it('handles string input', () => {
    expect(getSpellSchoolName('2')).toBe('Holy');
  });
});
