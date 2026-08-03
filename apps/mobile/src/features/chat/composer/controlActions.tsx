import { errorAtom } from '../state/turn';
import {
  selectedAcpModeIdAtom,
  selectedCollaborationModeAtom,
  selectedEffortAtom,
  selectedModelIdAtom,
  selectedServiceTierAtom,
} from '../state/models';
import { activityAtom } from '../state/composer';
import { useSetAtom } from 'jotai';
import { useCallback, useEffect, useMemo } from 'react';
import type { AgentId, ServiceTier } from '@bridge/types/types';
import type { SelectionSheetOption } from '@shared/ui/SelectionSheet';
import { normalizeModelId } from '../helpers/helpers';
import { agentModelPreferenceKey } from '../helpers/preferences';
import { ATTACHMENT_MAX_LABEL } from './controllers/attachmentController';
import type {
  MainScreenModeConfigurationSessionContext,
  MainScreenModeConfigurationSessionResult,
} from '../models/modeConfigurationSession';
import {
  agentModalVisibleAtom,
  collaborationModeMenuVisibleAtom,
  effortModalVisibleAtom,
  effortPickerModelIdAtom,
  modelModalVisibleAtom,
} from '../state/modals';

export type MainScreenComposerControlActionsContext = MainScreenModeConfigurationSessionContext &
  MainScreenModeConfigurationSessionResult;

