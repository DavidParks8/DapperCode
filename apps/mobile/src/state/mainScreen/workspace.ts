import type {
  Chat,
  ChatSummary,
  FileSystemEntry,
  FileSystemListResponse,
  WorkspaceSummary,
} from '../../api/types';
import type { AppScreen } from '../../app/appConstants';
import type { WorkspacePickerPurpose } from '../../screens/mainScreenHelpers';
import { screenAtom } from './registry';


export const relatedAgentThreadsAtom = screenAtom<ChatSummary[]>(() => []);

export const agentRootThreadIdAtom = screenAtom<string | null>(null);

export const agentRuntimeRevisionAtom = screenAtom(0);

export const loadingAgentThreadsAtom = screenAtom(false);

export const agentDetailThreadIdAtom = screenAtom<string | null>(null);

export const agentDetailStackAtom = screenAtom<string[]>(() => []);

export const agentDetailChatAtom = screenAtom<Chat | null>(null);

export const agentDetailParentChatAtom = screenAtom<Chat | null>(null);

export const agentDetailLoadingAtom = screenAtom(false);

export const agentDetailErrorAtom = screenAtom<string | null>(null);

export const workspacePickerPurposeAtom = screenAtom<WorkspacePickerPurpose>('default-start');

export const workspaceRootsAtom = screenAtom<WorkspaceSummary[]>(() => []);

export const workspaceBridgeRootAtom = screenAtom<string | null>(null);

export const workspaceBrowsePathAtom = screenAtom<string | null>(null);

export const workspaceBrowseParentPathAtom = screenAtom<string | null>(null);

export const workspaceBrowseEntriesAtom = screenAtom<FileSystemEntry[]>(() => []);

export const loadingWorkspaceBrowseAtom = screenAtom(false);

export const workspaceBrowseErrorAtom = screenAtom<string | null>(null);

export const workspaceBrowseTruncationAtom = screenAtom<string | null>(null);

export const favoriteWorkspacePathsAtom = screenAtom<string[]>(() => []);

export const workspaceBrowseCacheAtom = screenAtom<Record<string, FileSystemListResponse>>(
  () => ({})
);

export const workspaceBrowseRequestIdAtom = screenAtom(0);

/** Where closing the workspace picker returns to when it was not opened for a git checkout. */
export const workspacePickerReturnScreenAtom = screenAtom<AppScreen>('Main');
