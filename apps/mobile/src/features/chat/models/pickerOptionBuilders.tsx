import { errorAtom } from '../state/turn';
import { selectedAcpModeIdAtom, selectedCollaborationModeAtom } from '../state/models';
import { useAtomValue, useSetAtom } from 'jotai';
import { useMemo } from 'react';
import type { CollaborationMode } from '@bridge/types/types';
import type { SelectionSheetOption } from '@shared/ui/SelectionSheet';
import { feedback } from '@shared/feedback';
import { formatModelOptionDescription, formatModelOptionLabel } from './options';
import { formatReasoningEffort } from '../helpers/helpers';
import type {
  MainScreenComposerControlActionsContext,
  MainScreenComposerControlActionsResult,
} from '../composer/controlActions';
import { collaborationModeMenuVisibleAtom } from '../state/modals';

export type MainScreenPickerOptionBuildersContext = MainScreenComposerControlActionsContext &
  MainScreenComposerControlActionsResult;

export function useMainScreenPickerOptionBuilders(context: MainScreenPickerOptionBuildersContext) {
  const {
    activeAgentId,
    activeEffort,
    applyAcpConfigOption,
    effectiveModelId,
    effortConfig,
    effortPickerDefault,
    effortPickerModel,
    effortPickerOptions,
    modeConfig,
    modelConfig,
    modelOptions,
    readyAgents,
    selectEffort,
    selectModel,
    selectPendingAgent,
    serverDefaultModel,
    selectedChatId,
    supportsPlanMode,
  } = context;
  const setError = useSetAtom(errorAtom);
  const selectedCollaborationMode = useAtomValue(selectedCollaborationModeAtom);
  const setSelectedCollaborationMode = useSetAtom(selectedCollaborationModeAtom);
  const setSelectedAcpModeId = useSetAtom(selectedAcpModeIdAtom);
  const setCollaborationModeMenuVisible = useSetAtom(collaborationModeMenuVisibleAtom);

  const collaborationModeOptions = useMemo<SelectionSheetOption[]>(() => {
    const setMode = (mode: CollaborationMode, acpMode: string) => {
      void feedback.selection();
      if (modeConfig) {
        if (!applyAcpConfigOption(modeConfig, acpMode)) {
          return;
        }
      }
      setSelectedAcpModeId(acpMode);
      setSelectedCollaborationMode(mode);
      setCollaborationModeMenuVisible(false);
      setError(null);
    };

    const advertisedModes = modeConfig?.options ?? [];
    if (advertisedModes.length > 0) {
      return advertisedModes.map((option) => {
        const mode: CollaborationMode = option.value === 'plan' ? 'plan' : 'default';
        return {
          key: option.value,
          title: option.name,
          description:
            option.description ??
            (mode === 'plan'
              ? 'Plan the work before execution.'
              : 'Use this primary OpenCode agent mode for the next turn.'),
          icon:
            mode === 'plan'
              ? ('git-branch-outline' as const)
              : ('chatbubble-ellipses-outline' as const),
          selected: modeConfig?.value === option.value,
          onPress: () => {
            void setMode(mode, option.value);
          },
        } satisfies SelectionSheetOption;
      });
    }
    return [
      {
        key: 'default',
        title: 'Default mode',
        description: 'Answer directly and keep the turn moving.',
        icon: 'chatbubble-ellipses-outline' as const,
        selected: selectedCollaborationMode === 'default',
        onPress: () => {
          void setMode('default', 'build');
        },
      },
      ...(supportsPlanMode
        ? [
            {
              key: 'plan',
              title: 'Plan mode',
              description: 'Pause to ask structured follow-up questions before execution.',
              icon: 'git-branch-outline' as const,
              selected: selectedCollaborationMode === 'plan',
              onPress: () => {
                void setMode('plan', 'plan');
              },
            },
          ]
        : []),
    ];
  }, [
    applyAcpConfigOption,
    modeConfig,
    selectedCollaborationMode,
    setCollaborationModeMenuVisible,
    setError,
    setSelectedAcpModeId,
    setSelectedCollaborationMode,
    supportsPlanMode,
  ]);

  const agentPickerOptions = useMemo<SelectionSheetOption[]>(
    () =>
      readyAgents.map((agent) => ({
        key: agent.agentId,
        title: agent.displayName,
        description: [agent.version, agent.provenance].filter(Boolean).join(' · '),
        icon: 'hardware-chip-outline' as const,
        selected: activeAgentId === agent.agentId,
        onPress: () => {
          void feedback.selection();
          selectPendingAgent(agent.agentId);
        },
      })),
    [activeAgentId, readyAgents, selectPendingAgent],
  );

  const modelPickerOptions = useMemo<SelectionSheetOption[]>(
    () => [
      ...(!selectedChatId || !modelConfig
        ? [
            {
              key: 'server-default',
              title: 'Use server default',
              description: serverDefaultModel
                ? `Currently ${formatModelOptionLabel(serverDefaultModel)}.`
                : 'Follow the bridge default model.',
              icon: 'sparkles-outline' as const,
              badge: 'Auto',
              selected: !effectiveModelId || effectiveModelId === serverDefaultModel?.id,
              onPress: () => {
                void feedback.selection();
                void selectModel(null);
              },
            },
          ]
        : []),
      ...modelOptions.map((model) => ({
        key: model.id,
        title: formatModelOptionLabel(model),
        description: formatModelOptionDescription(model),
        icon: 'hardware-chip-outline' as const,
        badge: model.isDefault ? 'Default' : undefined,
        meta: model.defaultReasoningEffort
          ? formatReasoningEffort(model.defaultReasoningEffort)
          : undefined,
        selected: model.id === effectiveModelId,
        onPress: () => {
          void feedback.selection();
          void selectModel(model.id);
        },
      })),
    ],
    [effectiveModelId, modelConfig, modelOptions, selectModel, selectedChatId, serverDefaultModel],
  );

  const effortPickerSheetOptions = useMemo<SelectionSheetOption[]>(
    () => [
      ...(!selectedChatId || !effortConfig
        ? [
            {
              key: 'model-default',
              title: effortPickerDefault
                ? `Use ${formatReasoningEffort(effortPickerDefault)}`
                : 'Use model default',
              description: effortPickerModel
                ? `Follow ${formatModelOptionLabel(effortPickerModel)}'s default reasoning.`
                : 'Follow the active model default.',
              icon: 'sparkles-outline' as const,
              badge: 'Auto',
              selected: activeEffort === null,
              onPress: () => {
                void feedback.selection();
                void selectEffort(null);
              },
            },
          ]
        : []),
      ...effortPickerOptions.map((option) => ({
        key: option.effort,
        title: formatReasoningEffort(option.effort),
        description:
          option.description?.trim() || 'Override the model default for the next response.',
        icon: 'pulse-outline' as const,
        selected: option.effort === activeEffort,
        onPress: () => {
          void feedback.selection();
          void selectEffort(option.effort);
        },
      })),
    ],
    [
      activeEffort,
      effortConfig,
      effortPickerDefault,
      effortPickerModel,
      effortPickerOptions,
      selectEffort,
      selectedChatId,
    ],
  );

  return {
    collaborationModeOptions,
    agentPickerOptions,
    modelPickerOptions,
    effortPickerSheetOptions,
  };
}

export type MainScreenPickerOptionBuildersResult = ReturnType<
  typeof useMainScreenPickerOptionBuilders
>;
