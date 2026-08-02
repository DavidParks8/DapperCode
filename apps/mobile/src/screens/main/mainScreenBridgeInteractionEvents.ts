import {
  activeBridgeUiSurfacesAtom,
  pendingApprovalAtom,
  pendingUserInputRequestAtom,
  resolvingUserInputAtom,
  userInputDraftsAtom,
  userInputErrorAtom,
} from '../../state/mainScreen/turn';
import { selectedCollaborationModeAtom } from '../../state/mainScreen/models';
import { screenSetter } from '../../state/mainScreen/registry';
import { activityAtom } from '../../state/mainScreen/composer';
import type { RpcNotification } from '../../api/types';
import { lookupDispatchEntry, readString, toRecord } from '../../runtimeValidation';
import {
  toPendingUserInputRequest,
  buildUserInputDrafts,
  parseBridgeThreadQueueState,
  toPendingApproval,
  toBridgeUiSurface,
  upsertBridgeUiSurfaceList,
  removeBridgeUiSurfaceFromList,
} from './mainScreenHelpers';
import type { MainScreenWsEventRouterContext } from './mainScreenWsEventRouter';

export function processBridgeInteractionEvents(
  context: MainScreenWsEventRouterContext,
  event: RpcNotification,
  currentId: string | null,
  pendingApprovalId: string | undefined,
  pendingUserInputRequestId: string | undefined,
): void {
  const {
    cacheThreadQueueState,
    cacheThreadPendingApproval,
    cacheThreadActivity,
    clearRunWatchdog,
    cacheThreadPendingUserInputRequest,
    threadRuntimeSnapshotsRef,
    bumpRunWatchdog,
    cacheThreadBridgeUiSurface,
    removeThreadBridgeUiSurface,
    store,
  } = context;
  const setPendingApproval = screenSetter(store, pendingApprovalAtom);
  const setPendingUserInputRequest = screenSetter(store, pendingUserInputRequestAtom);
  const setUserInputDrafts = screenSetter(store, userInputDraftsAtom);
  const setUserInputError = screenSetter(store, userInputErrorAtom);
  const setResolvingUserInput = screenSetter(store, resolvingUserInputAtom);
  const setActiveBridgeUiSurfaces = screenSetter(store, activeBridgeUiSurfacesAtom);
  const setSelectedCollaborationMode = screenSetter(store, selectedCollaborationModeAtom);
  const setActivity = screenSetter(store, activityAtom);

  const handlers: Partial<Record<string, () => void>> = {
    'bridge/thread/queue/updated': () => {
      const parsed = parseBridgeThreadQueueState(event.params);
      if (!parsed) {
        return;
      }
      cacheThreadQueueState(parsed.threadId, parsed);
    },
    'bridge/approval.requested': () => {
      const parsed = toPendingApproval(event.params);
      if (!parsed) {
        return;
      }
      const nextActivity = {
        tone: 'idle' as const,
        title: 'Waiting for approval',
        detail: parsed.command ?? parsed.kind,
      };
      cacheThreadPendingApproval(parsed.threadId, parsed);
      cacheThreadActivity(parsed.threadId, nextActivity);
      if (parsed.threadId !== currentId) {
        return;
      }
      clearRunWatchdog();
      setPendingApproval(parsed);
      setActivity(nextActivity);
    },
    'bridge/userInput.requested': () => {
      const parsed = toPendingUserInputRequest(event.params);
      if (!parsed) {
        return;
      }
      const nextActivity = {
        tone: 'idle' as const,
        title: 'Clarification needed',
        detail: parsed.questions[0]?.header ?? 'Answer required',
      };
      cacheThreadPendingUserInputRequest(parsed.threadId, parsed);
      cacheThreadActivity(parsed.threadId, nextActivity);
      if (parsed.threadId !== currentId) {
        return;
      }
      setSelectedCollaborationMode('plan');
      clearRunWatchdog();
      setPendingUserInputRequest(parsed);
      setUserInputDrafts(buildUserInputDrafts(parsed));
      setUserInputError(null);
      setResolvingUserInput(false);
      setActivity(nextActivity);
    },
    'bridge/userInput.resolved': () => {
      const params = toRecord(event.params);
      const resolvedId = readString(params?.id);
      const selectedPendingUserInputId = currentId
        ? (threadRuntimeSnapshotsRef.current[currentId]?.pendingUserInputRequest?.requestId ??
          pendingUserInputRequestId)
        : pendingUserInputRequestId;
      if (resolvedId) {
        for (const [threadId, snapshot] of Object.entries(threadRuntimeSnapshotsRef.current)) {
          if (snapshot.pendingUserInputRequest?.requestId !== resolvedId) {
            continue;
          }
          cacheThreadPendingUserInputRequest(threadId, null);
          cacheThreadActivity(threadId, {
            tone: 'running',
            title: 'Input submitted',
          });
        }
      }
      if (!selectedPendingUserInputId || resolvedId !== selectedPendingUserInputId) {
        return;
      }
      bumpRunWatchdog();
      setPendingUserInputRequest(null);
      setUserInputDrafts({});
      setUserInputError(null);
      setResolvingUserInput(false);
      setActivity({
        tone: 'running',
        title: 'Input submitted',
      });
    },
    'bridge/ui.present': () => {
      upsertBridgeUiSurface();
    },
    'bridge/ui.update': () => {
      upsertBridgeUiSurface();
    },
    'bridge/ui.dismiss': () => {
      const params = toRecord(event.params);
      const surfaceId = readString(params?.id);
      const threadId = readString(params?.threadId);
      if (!surfaceId) {
        return;
      }
      removeThreadBridgeUiSurface(surfaceId, threadId);
      setActiveBridgeUiSurfaces((previous) => removeBridgeUiSurfaceFromList(previous, surfaceId));
    },
    'bridge/approval.resolved': () => {
      const params = toRecord(event.params);
      const resolvedId = readString(params?.id);
      const selectedPendingApprovalId = currentId
        ? (threadRuntimeSnapshotsRef.current[currentId]?.pendingApproval?.requestId ??
          pendingApprovalId)
        : pendingApprovalId;
      if (resolvedId) {
        for (const [threadId, snapshot] of Object.entries(threadRuntimeSnapshotsRef.current)) {
          if (snapshot.pendingApproval?.requestId !== resolvedId) {
            continue;
          }
          cacheThreadPendingApproval(threadId, null);
          cacheThreadActivity(threadId, {
            tone: 'running',
            title: 'Approval resolved',
          });
        }
      }
      if (!selectedPendingApprovalId || resolvedId !== selectedPendingApprovalId) {
        return;
      }
      bumpRunWatchdog();
      setPendingApproval(null);
      setActivity({
        tone: 'running',
        title: 'Approval resolved',
      });
    },
  };

  function upsertBridgeUiSurface() {
    const surface = toBridgeUiSurface(event.params);
    if (!surface) {
      return;
    }
    cacheThreadBridgeUiSurface(surface.threadId, surface);
    if (surface.threadId === currentId) {
      setActiveBridgeUiSurfaces((previous) => upsertBridgeUiSurfaceList(previous, surface));
    }
  }

  lookupDispatchEntry(handlers, event.method)?.();
}
