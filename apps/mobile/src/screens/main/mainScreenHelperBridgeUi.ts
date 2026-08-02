import type {
  BridgeUiAction,
  BridgeUiBlock,
  BridgeUiChecklistItem,
  BridgeUiSurface,
  PendingUserInputRequest,
} from '../../api/types';
import { parseSlashCommand } from './mainScreenHelperPlansAndCommands';
import { parseInlineOptionsFromQuestionText } from './mainScreenHelperInlineChoices';
import {
  lookupDispatchEntry,
  readBoolean,
  readFiniteNumber,
  readString,
  toRecord,
} from '../../runtimeValidation';

const BRIDGE_UI_PRESENTATIONS = ['workflowCard', 'modal', 'banner'] as const;
const BRIDGE_UI_TONES = ['info', 'success', 'warning', 'error', 'neutral'] as const;

function readUserInputFieldType(
  value: unknown,
): PendingUserInputRequest['questions'][number]['fieldType'] {
  return value === 'string' ||
    value === 'integer' ||
    value === 'number' ||
    value === 'boolean' ||
    value === 'string-array'
    ? value
    : 'string';
}

function readUserInputDefaultValue(
  value: unknown,
): PendingUserInputRequest['questions'][number]['defaultValue'] {
  if (typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return value;
  }
  return null;
}

export function toPendingUserInputRequest(value: unknown): PendingUserInputRequest | null {
  const record = toRecord(value);
  if (!record) {
    return null;
  }

  const requestId = readString(record['requestId']) ?? readString(record['id']);
  const threadId = readString(record['threadId']);
  const turnId = readString(record['turnId']);
  const itemId = readString(record['itemId']);
  const requestedAt = readString(record['requestedAt']);
  const rawQuestions = Array.isArray(record['questions']) ? record['questions'] : [];
  if (!requestId || !threadId || !turnId || !itemId || !requestedAt || rawQuestions.length === 0) {
    return null;
  }

  const questions: PendingUserInputRequest['questions'] = rawQuestions
    .map((item) => {
      const itemRecord = toRecord(item);
      if (!itemRecord) {
        return null;
      }

      const questionId = readString(itemRecord['id']);
      const header = readString(itemRecord['header']);
      const question = readString(itemRecord['question']);
      if (!questionId || !header || !question) {
        return null;
      }

      const parsedInlineOptions = parseInlineOptionsFromQuestionText(question);

      const parsedOptions = Array.isArray(itemRecord['options'])
        ? itemRecord['options']
            .map((option) => {
              const optionRecord = toRecord(option);
              if (!optionRecord) {
                return null;
              }

              const label =
                readString(optionRecord['label']) ??
                readString(optionRecord['title']) ??
                readString(optionRecord['value']) ??
                readString(optionRecord['text']);
              const description =
                readString(optionRecord['description']) ?? readString(optionRecord['detail']) ?? '';
              if (!label) {
                return null;
              }
              return {
                value: readString(optionRecord['value']) ?? label,
                label,
                description,
              };
            })
            .filter(
              (option): option is { value: string; label: string; description: string } =>
                option !== null,
            )
        : null;
      const options =
        parsedOptions && parsedOptions.length > 0
          ? parsedOptions
          : (parsedInlineOptions.options?.map((option) => ({
              value: option.label,
              ...option,
            })) ?? null);

      return {
        id: questionId,
        header,
        question: parsedInlineOptions.question,
        isOther: readBoolean(itemRecord['isOther']) ?? false,
        isSecret: readBoolean(itemRecord['isSecret']) ?? false,
        required: readBoolean(itemRecord['required']) ?? false,
        fieldType: readUserInputFieldType(itemRecord['fieldType']),
        defaultValue: readUserInputDefaultValue(itemRecord['defaultValue']),
        options,
      } satisfies PendingUserInputRequest['questions'][number];
    })
    .filter((question): question is NonNullable<typeof question> => question !== null);

  if (questions.length === 0) {
    return null;
  }

  return {
    requestId,
    agentId: readString(record['agentId']),
    threadId,
    turnId,
    itemId,
    message: readString(record['message']) ?? questions[0]?.question ?? '',
    requestedAt,
    questions,
  };
}

