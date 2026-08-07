import type {
  ReasoningEffort,
  ServiceTier,
  ChatMessage as ChatTranscriptMessage,
} from '@bridge/types/types';
import type { ActivityState } from '../state/runtime';
export type {
  ActivePlanState,
  ActivityState,
  SessionTokenTotals,
  ThreadContextUsage,
  ThreadRuntimeSnapshot,
} from '../state/runtime';

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface IdleTaskHandle {
  cancel: () => void;
}

export function scheduleIdleTask(task: () => void, timeout = 500): IdleTaskHandle {
  if (typeof globalThis.requestIdleCallback === 'function') {
    const handle = globalThis.requestIdleCallback(task, { timeout });
    return {
      cancel: () => {
        if (typeof globalThis.cancelIdleCallback === 'function') {
          globalThis.cancelIdleCallback(handle);
        }
      },
    };
  }

  const timeoutId = setTimeout(task, 0);
  return {
    cancel: () => {
      clearTimeout(timeoutId);
    },
  };
}

export interface PendingPlanImplementationPrompt {
  threadId: string;
  turnId: string;
}

export type AttachmentMenuAction =
  'workspace-path' | 'phone-file' | 'phone-image' | 'phone-camera' | null;

export type WorkspacePickerPurpose = 'default-start' | 'git-checkout-destination';

export interface ComposerAttachmentChip {
  id: string;
  label: string;
}

export interface PendingOptimisticUserMessage {
  message: ChatTranscriptMessage;
  userOrdinal: number;
}

export interface PendingOptimisticQueuedMessage {
  id: string;
  content: string;
  createdAt: string;
}

export interface AutoScrollState {
  shouldStickToBottom: boolean;
  isUserInteracting: boolean;
  isMomentumScrolling: boolean;
}

export interface SlashCommandDefinition {
  name: string;
  summary: string;
  argsHint?: string;
  mobileSupported: boolean;
  requiresOpenChat?: boolean;
  aliases?: string[];
  availabilityNote?: string;
}

export interface SlashCommandAvailability {
  hasOpenChat: boolean;
  supportsGoal: boolean;
  supportsPlanMode: boolean;
  supportsReview: boolean;
}

export const MAX_ACTIVE_COMMANDS = 16;
export const RUN_WATCHDOG_MS = 60_000;
export const LARGE_CHAT_MESSAGE_COUNT_THRESHOLD = 120;
export const CHAT_INITIAL_VISIBLE_MESSAGE_WINDOW = 80;
export const CHAT_MESSAGE_PAGE_SIZE = 80;
export const CHAT_AUTO_LOAD_OLDER_TOP_THRESHOLD_PX = 96;
export const CHAT_JUMP_TO_LATEST_MIN_SCROLLABLE_PX = 8;
export const WORKSPACE_FAVORITES_FILE = 'dappercode-workspace-favorites.json';
export const WORKSPACE_FAVORITES_VERSION = 1;
export const WORKSPACE_FAVORITES_LIMIT = 4;
export const LIKELY_RUNNING_RECENT_UPDATE_MS = 30_000;
export const UNANSWERED_USER_RUNNING_TTL_MS = 90_000;
export const ACTIVE_CHAT_SYNC_INTERVAL_MS = 2_000;
export const IDLE_CHAT_SYNC_INTERVAL_MS = 5_000;
export const BACKGROUND_CHAT_SYNC_INTERVAL_MS = 15_000;
export const AGENT_THREADS_SYNC_INTERVAL_MS = 10_000;
export const AGENT_THREADS_IDLE_SYNC_INTERVAL_MS = 20_000;
export const AGENT_THREADS_BACKGROUND_SYNC_INTERVAL_MS = 30_000;
export const AGENT_THREADS_LIST_LIMIT = 20;
export const APP_FOCUS_DISCONNECT_GRACE_MS = 5_000;
export const ACTIVITY_DETAIL_HOLD_MS = 2_500;
export const GENERIC_RUNNING_ACTIVITY_DELAY_MS = 1_200;
export const GENERIC_RUNNING_ACTIVITY_TITLES = new Set(['working', 'thinking']);

