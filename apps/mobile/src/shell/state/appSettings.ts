import type { AgentDefaultSettingsMap, AgentId, ApprovalMode } from '@bridge/types/types';
import {
  dedupeRecentPreviewTargets,
  normalizePreviewTargetInput,
} from '../../features/browser/preview';

export const APP_SETTINGS_VERSION = 13;
export const DEFAULT_WORKSPACE_CHAT_LIMIT = 5;
export const RECENT_MODEL_LIMIT = 3;
export const WORKSPACE_CHAT_LIMIT_OPTIONS = [5, 10, 25, null] as const;
export type WorkspaceChatLimit = (typeof WORKSPACE_CHAT_LIMIT_OPTIONS)[number];
export type RecentModelIdsByAgent = Record<AgentId, string[]>;

export function parseAppSettings(raw: string): {
  defaultStartCwd: string | null;
  preferredAgentId: AgentId | null;
  agentSettings: AgentDefaultSettingsMap;
  approvalMode: ApprovalMode;
  showToolCalls: boolean;
  confirmSessionDeletion: boolean;
  workspaceChatLimit: WorkspaceChatLimit;
  recentBrowserTargetUrls: string[];
  recentModelIdsByAgent: RecentModelIdsByAgent;
} {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return {
      defaultStartCwd: null,
      preferredAgentId: null,
      agentSettings: {},
      approvalMode: 'normal',
      showToolCalls: true,
      confirmSessionDeletion: true,
      workspaceChatLimit: DEFAULT_WORKSPACE_CHAT_LIMIT,
      recentBrowserTargetUrls: [],
      recentModelIdsByAgent: {},
    };
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    const parsedVersion = (parsed as { version?: unknown }).version;
    if (!parsed || typeof parsed !== 'object' || parsedVersion !== APP_SETTINGS_VERSION) {
      return {
        defaultStartCwd: null,
        preferredAgentId: null,
        agentSettings: {},
        approvalMode: 'normal',
        showToolCalls: true,
        confirmSessionDeletion: true,
        workspaceChatLimit: DEFAULT_WORKSPACE_CHAT_LIMIT,
        recentBrowserTargetUrls: [],
        recentModelIdsByAgent: {},
      };
    }

    return {
      defaultStartCwd: normalizeDefaultStartCwd(
        (parsed as { defaultStartCwd?: unknown }).defaultStartCwd,
      ),
      preferredAgentId: normalizeAgentId(
        (parsed as { preferredAgentId?: unknown }).preferredAgentId,
      ),
      agentSettings: normalizeAgentSettings((parsed as { agentSettings?: unknown }).agentSettings),
      approvalMode: normalizeStoredApprovalMode(
        (parsed as { approvalMode?: unknown }).approvalMode,
      ),
      showToolCalls:
        typeof (parsed as { showToolCalls?: unknown }).showToolCalls === 'undefined'
          ? true
          : normalizeBoolean((parsed as { showToolCalls?: unknown }).showToolCalls),
      confirmSessionDeletion:
        typeof (parsed as { confirmSessionDeletion?: unknown }).confirmSessionDeletion === 'boolean'
          ? (parsed as { confirmSessionDeletion: boolean }).confirmSessionDeletion
          : true,
      workspaceChatLimit: normalizeWorkspaceChatLimit(
        (parsed as { workspaceChatLimit?: unknown }).workspaceChatLimit,
      ),
      recentBrowserTargetUrls: normalizeBrowserTargetUrls(
        (parsed as { recentBrowserTargetUrls?: unknown }).recentBrowserTargetUrls,
      ),
      recentModelIdsByAgent: normalizeRecentModelIdsByAgent(
        (parsed as { recentModelIdsByAgent?: unknown }).recentModelIdsByAgent,
      ),
    };
  } catch {
    return {
      defaultStartCwd: null,
      preferredAgentId: null,
      agentSettings: {},
      approvalMode: 'normal',
      showToolCalls: true,
      confirmSessionDeletion: true,
      workspaceChatLimit: DEFAULT_WORKSPACE_CHAT_LIMIT,
      recentBrowserTargetUrls: [],
      recentModelIdsByAgent: {},
    };
  }
}

function normalizeDefaultStartCwd(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeWorkspaceChatLimit(value: unknown): WorkspaceChatLimit {
  if (value === null || value === 'all') {
    return null;
  }

  const numericValue =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseInt(value.trim(), 10)
        : Number.NaN;

  return numericValue === 10 || numericValue === 25
    ? numericValue
    : numericValue === 5
      ? 5
      : DEFAULT_WORKSPACE_CHAT_LIMIT;
}

function normalizeAgentId(value: unknown): AgentId | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeAgentSettings(value: unknown): AgentDefaultSettingsMap {
  const normalized: AgentDefaultSettingsMap = {};
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  if (!record) {
    return normalized;
  }
  for (const [rawAgentId, rawEntry] of Object.entries(record)) {
    const agentId = normalizeAgentId(rawAgentId);
    const entry =
      rawEntry && typeof rawEntry === 'object' ? (rawEntry as Record<string, unknown>) : null;
    if (!agentId || !entry) {
      continue;
    }
    normalized[agentId] = {
      collaborationMode: normalizeCollaborationMode(entry['collaborationMode']),
    };
  }
  return normalized;
}

function normalizeCollaborationMode(value: unknown): 'default' | 'plan' {
  if (typeof value !== 'string') {
    return 'default';
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'plan') {
    return normalized;
  }
  return 'default';
}

function normalizeBrowserTargetUrls(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return dedupeRecentPreviewTargets(
    value
      .map((entry) => (typeof entry === 'string' ? normalizePreviewTargetInput(entry) : null))
      .filter((entry): entry is string => typeof entry === 'string'),
  );
}

function normalizeRecentModelIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const entry of value) {
    const modelId = typeof entry === 'string' ? entry.trim() : '';
    if (!modelId || seen.has(modelId)) {
      continue;
    }
    seen.add(modelId);
    normalized.push(modelId);
    if (normalized.length >= RECENT_MODEL_LIMIT) {
      break;
    }
  }
  return normalized;
}

function normalizeRecentModelIdsByAgent(value: unknown): RecentModelIdsByAgent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const normalized: RecentModelIdsByAgent = {};
  for (const [rawAgentId, rawModelIds] of Object.entries(value)) {
    const agentId = normalizeAgentId(rawAgentId);
    const modelIds = normalizeRecentModelIds(rawModelIds);
    if (agentId && modelIds.length > 0) {
      normalized[agentId] = modelIds;
    }
  }
  return normalized;
}

export function pushRecentModelId(currentValues: readonly string[], nextValue: string): string[] {
  return normalizeRecentModelIds([nextValue, ...currentValues]);
}

function normalizeStoredApprovalMode(value: unknown): ApprovalMode {
  return value === 'yolo' ? 'yolo' : 'normal';
}

function normalizeBoolean(value: unknown): boolean {
  return value === true;
}