export function buildUserInputDrafts(request: PendingUserInputRequest): Record<string, string> {
  const drafts: Record<string, string> = {};
  for (const question of request.questions) {
    const value = question.defaultValue;
    drafts[question.id] = Array.isArray(value)
      ? value.join(', ')
      : value == null
        ? ''
        : String(value);
  }
  return drafts;
}

export function toBridgeUiSurface(value: unknown): BridgeUiSurface | null {
  const record = toRecord(value);
  if (!record) {
    return null;
  }

  const baseSurface = readBridgeUiSurfaceBase(record);
  if (!baseSurface) {
    return null;
  }

  const blocks = parseBridgeUiBlocks(record['blocks']);
  const bodyMarkdown = readString(record['bodyMarkdown']) ?? null;
  const rawActions = Array.isArray(record['actions']) ? record['actions'] : [];
  const actions = rawActions
    .map(toBridgeUiAction)
    .filter((action): action is BridgeUiAction => action !== null);

  return {
    ...baseSurface,
    turnId: readString(record['turnId']) ?? null,
    kind: readString(record['kind']) ?? null,
    tone: readBridgeUiTone(readString(record['tone'])),
    subtitle: readString(record['subtitle']) ?? null,
    bodyMarkdown,
    blocks,
    actions,
    dismissible: readBoolean(record['dismissible']) ?? true,
    createdAt: readString(record['createdAt']) ?? null,
    updatedAt: readString(record['updatedAt']) ?? null,
  };
}

export function parseGoalSlashObjective(input: string): string | null {
  const parsed = parseSlashCommand(input);
  if (!parsed || parsed.name !== 'goal') {
    return null;
  }

  const objective = parsed.args.trim();
  return objective.length > 0 ? objective : null;
}

export function buildOptimisticGoalBridgeUiSurface(
  threadId: string,
  objective: string,
  updatedAt: string,
): BridgeUiSurface | null {
  const normalizedThreadId = threadId.trim();
  const normalizedObjective = objective.trim();
  if (!normalizedThreadId || !normalizedObjective) {
    return null;
  }

  return {
    id: `goal-${normalizedThreadId}`,
    threadId: normalizedThreadId,
    turnId: null,
    kind: 'goal',
    presentation: 'workflowCard',
    tone: 'info',
    title: 'Goal',
    subtitle: 'Starting',
    bodyMarkdown: normalizedObjective,
    blocks: [
      {
        type: 'keyValue',
        items: [{ label: 'Status', value: 'Starting' }],
      },
    ],
    actions: [{ id: 'dismiss', label: 'Dismiss', style: 'secondary' }],
    dismissible: true,
    createdAt: updatedAt,
    updatedAt,
  };
}

function toBridgeUiAction(value: unknown): BridgeUiAction | null {
  const record = toRecord(value);
  if (!record) {
    return null;
  }

  const id = readString(record['id']);
  const label = readString(record['label']);
  if (!id || !label) {
    return null;
  }

  const style = readString(record['style']);
  return {
    id,
    label,
    style:
      style === 'primary' || style === 'secondary' || style === 'destructive' ? style : undefined,
    dismissesSurface: readBoolean(record['dismissesSurface']) ?? true,
  };
}

function parseBridgeUiBlocks(value: unknown): BridgeUiBlock[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map(toBridgeUiBlock).filter((block): block is BridgeUiBlock => block !== null);
}

function toBridgeUiBlock(value: unknown): BridgeUiBlock | null {
  const record = toRecord(value);
  if (!record) {
    return null;
  }

  const type = readString(record['type']);
  if (!type) {
    return null;
  }

  return lookupDispatchEntry(BRIDGE_UI_BLOCK_READERS, type)?.(record) ?? null;
}

export function upsertBridgeUiSurfaceList(
  surfaces: BridgeUiSurface[],
  surface: BridgeUiSurface,
): BridgeUiSurface[] {
  const existingIndex = surfaces.findIndex((entry) => entry.id === surface.id);
  if (existingIndex === -1) {
    return [...surfaces, surface];
  }

  const next = surfaces.slice();
  next[existingIndex] = surface;
  return next;
}

export function removeBridgeUiSurfaceFromList(
  surfaces: BridgeUiSurface[],
  surfaceId: string,
): BridgeUiSurface[] {
  return surfaces.filter((surface) => surface.id !== surfaceId);
}

