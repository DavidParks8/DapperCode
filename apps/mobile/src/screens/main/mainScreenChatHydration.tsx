import {
  defaultServiceTierAtom,
  selectedEffortAtom,
  selectedModelIdAtom,
  selectedServiceTierAtom,
} from '../../state/mainScreen/models';
import {
  loadWorkspaceFavoritesAtom,
  toggleWorkspaceFavoriteAtom,
} from '../../state/mainScreen/workspaceActions';
import { useSetAtom } from 'jotai';
import { useCallback, useEffect } from 'react';
import type { BridgeUiSurface, ReasoningEffort, ServiceTier } from '../../api/types';
import {
  type ActivePlanState,
  type ChatModelPreference,
  normalizeModelId,
  normalizeReasoningEffort,
  normalizeServiceTier,
  toSelectedServiceTier,
} from './mainScreenHelpers';
import { agentModelPreferenceKey } from './mainScreenHelperPreferences';
import type {
  MainScreenThreadSnapshotStoreContext,
  MainScreenThreadSnapshotStoreResult,
} from './mainScreenThreadSnapshotStore';

export type MainScreenChatHydrationContext = MainScreenThreadSnapshotStoreContext &
  MainScreenThreadSnapshotStoreResult;

const PLAN_SNAPSHOT_FIELDS = ['turnId', 'explanation', 'deltaText', 'updatedAt'] as const;

function normalizePersistedChatId(chatId: string | null | undefined): string {
  return typeof chatId === 'string' ? chatId.trim() : '';
}

function arePlanSnapshotsEqual(
  previous: ActivePlanState | null | undefined,
  next: ActivePlanState | null,
): boolean {
  for (const field of PLAN_SNAPSHOT_FIELDS) {
    if (previous?.[field] !== next?.[field]) {
      return false;
    }
  }
  return JSON.stringify(previous?.steps ?? []) === JSON.stringify(next?.steps ?? []);
}

function replaceSnapshotEntry<T>(
  snapshots: Record<string, T>,
  chatId: string,
  value: T | null,
): Record<string, T> {
  const nextSnapshots = { ...snapshots };
  if (value) {
    nextSnapshots[chatId] = value;
    return nextSnapshots;
  }
  delete nextSnapshots[chatId];
  return nextSnapshots;
}

function matchesChatModelPreference(
  previous: ChatModelPreference | null | undefined,
  nextPreference: ChatModelPreference,
): boolean {
  return (
    previous?.modelId === nextPreference.modelId &&
    previous?.effort === nextPreference.effort &&
    previous?.serviceTier === nextPreference.serviceTier
  );
}

function shouldSkipChatModelPreferenceUpdate(
  previous: ChatModelPreference | null | undefined,
  previousAgent: ChatModelPreference | null | undefined,
  nextPreference: ChatModelPreference,
  agentPreferenceKey: string | null,
): boolean {
  if (!matchesChatModelPreference(previous, nextPreference)) {
    return false;
  }
  if (!agentPreferenceKey) {
    return true;
  }
  return matchesChatModelPreference(previousAgent, nextPreference);
}

