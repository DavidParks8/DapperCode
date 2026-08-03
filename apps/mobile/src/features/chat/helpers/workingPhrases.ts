/**
 * Display copy for the generic "the agent is busy" status.
 *
 * The runtime keeps writing canonical titles such as `Working`, so every comparison against
 * activity state still works. Only the status strip swaps that canonical title for one of these
 * phrases, and it moves to a new one whenever the chat itself moves on — a single word repeated
 * for the length of a turn reads like the app stopped responding.
 */
export const WORKING_PHRASE_FALLBACK = 'Making progress';

export const WORKING_PHRASES: readonly string[] = [
  'Cooking',
  'Herding electrons',
  'Reticulating splines',
  'Consulting the docs',
  'Shaving the yak',
  'Untangling the logic',
  'Bribing the compiler',
  'Wrangling brackets',
  'Summoning semicolons',
  'Chasing pointers',
  'Catching a hamster',
  'Massaging the syntax tree',
  'Poking the codebase',
  'Thinking really hard',
  'Doing agent things',
  'Reading the fine manual',
  'Rubber-ducking it',
  'Aligning the tabs',
  'Sharpening pencils',
  'Making it so',
];

export interface RotatingWorkingPhrase {
  key: string;
  phrase: string;
}

/**
 * Picks a phrase that is not the one already on screen, so every rotation is visible.
 */
export function rotateWorkingPhrase(
  current?: string | null,
  random: () => number = Math.random,
): string {
  const normalizedCurrent = current?.trim().toLowerCase() ?? '';
  const unseen = WORKING_PHRASES.filter((phrase) => phrase.toLowerCase() !== normalizedCurrent);
  const pool = unseen.length > 0 ? unseen : WORKING_PHRASES;
  if (pool.length === 0) {
    return WORKING_PHRASE_FALLBACK;
  }

  const draw = random();
  const offset = Number.isFinite(draw) ? Math.floor(Math.abs(draw) * pool.length) : 0;
  return pool[Math.min(offset, pool.length - 1)] ?? WORKING_PHRASE_FALLBACK;
}

/**
 * The phrase to show for the current status, given the phrase that was shown last.
 *
 * `key` identifies the state of the chat the phrase was picked for. The same key keeps the same
 * phrase so re-renders never reshuffle the strip, a new key rotates, and a non-generic status
 * drops the phrase entirely so the next busy stretch starts fresh.
 */
export function resolveRotatingWorkingPhrase(
  previous: RotatingWorkingPhrase | null,
  input: { isGenericRunningActivity: boolean; key: string },
  random: () => number = Math.random,
): RotatingWorkingPhrase | null {
  if (!input.isGenericRunningActivity) {
    return null;
  }
  if (previous && previous.key === input.key) {
    return previous;
  }

  return { key: input.key, phrase: rotateWorkingPhrase(previous?.phrase ?? null, random) };
}