function readBridgeUiSurfaceBase(
  record: Record<string, unknown>,
): Pick<BridgeUiSurface, 'id' | 'threadId' | 'presentation' | 'title'> | null {
  const id = readString(record['id']);
  const threadId = readString(record['threadId']);
  const presentation = readBridgeUiPresentation(record['presentation']);
  const title = readString(record['title']);

  return id && threadId && presentation && title ? { id, threadId, presentation, title } : null;
}

function readBridgeUiPresentation(value: unknown): BridgeUiSurface['presentation'] | null {
  const presentation = readString(value);
  return presentation &&
    BRIDGE_UI_PRESENTATIONS.includes(presentation as BridgeUiSurface['presentation'])
    ? (presentation as BridgeUiSurface['presentation'])
    : null;
}

function readBridgeUiTone(value: unknown): BridgeUiSurface['tone'] | undefined {
  return BRIDGE_UI_TONES.includes(value as (typeof BRIDGE_UI_TONES)[number])
    ? (value as (typeof BRIDGE_UI_TONES)[number])
    : undefined;
}

const BRIDGE_UI_BLOCK_READERS: Record<
  string,
  (record: Record<string, unknown>) => BridgeUiBlock | null
> = {
  text: toTextBridgeUiBlock,
  markdown: toMarkdownBridgeUiBlock,
  checklist: toChecklistBridgeUiBlock,
  keyValue: toKeyValueBridgeUiBlock,
  code: toCodeBridgeUiBlock,
  progress: toProgressBridgeUiBlock,
};

function toTextBridgeUiBlock(record: Record<string, unknown>): BridgeUiBlock | null {
  const text = readString(record['text']);
  return text ? { type: 'text', text } : null;
}

function toMarkdownBridgeUiBlock(record: Record<string, unknown>): BridgeUiBlock | null {
  const markdown = readString(record['markdown']);
  return markdown ? { type: 'markdown', markdown } : null;
}

function toChecklistBridgeUiBlock(record: Record<string, unknown>): BridgeUiBlock | null {
  const items = parseBridgeUiChecklistItems(record['items']);
  return items.length > 0 ? { type: 'checklist', items } : null;
}

function toKeyValueBridgeUiBlock(record: Record<string, unknown>): BridgeUiBlock | null {
  const items = parseBridgeUiKeyValueItems(record['items']);
  return items.length > 0 ? { type: 'keyValue', items } : null;
}

function toCodeBridgeUiBlock(record: Record<string, unknown>): BridgeUiBlock | null {
  const text = readString(record['text']);
  return text
    ? {
        type: 'code',
        text,
        language: readString(record['language']) ?? null,
      }
    : null;
}

function toProgressBridgeUiBlock(record: Record<string, unknown>): BridgeUiBlock | null {
  const label = readString(record['label']);
  const progressValue = readFiniteNumber(record['value']);
  const max = readFiniteNumber(record['max']);
  if (!label || progressValue === null || max === null || max <= 0) {
    return null;
  }

  return {
    type: 'progress',
    label,
    value: progressValue,
    max,
    detail: readString(record['detail']) ?? null,
  };
}

function parseBridgeUiChecklistItems(value: unknown): BridgeUiChecklistItem[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map(toBridgeUiChecklistItem)
    .filter((item): item is BridgeUiChecklistItem => item !== null);
}

function toBridgeUiChecklistItem(value: unknown): BridgeUiChecklistItem | null {
  const record = toRecord(value);
  if (!record) {
    return null;
  }

  const label = readString(record['label']);
  if (!label) {
    return null;
  }

  return {
    label,
    status: readBridgeUiChecklistStatus(record['status']),
    detail: readString(record['detail']) ?? undefined,
  };
}

function readBridgeUiChecklistStatus(value: unknown): BridgeUiChecklistItem['status'] | undefined {
  return value === 'pending' || value === 'inProgress' || value === 'completed' ? value : undefined;
}

function parseBridgeUiKeyValueItems(value: unknown): Array<{ label: string; value: string }> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map(toBridgeUiKeyValueItem)
    .filter((item): item is NonNullable<typeof item> => item !== null);
}

function toBridgeUiKeyValueItem(value: unknown): { label: string; value: string } | null {
  const record = toRecord(value);
  if (!record) {
    return null;
  }

  const label = readString(record['label']);
  const itemValue = readString(record['value']);
  return label && itemValue ? { label, value: itemValue } : null;
}