export function useMainScreenChatHydration(context: MainScreenChatHydrationContext) {
  const {
    activeAgentId,
    bridgeUiSurfacePersistenceTimeoutRef,
    bridgeUiSurfaceSnapshotsRef,
    chatIdRef,
    chatModelPreferencesRef,
    chatPlanSnapshotsRef,
    persistenceController,
    saveBridgeUiSurfaceSnapshots,
    saveChatModelPreferences,
    saveChatPlanSnapshots,
    scheduleBridgeUiSurfaceSnapshotsPersist,
    setChatModelPreferencesLoaded,
  } = context;
  const setSelectedModelId = useSetAtom(selectedModelIdAtom);
  const setSelectedEffort = useSetAtom(selectedEffortAtom);
  const setSelectedServiceTier = useSetAtom(selectedServiceTierAtom);
  const setDefaultServiceTier = useSetAtom(defaultServiceTierAtom);
  const loadWorkspaceFavorites = useSetAtom(loadWorkspaceFavoritesAtom);
  const toggleWorkspaceFavorite = useSetAtom(toggleWorkspaceFavoriteAtom);

  useEffect(() => {
    void loadWorkspaceFavorites();
  }, [loadWorkspaceFavorites]);

  useEffect(() => {
    return () => {
      const existingTimer = bridgeUiSurfacePersistenceTimeoutRef.current;
      if (existingTimer) {
        clearTimeout(existingTimer);
        bridgeUiSurfacePersistenceTimeoutRef.current = null;
      }
      void saveBridgeUiSurfaceSnapshots(bridgeUiSurfaceSnapshotsRef.current);
    };
  }, [
    bridgeUiSurfacePersistenceTimeoutRef,
    bridgeUiSurfaceSnapshotsRef,
    saveBridgeUiSurfaceSnapshots,
  ]);

  const rememberChatPlanSnapshot = useCallback(
    (chatId: string, plan: ActivePlanState | null) => {
      const normalizedChatId = normalizePersistedChatId(chatId);
      if (!normalizedChatId) {
        return;
      }

      const previous = chatPlanSnapshotsRef.current[normalizedChatId] ?? null;
      if (arePlanSnapshotsEqual(previous, plan)) {
        return;
      }

      const nextSnapshots = replaceSnapshotEntry(
        chatPlanSnapshotsRef.current,
        normalizedChatId,
        plan,
      );
      chatPlanSnapshotsRef.current = nextSnapshots;
      void saveChatPlanSnapshots(nextSnapshots);
    },
    [chatPlanSnapshotsRef, saveChatPlanSnapshots],
  );

  const rememberBridgeUiSurfaceSnapshots = useCallback(
    (chatId: string, updater: (previous: BridgeUiSurface[]) => BridgeUiSurface[]) => {
      const normalizedChatId = normalizePersistedChatId(chatId);
      if (!normalizedChatId) {
        return;
      }

      const previous = bridgeUiSurfaceSnapshotsRef.current[normalizedChatId] ?? [];
      const nextSurfaces = updater(previous);
      const nextSnapshots = replaceSnapshotEntry(
        bridgeUiSurfaceSnapshotsRef.current,
        normalizedChatId,
        nextSurfaces.length > 0 ? nextSurfaces : null,
      );
      bridgeUiSurfaceSnapshotsRef.current = nextSnapshots;
      scheduleBridgeUiSurfaceSnapshotsPersist(nextSnapshots);
    },
    [bridgeUiSurfaceSnapshotsRef, scheduleBridgeUiSurfaceSnapshotsPersist],
  );

  const rememberChatModelPreference = useCallback(
    (
      chatId: string | null | undefined,
      modelId: string | null | undefined,
      effort: ReasoningEffort | null | undefined,
      serviceTier: ServiceTier | null | undefined,
    ) => {
      const normalizedChatId = normalizePersistedChatId(chatId);
      if (!normalizedChatId) {
        return;
      }

      const normalizedModelId = normalizeModelId(modelId);
      const normalizedEffort = normalizeReasoningEffort(effort);
      const normalizedServiceTier = toSelectedServiceTier(normalizeServiceTier(serviceTier));
      const updatedAt = new Date().toISOString();
      const nextPreference: ChatModelPreference = {
        modelId: normalizedModelId,
        effort: normalizedEffort,
        serviceTier: normalizedServiceTier,
        updatedAt,
      };
      const agentPreferenceKey = activeAgentId ? agentModelPreferenceKey(activeAgentId) : null;
      const previous = chatModelPreferencesRef.current[normalizedChatId] ?? null;
      const previousAgent = agentPreferenceKey
        ? (chatModelPreferencesRef.current[agentPreferenceKey] ?? null)
        : null;
      if (
        shouldSkipChatModelPreferenceUpdate(
          previous,
          previousAgent,
          nextPreference,
          agentPreferenceKey,
        )
      ) {
        return;
      }

      const nextPreferences: Record<string, ChatModelPreference> = {
        ...chatModelPreferencesRef.current,
        [normalizedChatId]: nextPreference,
        ...(agentPreferenceKey ? { [agentPreferenceKey]: nextPreference } : {}),
      };
      chatModelPreferencesRef.current = nextPreferences;
      if (chatIdRef.current === normalizedChatId) {
        setSelectedModelId(normalizedModelId);
        setSelectedEffort(normalizedEffort);
        setSelectedServiceTier(normalizedServiceTier);
      }
      void saveChatModelPreferences(nextPreferences);
    },
    [
      activeAgentId,
      chatIdRef,
      chatModelPreferencesRef,
      saveChatModelPreferences,
      setSelectedEffort,
      setSelectedModelId,
      setSelectedServiceTier,
    ],
  );

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      const preferences = await persistenceController.loadModelPreferences();
      if (!cancelled) {
        // Selections made while the file was loading are newer than anything on disk.
        chatModelPreferencesRef.current = {
          ...preferences,
          ...chatModelPreferencesRef.current,
        };
        setChatModelPreferencesLoaded(true);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [chatModelPreferencesRef, persistenceController, setChatModelPreferencesLoaded]);

  useEffect(() => {
    setDefaultServiceTier(null);
  }, [activeAgentId, setDefaultServiceTier]);

  return {
    toggleWorkspaceFavorite,
    rememberChatPlanSnapshot,
    rememberBridgeUiSurfaceSnapshots,
    rememberChatModelPreference,
  };
}

export type MainScreenChatHydrationResult = ReturnType<typeof useMainScreenChatHydration>;
