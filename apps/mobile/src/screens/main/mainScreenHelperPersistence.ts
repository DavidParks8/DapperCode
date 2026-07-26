import * as FileSystem from 'expo-file-system/legacy';
import type {
  BridgeQueuedMessage,
  BridgeThreadQueueError,
  BridgeThreadQueueState,
  BridgeUiSurface,
  TurnPlanStep,
} from '../../api/types';
import { normalizeWorkspacePath } from './mainScreenHelperAttachments';
import { toBridgeUiSurface } from './mainScreenHelperBridgeUi';
import {
  normalizeModelId,
  normalizeReasoningEffort,
  normalizeServiceTier,
  toSelectedServiceTier,
} from './mainScreenHelperPreferences';
import { readString, toRecord } from './mainScreenHelperPayloads';
import type { ActivePlanState, ChatModelPreference } from './mainScreenHelperTypes';
import {
  CHAT_BRIDGE_UI_SURFACES_FILE,
  CHAT_BRIDGE_UI_SURFACES_VERSION,
  CHAT_DRAFTS_FILE,
  CHAT_DRAFTS_VERSION,
  CHAT_MODEL_PREFERENCES_FILE,
  CHAT_MODEL_PREFERENCES_VERSION,
  CHAT_NEW_DRAFT_KEY,
  CHAT_PLAN_SNAPSHOTS_FILE,
  CHAT_PLAN_SNAPSHOTS_VERSION,
  WORKSPACE_FAVORITES_FILE,
  WORKSPACE_FAVORITES_LIMIT,
  WORKSPACE_FAVORITES_VERSION,
} from './mainScreenHelperTypes';

export function getChatModelPreferencesPath(): string | null {
  const base = FileSystem.documentDirectory;
  if (typeof base !== 'string' || base.trim().length === 0) {
    return null;
  }
  return `${base}${CHAT_MODEL_PREFERENCES_FILE}`;
}
export function getChatDraftsPath(): string | null {
  const base = FileSystem.documentDirectory;
  if (typeof base !== 'string' || base.trim().length === 0) {
    return null;
  }
  return `${base}${CHAT_DRAFTS_FILE}`;
}
export function getChatPlanSnapshotsPath(): string | null {
  const base = FileSystem.documentDirectory;
  if (typeof base !== 'string' || base.trim().length === 0) {
    return null;
  }
  return `${base}${CHAT_PLAN_SNAPSHOTS_FILE}`;
}
export function getChatBridgeUiSurfacesPath(): string | null {
  const base = FileSystem.documentDirectory;
  if (typeof base !== 'string' || base.trim().length === 0) {
    return null;
  }
  return `${base}${CHAT_BRIDGE_UI_SURFACES_FILE}`;
}
export function getWorkspaceFavoritesPath(): string | null {
  const base = FileSystem.documentDirectory;
  if (typeof base !== 'string' || base.trim().length === 0) {
    return null;
  }
  return `${base}${WORKSPACE_FAVORITES_FILE}`;
}

export function parseWorkspaceFavoritePaths(raw: string): string[] {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    const parsedRecord = toRecord(parsed);
    if (!parsedRecord || parsedRecord.version !== WORKSPACE_FAVORITES_VERSION) {
      return [];
    }

    const paths = Array.isArray(parsedRecord.paths) ? parsedRecord.paths : [];
    const normalizedPaths: string[] = [];
    for (const path of paths) {
      const normalizedPath = normalizeWorkspacePath(path);
      if (!normalizedPath || normalizedPaths.includes(normalizedPath)) {
        continue;
      }
      normalizedPaths.push(normalizedPath);
      if (normalizedPaths.length >= WORKSPACE_FAVORITES_LIMIT) {
        break;
      }
    }
    return normalizedPaths;
  } catch {
    return [];
  }
}

