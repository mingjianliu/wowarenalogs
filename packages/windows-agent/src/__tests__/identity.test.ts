import { createHash } from 'crypto';

import { firstLineChecksum, gen8Of } from '../protocol/identity';

describe('firstLineChecksum', () => {
  it('hashes exactly the first line, excluding the newline', () => {
    const line = '6/14/2026 18:30:00.123  COMBAT_LOG_VERSION,21,ADVANCED_LOG_ENABLED,1';
    const head = Buffer.from(`${line}\nSECOND_LINE,stuff\n`);
    const expected = createHash('sha1').update(Buffer.from(line)).digest('hex');
    expect(firstLineChecksum(head)).toBe(expected);
  });

  it('is stable regardless of how much of the file follows', () => {
    const a = firstLineChecksum(Buffer.from('first\nsecond\n'));
    const b = firstLineChecksum(Buffer.from('first\nDIFFERENT REST OF FILE'));
    expect(a).toBe(b);
  });

  it('handles CRLF by stripping the trailing \\r', () => {
    const a = firstLineChecksum(Buffer.from('first\r\nsecond\r\n'));
    const b = firstLineChecksum(Buffer.from('first\nsecond\n'));
    expect(a).toBe(b);
  });

  it('returns null when no complete first line exists yet', () => {
    expect(firstLineChecksum(Buffer.from('partial line without newline'))).toBeNull();
    expect(firstLineChecksum(Buffer.alloc(0))).toBeNull();
  });

  it('gen8Of takes the first 8 chars', () => {
    expect(gen8Of('abcdef0123456789')).toBe('abcdef01');
  });
});
