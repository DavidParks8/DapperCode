import { nonEmptyString, record } from '@bridge/agui/agUiValueReaders';

/**
 * Custom AG-UI event an agent streams while a run is in a phase worth naming, such as loading a
 * model or running a specific tool. Agents that never send it keep the generic working status.
 */
export const RUN_ACTIVITY_EVENT_NAME = 'dappercode.dev/activity';

export interface RunActivity {
  /** Short present-tense phase, for example "Loading Qwen3 1.7B" or "Reading README.md". */
  title: string;
  /** Extra detail shown after the title, for example a load percentage. */
  detail?: string;
}

export function parseRunActivity(value: unknown): RunActivity | null {
  const entry = record(value);
  const title = nonEmptyString(entry?.['title']);
  if (!title) {
    return null;
  }
  const detail = nonEmptyString(entry?.['detail']);
  return detail ? { title, detail } : { title };
}
