import type { AcpConfigOption, ModelOption } from '@bridge/types/types';
import { normalizeReasoningEffort } from '../helpers/helpers';

export { areChatStatusMapsEquivalent, areChatSummaryListsEquivalent } from './chatEquivalence';
export { mergeChatSummaryPreservingMessages, resolveEquivalentChat } from './chatReconciliation';

const EMPTY_MODEL_OPTIONS: ModelOption[] = [];

export function modelOptionsFromAcpConfig(config: AcpConfigOption[]): ModelOption[] {
  const model = config.find((option) => option.category === 'model');
  const effort = config.find((option) => option.category === 'thought_level');
  if (!model?.options?.length) {
    return EMPTY_MODEL_OPTIONS;
  }
  const reasoningEffort = (effort?.options ?? [])
    .map((option) => {
      const normalized = normalizeReasoningEffort(option.value);
      return normalized
        ? { effort: normalized, description: option.description ?? option.name }
        : null;
    })
    .filter((option): option is NonNullable<typeof option> => option !== null);
  const defaultReasoningEffort = normalizeReasoningEffort(effort?.value);
  return model.options.map((option) => {
    const [providerId, ...modelParts] = option.value.split('/');
    const displayName = option.name.includes('/')
      ? (option.name.split('/').at(-1) ?? option.name)
      : option.name;
    return {
      id: option.value,
      displayName,
      description: option.description,
      providerId: modelParts.length > 0 ? providerId : undefined,
      providerName: modelParts.length > 0 ? option.name.split('/')[0] : undefined,
      defaultReasoningEffort: defaultReasoningEffort ?? undefined,
      reasoningEffort: reasoningEffort.length > 0 ? reasoningEffort : undefined,
    } satisfies ModelOption;
  });
}

export function mergeModelOptions(
  catalog: ModelOption[] | null | undefined,
  configured: ModelOption[],
): ModelOption[] {
  const safeCatalog = catalog ?? EMPTY_MODEL_OPTIONS;
  const catalogById = new Map(safeCatalog.map((model) => [model.id, model]));
  const mergedConfigured = configured.map((model) => {
    const catalogEntry = catalogById.get(model.id);
    return {
      ...catalogEntry,
      ...model,
      contextWindow: catalogEntry?.contextWindow ?? model.contextWindow,
      reasoningEffort: model.reasoningEffort ?? catalogEntry?.reasoningEffort,
    };
  });
  const configuredIds = new Set(configured.map((model) => model.id));
  return [...mergedConfigured, ...safeCatalog.filter((model) => !configuredIds.has(model.id))];
}