export function useMainScreenComposerControlActions(
  context: MainScreenComposerControlActionsContext,
) {
  const {
    activeServiceTier,
    activeAgentId,
    chatModelPreferencesRef,
    agentSettings,
    applyAcpConfigOption,
    attachmentController,
    attachmentPickerBusy,
    hasFailedAttachmentUploads,
    modelConfig,
    modelOptions,
    refreshModelOptions,
    rememberChatModelPreference,
    saveChatModelPreferences,
    retryFailedUploads,
    selectedChatId,
    setPendingAgentId,
    supportsFastMode,
    uploadingAttachment,
    ws,
  } = context;
  const setError = useSetAtom(errorAtom);
  const setSelectedModelId = useSetAtom(selectedModelIdAtom);
  const setSelectedEffort = useSetAtom(selectedEffortAtom);
  const setSelectedServiceTier = useSetAtom(selectedServiceTierAtom);
  const setSelectedCollaborationMode = useSetAtom(selectedCollaborationModeAtom);
  const setSelectedAcpModeId = useSetAtom(selectedAcpModeIdAtom);
  const setActivity = useSetAtom(activityAtom);
  const setModelModalVisible = useSetAtom(modelModalVisibleAtom);
  const setAgentModalVisible = useSetAtom(agentModalVisibleAtom);
  const setCollaborationModeMenuVisible = useSetAtom(collaborationModeMenuVisibleAtom);
  const setEffortModalVisible = useSetAtom(effortModalVisibleAtom);
  const setEffortPickerModelId = useSetAtom(effortPickerModelIdAtom);

  const selectModel = useCallback(
    (modelId: string | null) => {
      const normalizedModelId = normalizeModelId(modelId);
      if (normalizedModelId && modelConfig) {
        if (
          !applyAcpConfigOption(
            modelConfig,
            normalizedModelId,
            selectedChatId
              ? () =>
                  rememberChatModelPreference(
                    selectedChatId,
                    normalizedModelId,
                    null,
                    activeServiceTier,
                  )
              : undefined,
          )
        ) {
          return;
        }
      }
      setSelectedModelId(normalizedModelId);
      setSelectedEffort(null);
      setModelModalVisible(false);
      setError(null);
      if (selectedChatId) {
        if (!modelConfig) {
          rememberChatModelPreference(selectedChatId, normalizedModelId, null, activeServiceTier);
        }
      } else if (activeAgentId) {
        const key = agentModelPreferenceKey(activeAgentId);
        const nextPreferences = {
          ...chatModelPreferencesRef.current,
          [key]: {
            modelId: normalizedModelId,
            effort: null,
            serviceTier: activeServiceTier,
            updatedAt: new Date().toISOString(),
          },
        };
        chatModelPreferencesRef.current = nextPreferences;
        void saveChatModelPreferences(nextPreferences);
      }

      if (normalizedModelId) {
        const model = modelOptions.find((entry) => entry.id === normalizedModelId) ?? null;
        if ((model?.reasoningEffort?.length ?? 0) > 0) {
          setEffortPickerModelId(normalizedModelId);
          setEffortModalVisible(true);
        }
      }
    },
    [
      activeServiceTier,
      activeAgentId,
      applyAcpConfigOption,
      chatModelPreferencesRef,
      modelConfig,
      modelOptions,
      rememberChatModelPreference,
      saveChatModelPreferences,
      selectedChatId,
      setEffortModalVisible,
      setEffortPickerModelId,
      setError,
      setModelModalVisible,
      setSelectedEffort,
      setSelectedModelId,
    ],
  );

  const selectPendingAgent = useCallback(
    (agentId: AgentId) => {
      if (selectedChatId) {
        return;
      }

      const rememberedSettings = agentSettings?.[agentId];
      setPendingAgentId(agentId);
      setSelectedModelId(null);
      setSelectedEffort(null);
      setSelectedServiceTier(undefined);
      setSelectedAcpModeId(null);
      setSelectedCollaborationMode(
        rememberedSettings?.collaborationMode === 'plan'
          ? rememberedSettings.collaborationMode
          : 'default',
      );
      setAgentModalVisible(false);
      setError(null);
    },
    [
      agentSettings,
      selectedChatId,
      setAgentModalVisible,
      setError,
      setPendingAgentId,
      setSelectedAcpModeId,
      setSelectedCollaborationMode,
      setSelectedEffort,
      setSelectedModelId,
      setSelectedServiceTier,
    ],
  );

  useEffect(() => {
    // Connection-driven refreshes are background/automatic, not an explicit
    // user action, so failures should stay silent and keep serving whatever
    // models are already cached instead of surfacing a global error.
    if (ws.isConnected) {
      void refreshModelOptions({ silent: true });
    }
    return ws.onStatus((connected) => {
      if (connected) {
        void refreshModelOptions({ silent: true });
      }
    });
  }, [refreshModelOptions, ws]);

  const openCollaborationModeMenu = useCallback(() => {
    setCollaborationModeMenuVisible(true);
  }, [setCollaborationModeMenuVisible]);

  const toggleFastMode = useCallback(() => {
    if (!supportsFastMode) {
      return;
    }
    const nextServiceTier: ServiceTier | null = activeServiceTier === 'fast' ? null : 'fast';
    const enablingFastMode = nextServiceTier === 'fast';
    const nextTitle = enablingFastMode ? 'Fast mode enabled' : 'Fast mode disabled';
    setSelectedServiceTier(nextServiceTier);
    setError(null);
    setActivity({
      tone: 'complete',
      title: nextTitle,
      detail: selectedChatId ? 'Applies to the next message' : 'Applies to the next new chat',
    });
  }, [
    activeServiceTier,
    selectedChatId,
    setActivity,
    setError,
    setSelectedServiceTier,
    supportsFastMode,
  ]);

  const attachmentControlsDisabled = attachmentPickerBusy || uploadingAttachment;

  const attachmentMenuOptions = useMemo<SelectionSheetOption[]>(
    () => [
      ...(hasFailedAttachmentUploads
        ? [
            {
              key: 'retry-uploads',
              title: 'Retry failed uploads',
              description: `Retry prepared files without selecting them again. ${ATTACHMENT_MAX_LABEL} each.`,
              icon: 'refresh-outline' as const,
              disabled: attachmentControlsDisabled,
              onPress: () => {
                attachmentController.closeMenu();
                retryFailedUploads();
              },
            },
          ]
        : []),
      {
        key: 'workspace-path',
        title: 'Attach from workspace path',
        description: 'Reference a file or folder from the current repo.',
        icon: 'folder-open-outline',
        disabled: attachmentControlsDisabled,
        onPress: () => {
          attachmentController.requestMenuAction('workspace-path');
        },
      },
      {
        key: 'phone-file',
        title: 'Pick file from phone',
        description: `Import a document or asset, up to ${ATTACHMENT_MAX_LABEL}.`,
        icon: 'document-outline',
        disabled: attachmentControlsDisabled,
        onPress: () => {
          attachmentController.requestMenuAction('phone-file');
        },
      },
      {
        key: 'phone-image',
        title: 'Pick image from phone',
        description: `Resize and compress an image, up to ${ATTACHMENT_MAX_LABEL}.`,
        icon: 'image-outline',
        disabled: attachmentControlsDisabled,
        onPress: () => {
          attachmentController.requestMenuAction('phone-image');
        },
      },
      {
        key: 'phone-camera',
        title: 'Take photo',
        description: `Capture, resize, and compress a photo, up to ${ATTACHMENT_MAX_LABEL}.`,
        icon: 'camera-outline',
        disabled: attachmentControlsDisabled,
        onPress: () => {
          attachmentController.requestMenuAction('phone-camera');
        },
      },
    ],
    [
      attachmentController,
      attachmentControlsDisabled,
      hasFailedAttachmentUploads,
      retryFailedUploads,
    ],
  );

  return {
    selectModel,
    selectPendingAgent,
    openCollaborationModeMenu,
    toggleFastMode,
    attachmentControlsDisabled,
    attachmentMenuOptions,
  };
}

export type MainScreenComposerControlActionsResult = ReturnType<
  typeof useMainScreenComposerControlActions
>;