/**
 * The activity strip briefly holds a specific running status so it stays readable
 * even when a later generic "Working" would otherwise overwrite it. Returns the
 * status to hold, or `null` when nothing should be held.
 *
 * A non-running status returns `null`: a terminal or idle status supersedes the
 * held one, otherwise the stale running title reappears once the turn stops.
 */
export function resolveHeldActivity(activity: ActivityState): ActivityState | null {
  if (activity.tone !== 'running') {
    return null;
  }
  const title = activity.title.trim() || 'Working';
  const detail = activity.detail?.trim() ?? '';
  const shouldHold = Boolean(detail) || !GENERIC_RUNNING_ACTIVITY_TITLES.has(title.toLowerCase());
  if (!shouldHold) {
    return null;
  }
  return { tone: 'running', title, detail: detail || undefined };
}
export const CHAT_DRAFTS_FILE = 'chat-drafts.json';
export const CHAT_DRAFTS_VERSION = 2;
export const CHAT_MODEL_PREFERENCES_FILE = 'chat-model-preferences.json';
export const CHAT_MODEL_PREFERENCES_VERSION = 1;
export const CHAT_PLAN_SNAPSHOTS_FILE = 'chat-plan-snapshots.json';
export const CHAT_PLAN_SNAPSHOTS_VERSION = 1;
export const CHAT_BRIDGE_UI_SURFACES_FILE = 'chat-bridge-ui-surfaces.json';
export const CHAT_BRIDGE_UI_SURFACES_VERSION = 1;
export const CHAT_SUBMISSION_IDEMPOTENCY_FILE = 'chat-submission-idempotency.json';
export const CHAT_SUBMISSION_IDEMPOTENCY_VERSION = 1;
export const CHAT_NEW_DRAFT_KEY = '__new_chat__';
export const STREAMING_SCROLL_THROTTLE_MS = 48;
export const PLAN_IMPLEMENTATION_TITLE = 'Implement this plan?';
export const PLAN_IMPLEMENTATION_YES = 'Yes, implement this plan';
export const PLAN_IMPLEMENTATION_NO = 'No, stay in Plan mode';
export const PLAN_IMPLEMENTATION_CODING_MESSAGE = 'Implement the plan.';
export const INLINE_OPTION_LINE_PATTERN =
  /^(?:[-*+]\s*)?(?:\d{1,2}\s*[.):-]|\(\d{1,2}\)\s*[.):-]?|\[\d{1,2}\]\s*|[A-Ca-c]\s*[.):-]|\([A-Ca-c]\)\s*[.):-]?|option\s+\d{1,2}\s*[.):-]?)\s*(.+)$/i;
export const INLINE_CHOICE_CUE_PATTERNS = [
  /\bchoose\b/i,
  /\bselect\b/i,
  /\bpick\b/i,
  /\bwould you like\b/i,
  /\bshould i\b/i,
  /\bprefer\b/i,
  /\bconfirm\b/i,
  /\b(?:reply|respond)\s+with\b/i,
  /\blet me know\b.*\b(which|what|option|one)\b/i,
  /\bwhich\b.*\b(option|one)\b/i,
  /\bwhat\b.*\b(option|one)\b/i,
];
export const EXTERNAL_RUNNING_STATUS_HINTS = new Set([
  'running',
  'inprogress',
  'active',
  'queued',
  'pending',
]);
export const EXTERNAL_COMPLETE_STATUS_HINTS = new Set(['completed', 'success', 'succeeded']);
export const EXTERNAL_ERROR_STATUS_HINTS = new Set(['error', 'failed', 'cancelled', 'canceled']);

export interface ChatModelPreference {
  modelId: string | null;
  effort: ReasoningEffort | null;
  serviceTier: ServiceTier | null;
  updatedAt: string;
}

export type SelectedServiceTier = ServiceTier | null | undefined;

