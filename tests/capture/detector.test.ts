import { detectState } from '../../src/capture/detector.js';

describe('detectState', () => {
  it('returns offline when current is null', () => {
    const state = detectState(null, 'previous content', 0);
    expect(state).toBe('offline');
  });

  it('returns working when previous is null (first capture)', () => {
    const state = detectState('current content', null, 0);
    expect(state).toBe('working');
  });

  it('returns working when content changed', () => {
    const state = detectState('new content', 'old content', 5);
    expect(state).toBe('working');
  });

  it('returns stopped when content unchanged', () => {
    const content = 'same content';
    const state = detectState(content, content, 10);
    expect(state).toBe('stopped');
  });

  it('ignores stableCount parameter', () => {
    const content = 'unchanged';
    expect(detectState(content, content, 0)).toBe('stopped');
    expect(detectState(content, content, 100)).toBe('stopped');
    expect(detectState(content, content, 999)).toBe('stopped');
  });
});