export function parseChatDrafts(raw: string): Record<string, string> {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw);
    const parsedRecord = toRecord(parsed);
    if (!parsedRecord || parsedRecord.version !== CHAT_DRAFTS_VERSION) {
      return {};
    }

    const entries = toRecord(parsedRecord.entries);
    if (!entries) {
      return {};
    }

    const result: Record<string, string> = {};
    for (const [rawKey, value] of Object.entries(entries)) {
      const normalizedKey = rawKey.trim();
      const text = readString(value)?.replace(/\r\n/g, '\n');
      if (!normalizedKey || !text || text.length === 0) {
        continue;
      }
      result[normalizedKey] = text;
    }

    return result;
  } catch {
    return {};
  }
}

export function parseBridgeThreadQueueState(value: unknown): BridgeThreadQueueState | null {
  const record = toRecord(value);
  const threadId = readString(record?.threadId)?.trim();
  if (!record || !threadId) {
    return null;
  }

  const items = Array.isArray(record.items)
    ? record.items
        .map((item) => {
          const entry = toRecord(item);
          const id = readString(entry?.id)?.trim();
          const createdAt = readString(entry?.createdAt)?.trim();
          const content = readString(entry?.content)?.replace(/\r\n/g, '\n');
          if (!id || !createdAt || !content) {
            return null;
          }

          return {
            id,
            createdAt,
            content,
          } satisfies BridgeQueuedMessage;
        })
        .filter((item): item is BridgeQueuedMessage => item !== null)
    : [];
  const pendingSteers = Array.isArray(record.pendingSteers)
    ? record.pendingSteers
        .map((item) => {
          const entry = toRecord(item);
          const id = readString(entry?.id)?.trim();
          const createdAt = readString(entry?.createdAt)?.trim();
          const content = readString(entry?.content)?.replace(/\r\n/g, '\n');
          return id && createdAt && content ? { id, createdAt, content } : null;
        })
        .filter((item): item is BridgeQueuedMessage => item !== null)
    : [];

  const lastErrorRecord = toRecord(record.lastError);
  const lastErrorMessage = readString(lastErrorRecord?.message)?.trim();
  const lastErrorOperation = readString(lastErrorRecord?.operation)?.trim();
  const lastErrorAt = readString(lastErrorRecord?.at)?.trim();
  const lastError =
    lastErrorMessage && lastErrorOperation && lastErrorAt
      ? ({
          message: lastErrorMessage,
          operation: lastErrorOperation,
          at: lastErrorAt,
          itemId: readString(lastErrorRecord?.itemId)?.trim() ?? null,
        } satisfies BridgeThreadQueueError)
      : null;

  return {
    threadId,
    items,
    pendingSteers,
    pendingSteerCount:
      typeof record.pendingSteerCount === 'number' && Number.isSafeInteger(record.pendingSteerCount)
        ? Math.max(0, record.pendingSteerCount)
        : pendingSteers.length,
    waitingForToolCalls: record.waitingForToolCalls === true,
    steeringInFlight: record.steeringInFlight === true,
    lastError,
  };
}

export function canOfferQueuedMessageSteer(options: {
  hasQueuedMessage: boolean;
  hasSelectedThread: boolean;
  supportsSteer: boolean;
  isPendingSteer: boolean;
  isOptimistic: boolean;
  actionInFlight: boolean;
}): boolean {
  return (
    options.hasQueuedMessage &&
    options.hasSelectedThread &&
    options.supportsSteer &&
    !options.isPendingSteer &&
    !options.isOptimistic &&
    !options.actionInFlight
  );
}

export function queuedMessageStatusLabel(options: {
  pendingSubmission: boolean;
  steeringActive: boolean;
  steeringInFlight: boolean;
  steerPending: boolean;
  waitingForToolCalls: boolean;
}): string {
  if (options.pendingSubmission) {
    return 'Queueing message';
  }
  if (options.steeringActive || options.steeringInFlight) {
    return 'Steering turn';
  }
  if (options.steerPending && options.waitingForToolCalls) {
    return 'Will steer after the current tool finishes';
  }
  if (options.steerPending) {
    return 'Waiting to steer';
  }
  return 'Queued message';
}

