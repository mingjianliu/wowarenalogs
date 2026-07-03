import { buildHeartbeatKey, buildSegmentKey, parseSegmentKey } from '../protocol/segments';

describe('segment key protocol', () => {
  const file = 'WoWCombatLog-061426_183000.txt';

  it('builds zero-padded, generation-namespaced keys', () => {
    expect(buildSegmentKey('GAMING-PC', file, 'a1b2c3d4', 0)).toBe(`raw/GAMING-PC/${file}/a1b2c3d4/000000000000.seg`);
    expect(buildSegmentKey('GAMING-PC', file, 'a1b2c3d4', 1048576)).toBe(
      `raw/GAMING-PC/${file}/a1b2c3d4/000001048576.seg`,
    );
  });

  it('lexicographic key order equals numeric offset order', () => {
    const keys = [123456789, 999, 0, 1048576].map((o) => buildSegmentKey('h', file, 'a1b2c3d4', o));
    const sortedLex = [...keys].sort();
    const sortedNum = [0, 999, 1048576, 123456789].map((o) => buildSegmentKey('h', file, 'a1b2c3d4', o));
    expect(sortedLex).toEqual(sortedNum);
  });

  it('round-trips through parseSegmentKey', () => {
    const key = buildSegmentKey('GAMING-PC', file, 'deadbeef', 42);
    expect(parseSegmentKey(key)).toEqual({
      hostname: 'GAMING-PC',
      logFileName: file,
      gen8: 'deadbeef',
      startOffset: 42,
      key,
    });
  });

  it('rejects malformed keys', () => {
    expect(parseSegmentKey('status/GAMING-PC.json')).toBeNull();
    expect(parseSegmentKey('raw/host/file.txt/gen/notanumber.seg')).toBeNull();
    expect(parseSegmentKey('raw/host/file.txt/000000000042.seg')).toBeNull(); // missing gen
  });

  it('builds heartbeat keys', () => {
    expect(buildHeartbeatKey('GAMING-PC')).toBe('status/GAMING-PC.json');
  });
});
