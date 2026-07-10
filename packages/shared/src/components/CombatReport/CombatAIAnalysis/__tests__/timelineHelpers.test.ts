import { mergeTimestampedLines } from '../timelineHelpers';

describe('mergeTimestampedLines', () => {
  const timeline = [
    'MATCH TIMELINE',
    '  Units: M = Million damage (1,000,000), k = Thousand damage (1,000)',
    '',
    '0:05  [YOU] [CAST]   Riptide → 2',
    '0:13  [DMG SPIKE]   1 (Restoration Shaman): 0.50M in 5s (100k DPS)',
    '0:30  [ENEMY CD]   e1 (Frost Mage): Icy Veins',
    'KILL SEQUENCE',
    '  trailing non-timestamped detail',
  ];

  it('returns a copy of the timeline when there are no inserts', () => {
    const out = mergeTimestampedLines(timeline, []);
    expect(out).toEqual(timeline);
    expect(out).not.toBe(timeline);
  });

  it('inserts before the first timestamped line with time strictly greater than atSeconds', () => {
    const out = mergeTimestampedLines(timeline, [{ atSeconds: 10, line: '0:10  [HEALER EXPOSURE]   entry' }]);
    expect(out.indexOf('0:10  [HEALER EXPOSURE]   entry')).toBe(
      out.indexOf('0:13  [DMG SPIKE]   1 (Restoration Shaman): 0.50M in 5s (100k DPS)') - 1,
    );
  });

  it('places an equal-timestamp insert after the existing lines at that time', () => {
    const out = mergeTimestampedLines(timeline, [{ atSeconds: 13, line: '0:13  [HEALER EXPOSURE]   entry' }]);
    const spikeIdx = out.indexOf('0:13  [DMG SPIKE]   1 (Restoration Shaman): 0.50M in 5s (100k DPS)');
    expect(out.indexOf('0:13  [HEALER EXPOSURE]   entry')).toBe(spikeIdx + 1);
  });

  it('never inserts before the headers preceding the first timestamped line', () => {
    const out = mergeTimestampedLines(timeline, [{ atSeconds: 0, line: '0:00  [HEALER EXPOSURE]   opener' }]);
    const insertIdx = out.indexOf('0:00  [HEALER EXPOSURE]   opener');
    expect(insertIdx).toBe(3); // after MATCH TIMELINE, units legend, and blank line
    expect(out[insertIdx + 1]).toBe('0:05  [YOU] [CAST]   Riptide → 2');
  });

  it('appends inserts later than every timeline timestamp right after the last timestamped line', () => {
    const out = mergeTimestampedLines(timeline, [{ atSeconds: 99, line: '1:39  [HEALER EXPOSURE]   late' }]);
    const lastTimestampedIdx = out.indexOf('0:30  [ENEMY CD]   e1 (Frost Mage): Icy Veins');
    expect(out.indexOf('1:39  [HEALER EXPOSURE]   late')).toBe(lastTimestampedIdx + 1);
    // Trailing non-timestamped block stays after the insert
    expect(out.indexOf('KILL SEQUENCE')).toBe(lastTimestampedIdx + 2);
  });

  it('keeps multiple inserts in order, stable for equal timestamps', () => {
    const out = mergeTimestampedLines(timeline, [
      { atSeconds: 20, line: 'B' },
      { atSeconds: 7, line: 'A' },
      { atSeconds: 20, line: 'C' },
    ]);
    const idxA = out.indexOf('A');
    const idxB = out.indexOf('B');
    const idxC = out.indexOf('C');
    expect(idxA).toBeLessThan(out.indexOf('0:13  [DMG SPIKE]   1 (Restoration Shaman): 0.50M in 5s (100k DPS)'));
    expect(idxB).toBeGreaterThan(out.indexOf('0:13  [DMG SPIKE]   1 (Restoration Shaman): 0.50M in 5s (100k DPS)'));
    expect(idxB).toBeLessThan(out.indexOf('0:30  [ENEMY CD]   e1 (Frost Mage): Icy Veins'));
    expect(idxC).toBe(idxB + 1);
  });

  it('parses multi-digit minute timestamps (10:05 = 605s)', () => {
    const longTimeline = ['9:59  [STATE]   a', '10:05  [STATE]   b'];
    const out = mergeTimestampedLines(longTimeline, [{ atSeconds: 600, line: '10:00  [HEALER EXPOSURE]   x' }]);
    expect(out).toEqual(['9:59  [STATE]   a', '10:00  [HEALER EXPOSURE]   x', '10:05  [STATE]   b']);
  });

  it('appends at the end when the timeline has no timestamped lines at all', () => {
    const out = mergeTimestampedLines(['HEADER', 'no timestamps here'], [{ atSeconds: 5, line: '0:05  X' }]);
    expect(out).toEqual(['HEADER', 'no timestamps here', '0:05  X']);
  });

  it('ignores indented or bracketed pseudo-timestamps as anchors', () => {
    // "  [0:10] ..." (block style) and "  0:10 detail" (indented) are not timeline timestamp columns
    const mixed = ['  [0:10] block-style line', '  0:12 indented detail', '0:15  [STATE]   real'];
    const out = mergeTimestampedLines(mixed, [{ atSeconds: 11, line: '0:11  X' }]);
    expect(out).toEqual(['  [0:10] block-style line', '  0:12 indented detail', '0:11  X', '0:15  [STATE]   real']);
  });
});