export function getDraftScopeKey(threadId: string | null | undefined): string {
  const normalized = threadId?.trim();
  return normalized && normalized.length > 0 ? normalized : CHAT_NEW_DRAFT_KEY;
}

export function parseChatModelPreferences(raw: string): Record<string, ChatModelPreference> {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw);
    const parsedRecord = toRecord(parsed);
    if (!parsedRecord || parsedRecord.version !== CHAT_MODEL_PREFERENCES_VERSION) {
      return {};
    }

    const entries = toRecord(parsedRecord.entries);
    if (!entries) {
      return {};
    }

    const result: Record<string, ChatModelPreference> = {};
    for (const [chatId, value] of Object.entries(entries)) {
      const entry = toRecord(value);
      if (!entry) {
        continue;
      }

      const normalizedChatId = chatId.trim();
      if (!normalizedChatId) {
        continue;
      }

      result[normalizedChatId] = {
        modelId: normalizeModelId(readString(entry.modelId)),
        effort: normalizeReasoningEffort(readString(entry.effort)),
        serviceTier: toSelectedServiceTier(normalizeServiceTier(readString(entry.serviceTier))),
        updatedAt: readString(entry.updatedAt) ?? new Date(0).toISOString(),
      };
    }

    return result;
  } catch {
    return {};
  }
}

export function parseChatPlanSnapshots(raw: string): Record<string, ActivePlanState> {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw);
    const parsedRecord = toRecord(parsed);
    if (!parsedRecord || parsedRecord.version !== CHAT_PLAN_SNAPSHOTS_VERSION) {
      return {};
    }

    const entries = toRecord(parsedRecord.entries);
    if (!entries) {
      return {};
    }

    const result: Record<string, ActivePlanState> = {};
    for (const [chatId, value] of Object.entries(entries)) {
      const entry = toRecord(value);
      if (!entry) {
        continue;
      }

      const normalizedChatId = chatId.trim();
      const threadId = readString(entry.threadId) ?? normalizedChatId;
      const turnId = readString(entry.turnId);
      if (!normalizedChatId || !threadId || !turnId) {
        continue;
      }

      const rawSteps = Array.isArray(entry.steps) ? entry.steps : [];
      const steps: TurnPlanStep[] = rawSteps
        .map((item) => {
          const itemRecord = toRecord(item);
          if (!itemRecord) {
            return null;
          }

          const step = readString(itemRecord.step);
          const status = readString(itemRecord.status);
          if (
            !step ||
            (status !== 'pending' && status !== 'inProgress' && status !== 'completed')
          ) {
            return null;
          }

          return {
            step,
            status,
          } satisfies TurnPlanStep;
        })
        .filter((item): item is TurnPlanStep => item !== null);

      result[normalizedChatId] = {
        threadId,
        turnId,
        explanation: readString(entry.explanation),
        steps,
        deltaText: readString(entry.deltaText) ?? '',
        updatedAt: readString(entry.updatedAt) ?? new Date(0).toISOString(),
      };
    }

    return result;
  } catch {
    return {};
  }
}

export function parseChatBridgeUiSurfaces(raw: string): Record<string, BridgeUiSurface[]> {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw);
    const parsedRecord = toRecord(parsed);
    if (!parsedRecord || parsedRecord.version !== CHAT_BRIDGE_UI_SURFACES_VERSION) {
      return {};
    }

    const entries = toRecord(parsedRecord.entries);
    if (!entries) {
      return {};
    }

    const result: Record<string, BridgeUiSurface[]> = {};
    for (const [chatId, value] of Object.entries(entries)) {
      const normalizedChatId = chatId.trim();
      if (!normalizedChatId || !Array.isArray(value)) {
        continue;
      }

      const surfaces = value
        .map(toBridgeUiSurface)
        .filter(
          (surface): surface is BridgeUiSurface =>
            surface !== null && surface.threadId === normalizedChatId,
        );
      if (surfaces.length > 0) {
        result[normalizedChatId] = surfaces;
      }
    }

    return result;
  } catch {
    return {};
  }
}
