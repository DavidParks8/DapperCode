import {
  WORKING_PHRASES,
  WORKING_PHRASE_FALLBACK,
  resolveRotatingWorkingPhrase,
  rotateWorkingPhrase,
} from './workingPhrases';

describe('rotateWorkingPhrase', () => {
  it('offers more than one phrase so the status never repeats a single word', () => {
    expect(WORKING_PHRASES.length).toBeGreaterThan(1);
    expect(new Set(WORKING_PHRASES).size).toBe(WORKING_PHRASES.length);
    expect(WORKING_PHRASES).not.toContain(WORKING_PHRASE_FALLBACK);
    expect(WORKING_PHRASE_FALLBACK).not.toBe('Working');
    expect(WORKING_PHRASES).toContain('Catching a hamster');
  });

  it('picks the phrase the random draw lands on', () => {
    expect(rotateWorkingPhrase(null, () => 0)).toBe(WORKING_PHRASES[0]);
    expect(rotateWorkingPhrase(null, () => 0.999999)).toBe(
      WORKING_PHRASES[WORKING_PHRASES.length - 1],
    );
  });

  it('never returns the phrase already on screen', () => {
    const current = WORKING_PHRASES[0] ?? '';
    for (let draw = 0; draw < 1; draw += 0.05) {
      expect(rotateWorkingPhrase(current, () => draw)).not.toBe(current);
    }
  });

  it('ignores case and padding when avoiding a repeat', () => {
    const current = WORKING_PHRASES[0] ?? '';
    expect(rotateWorkingPhrase(`  ${current.toUpperCase()} `, () => 0)).not.toBe(current);
  });

  it('stays in range for a draw of exactly 1', () => {
    expect(WORKING_PHRASES).toContain(rotateWorkingPhrase(null, () => 1));
  });
});

describe('resolveRotatingWorkingPhrase', () => {
  it('picks a phrase when a generic running status starts', () => {
    const resolved = resolveRotatingWorkingPhrase(
      null,
      { isGenericRunningActivity: true, key: 'turn-1|t0|working' },
      () => 0,
    );
    expect(resolved).toEqual({ key: 'turn-1|t0|working', phrase: WORKING_PHRASES[0] });
  });

  it('keeps the same phrase while the chat has not moved on', () => {
    const first = resolveRotatingWorkingPhrase(
      null,
      { isGenericRunningActivity: true, key: 'turn-1|t0|working' },
      () => 0,
    );
    const second = resolveRotatingWorkingPhrase(
      first,
      { isGenericRunningActivity: true, key: 'turn-1|t0|working' },
      () => 0.5,
    );
    expect(second).toBe(first);
  });

  it('rotates to a different phrase as the chat updates', () => {
    let resolved = resolveRotatingWorkingPhrase(
      null,
      { isGenericRunningActivity: true, key: 'turn-1|t0|working' },
      () => 0,
    );
    const seen = [resolved?.phrase];
    for (const [index, key] of ['turn-1|t1|working', 'turn-1|t2|working'].entries()) {
      resolved = resolveRotatingWorkingPhrase(
        resolved,
        { isGenericRunningActivity: true, key },
        () => 0.1 * (index + 1),
      );
      expect(resolved?.phrase).not.toBe(seen[seen.length - 1]);
      expect(resolved?.key).toBe(key);
      seen.push(resolved?.phrase);
    }
  });

  it('drops the phrase when the status is no longer generic so the next stretch starts fresh', () => {
    const running = resolveRotatingWorkingPhrase(
      null,
      { isGenericRunningActivity: true, key: 'turn-1|t0|working' },
      () => 0,
    );
    expect(
      resolveRotatingWorkingPhrase(
        running,
        { isGenericRunningActivity: false, key: 'turn-1|t0|working' },
        () => 0,
      ),
    ).toBeNull();
  });
});
