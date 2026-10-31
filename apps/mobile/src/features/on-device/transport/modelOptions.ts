import type { LocalModelChoice } from './port';
import { localModelDisplayName } from './wire';

/** Context sizes are conventionally binary: 16,384 tokens is "16K". */
function contextLabel(tokens: number): string {
  return tokens >= 1024 && tokens % 1024 === 0
    ? `${tokens / 1024}K`
    : `${Math.round(tokens / 1000)}K`;
}

/** The picker subtitle for a downloaded local model: whether it is loaded and how much context. */
export function localModelChoiceDescription(choice: LocalModelChoice): string {
  if (choice.residency === 'loaded') {
    return choice.contextTokens
      ? `Loaded · ${contextLabel(choice.contextTokens)} context`
      : 'Loaded';
  }
  if (choice.residency === 'loading') {
    return `Loading ${Math.max(0, Math.min(100, Math.floor(choice.loadProgress)))}%`;
  }
  return `Loads when you send · up to ${contextLabel(choice.model.maxContextTokens)} context`;
}

/**
 * `model/list` entries for the local agent. Every entry is a downloaded model; `defaultModelId` is
 * the model a new chat uses when none is chosen. Context is described in words rather than as a
 * bare window, because a local model's context depends on memory when it loads.
 */
export function localModelListEntries(
  choices: readonly LocalModelChoice[],
  defaultModelId: string | null,
) {
  return choices.map((choice) => ({
    id: choice.model.id,
    displayName: localModelDisplayName(choice.model),
    description: localModelChoiceDescription(choice),
    providerId: 'on-device',
    isDefault: choice.model.id === defaultModelId,
  }));
}
