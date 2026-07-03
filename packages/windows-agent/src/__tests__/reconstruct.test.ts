import { nextAction } from '../protocol/reconstruct';

describe('nextAction', () => {
  it('appends the segment that starts exactly at current size', () => {
    expect(nextAction(0, [0, 100, 250])).toEqual({ type: 'append', startOffset: 0 });
    expect(nextAction(100, [0, 100, 250])).toEqual({ type: 'append', startOffset: 100 });
  });

  it('skips duplicate/already-applied offsets', () => {
    expect(nextAction(250, [0, 100])).toEqual({ type: 'done' });
    expect(nextAction(100, [0, 0, 100])).toEqual({ type: 'append', startOffset: 100 });
  });

  it('reports a gap instead of appending past a hole', () => {
    expect(nextAction(100, [0, 250])).toEqual({ type: 'gap', expected: 100, nextAvailable: 250 });
  });

  it('done when no offsets remain at or past current size', () => {
    expect(nextAction(0, [])).toEqual({ type: 'done' });
  });

  it('handles unsorted input', () => {
    expect(nextAction(100, [250, 0, 100])).toEqual({ type: 'append', startOffset: 100 });
  });
});