export const SLASH_COMMANDS: SlashCommandDefinition[] = [
  {
    name: 'permissions',
    summary: 'Set approvals and sandbox permissions',
    mobileSupported: false,
    availabilityNote: 'Available in the desktop CLI only right now.',
  },
  {
    name: 'agent',
    summary: 'Switch the active sub-agent thread',
    argsHint: '[thread]',
    mobileSupported: true,
    requiresOpenChat: true,
  },
  {
    name: 'apps',
    summary: 'Browse and insert apps/connectors',
    mobileSupported: false,
    availabilityNote: 'Available in the desktop CLI only right now.',
  },
  {
    name: 'diff',
    summary: 'Open Git view for current chat',
    mobileSupported: true,
    requiresOpenChat: true,
  },
  {
    name: 'exit',
    summary: 'Exit the desktop CLI',
    mobileSupported: false,
    availabilityNote: 'Not applicable on mobile.',
  },
  {
    name: 'experimental',
    summary: 'Toggle experimental features',
    mobileSupported: false,
    availabilityNote: 'Available in the desktop CLI only right now.',
  },
  {
    name: 'feedback',
    summary: 'Send feedback diagnostics',
    mobileSupported: false,
    availabilityNote: 'Available in the desktop CLI only right now.',
  },
  {
    name: 'goal',
    summary: 'Create or inspect an active goal',
    argsHint: '[objective]',
    mobileSupported: true,
  },
  {
    name: 'init',
    summary: 'Generate AGENTS.md scaffold',
    mobileSupported: false,
    availabilityNote: 'Available in the desktop CLI only right now.',
  },
  {
    name: 'logout',
    summary: 'Sign out from the desktop agent',
    mobileSupported: false,
    availabilityNote: 'Available in the desktop CLI only right now.',
  },
  {
    name: 'mcp',
    summary: 'List configured MCP tools',
    mobileSupported: false,
    availabilityNote: 'Available in the desktop CLI only right now.',
  },
  {
    name: 'mention',
    summary: 'Attach file/folder context to prompt',
    argsHint: '<path>',
    mobileSupported: false,
    availabilityNote: 'Available in the desktop CLI only right now.',
  },
  {
    name: 'model',
    summary: 'Open model picker or set model by id',
    argsHint: '<model-id>',
    mobileSupported: true,
  },
  {
    name: 'plan',
    summary: 'Toggle plan mode or run next prompt in plan mode',
    argsHint: '[prompt]',
    mobileSupported: true,
  },
  {
    name: 'personality',
    summary: 'Set response personality',
    argsHint: '<friendly|pragmatic|none>',
    mobileSupported: false,
    availabilityNote: 'Available in the desktop CLI only right now.',
  },
  {
    name: 'ps',
    summary: 'Show background terminal jobs',
    mobileSupported: false,
    availabilityNote: 'Available in the desktop CLI only right now.',
  },
  {
    name: 'resume',
    summary: 'Resume a saved conversation',
    mobileSupported: false,
    availabilityNote: 'Use chat list on mobile for now.',
  },
  {
    name: 'new',
    summary: 'Start a new conversation',
    mobileSupported: true,
  },
  {
    name: 'quit',
    summary: 'Exit the desktop CLI',
    mobileSupported: false,
    aliases: ['exit'],
    availabilityNote: 'Not applicable on mobile.',
  },
  {
    name: 'review',
    summary: 'Run review on uncommitted changes',
    mobileSupported: true,
    requiresOpenChat: true,
  },
  {
    name: 'status',
    summary: 'Show current session status',
    mobileSupported: true,
  },
  {
    name: 'debug-config',
    summary: 'Inspect config layers and diagnostics',
    mobileSupported: false,
    availabilityNote: 'Available in the desktop CLI only right now.',
  },
  {
    name: 'statusline',
    summary: 'Configure footer status-line fields',
    mobileSupported: false,
    availabilityNote: 'Available in the desktop CLI only right now.',
  },
  {
    name: 'approvals',
    summary: 'Alias for /permissions',
    mobileSupported: false,
    aliases: ['permissions'],
    availabilityNote: 'Alias supported in CLI; use /permissions there.',
  },
  {
    name: 'help',
    summary: 'List slash commands',
    mobileSupported: true,
  },
];

// ── Helpers ────────────────────────────────────────────────────────
