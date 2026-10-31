import { useState } from 'react';
import { AccessibilityInfo, Linking, View } from 'react-native';

import { modelMemoryAdmission } from '../../on-device/models/memory';
import type { DeviceMemory, LocalModelDefinition } from '../../on-device/models/types';
import { useOnDeviceSelector } from '../../on-device/runtime/OnDeviceProvider';
import type { OnDeviceRuntime } from '../../on-device/runtime/runtime';
import type { OnDeviceRuntimeSlice } from '../../on-device/runtime/types';
import { useLocalRuntime } from './hooks';
import {
  SettingsBadge,
  SettingsDetailRow,
  SettingsInlineActions,
  SettingsProgressBar,
  SettingsRowNote,
  type InlineAction,
} from './localSettingsUi';
import {
  describeAdmission,
  describeTransfer,
  describeUsage,
  formatBytes,
  formatContextRange,
  modelResidency,
} from './modelPresentation';

const DOWNLOAD_SLICES: readonly OnDeviceRuntimeSlice[] = ['downloads'];
const MODEL_SLICES: readonly OnDeviceRuntimeSlice[] = ['models'];
const PREFERENCE_SLICES: readonly OnDeviceRuntimeSlice[] = ['preferences'];

type ModelOperation = 'load' | 'unload' | 'delete' | 'download' | 'pause' | 'cancel' | 'select';

function errorText(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : 'That did not work. Try again in a moment.';
}

export function modelTitle(model: LocalModelDefinition): string {
  return `${model.name} ${model.quantization}`;
}

/**
 * One downloadable quant: size, context, download/verification progress, memory fit, whether it
 * is loaded or used for new chats, and its actions. Every action runs in place; errors stay on
 * this row. Progress re-renders only this row.
 */
function useModelRowState(model: LocalModelDefinition, memory: DeviceMemory) {
  const runtime = useLocalRuntime();
  const download = useOnDeviceSelector(
    (current) => current.downloads.snapshot(model.id),
    DOWNLOAD_SLICES,
  );
  const session = useOnDeviceSelector((current) => current.models.snapshot(), MODEL_SLICES);
  const selected = useOnDeviceSelector(
    (current) => current.preferences().modelId === model.id,
    PREFERENCE_SLICES,
  );
  const transfer = describeTransfer(download, model);
  const residency = modelResidency(session, model);
  const resident = runtime.models.resident();
  // Loading releases the resident model first, so its memory counts toward a switch.
  const admission = modelMemoryAdmission(
    model,
    memory,
    resident?.model.id === model.id ? null : resident,
  );
  const ready = transfer.kind === 'ready';
  const status = ready
    ? (describeUsage({ residency, session, selected }) ?? 'Downloaded')
    : transfer.label;
  const memoryNote =
    residency === 'none' ? describeAdmission(admission, { simulator: memory.isSimulator }) : null;
  return { runtime, download, selected, transfer, residency, admission, status, memoryNote };
}

function useModelOperation(runtime: OnDeviceRuntime, model: LocalModelDefinition) {
  const [operation, setOperation] = useState<ModelOperation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = (kind: ModelOperation, action: () => Promise<unknown>, done?: string) => {
    setOperation(kind);
    setError(null);
    void action()
      .then(() => {
        if (done) {
          AccessibilityInfo.announceForAccessibility(done);
        }
      })
      .catch((failure: unknown) => {
        const message = errorText(failure);
        // Transfer failures are already recorded on the download snapshot shown below.
        if (message !== runtime.downloads.snapshot(model.id).error) {
          setError(message);
        }
      })
      .finally(() => setOperation(null));
  };
  return { operation, error, setError, run };
}

/**
 * One downloadable quant: size, context, download/verification progress, memory fit, whether it
 * is loaded or used for new chats, and its actions. Every action runs in place; errors stay on
 * this row. Progress re-renders only this row.
 */
export function LocalModelRow({
  model,
  memory,
  fullName = false,
}: {
  model: LocalModelDefinition;
  memory: DeviceMemory;
  /** Show the family and size in the title, for rows outside their family page. */
  fullName?: boolean;
}) {
  const state = useModelRowState(model, memory);
  const { runtime } = state;
  const { operation, error, setError, run } = useModelOperation(runtime, model);
  const name = modelTitle(model);
  const unsupported = Boolean(model.runtimeIssue);

  const actions = unsupported
    ? []
    : modelActions({
        runtime,
        model,
        name,
        state,
        operation,
        run,
      });
  return (
    <SettingsDetailRow
      title={fullName ? name : model.quantization}
      badge={model.recommended ? 'Recommended' : null}
      subtitle={`${formatBytes(model.bytes)} · ${formatContextRange(model)}`}
      status={unsupported ? null : state.status}
      statusTone={statusTone(state)}
      testID={`local-model-${model.id}`}
    >
      <ModelRowNotes model={model} name={name} state={state} error={error} />
      <SettingsInlineActions
        actions={[
          ...actions,
          {
            key: 'source',
            label: `${model.license} license`,
            accessibilityLabel: `Source and ${model.license} license for ${name}`,
            icon: 'open-outline',
            onPress: () => {
              void Linking.openURL(model.sourceUrl).catch(() =>
                setError('The model page could not be opened.'),
              );
            },
          },
        ]}
      />
    </SettingsDetailRow>
  );
}

function statusTone(state: RowState): 'error' | 'accent' | 'default' {
  if (state.transfer.kind === 'error') {
    return 'error';
  }
  return state.residency === 'loaded' ? 'accent' : 'default';
}

function ModelRowNotes({
  model,
  name,
  state,
  error,
}: {
  model: LocalModelDefinition;
  name: string;
  state: RowState;
  error: string | null;
}) {
  const { transfer, download } = state;
  const showProgress = transfer.progress !== null && transfer.kind !== 'ready';
  const transferError = transfer.kind === 'ready' ? null : download.error;
  return (
    <>
      {showProgress ? (
        <SettingsProgressBar
          label={`${name} ${transfer.kind === 'verifying' ? 'verification' : 'download'} progress`}
          value={transfer.progress ?? 0}
          valueText={transfer.progressText}
          testID={`local-model-progress-${model.id}`}
        />
      ) : null}
      {model.runtimeIssue ? <UnsupportedNote reason={model.runtimeIssue} /> : null}
      {state.memoryNote && !model.runtimeIssue ? (
        <SettingsRowNote>{state.memoryNote}</SettingsRowNote>
      ) : null}
      {transferError ? <SettingsRowNote tone="error">{transferError}</SettingsRowNote> : null}
      {error ? <SettingsRowNote tone="error">{error}</SettingsRowNote> : null}
    </>
  );
}

/** Unsupported packings are labelled with their reason instead of offering a disabled button. */
function UnsupportedNote({ reason }: { reason: string }) {
  return (
    <View style={{ gap: 4, alignItems: 'flex-start' }}>
      <SettingsBadge label="Not supported in this build" tone="muted" />
      <SettingsRowNote>{reason}</SettingsRowNote>
    </View>
  );
}

type RowState = ReturnType<typeof useModelRowState>;
type RunOperation = (kind: ModelOperation, action: () => Promise<unknown>, done?: string) => void;

interface ActionContext {
  runtime: OnDeviceRuntime;
  model: LocalModelDefinition;
  name: string;
  state: RowState;
  operation: ModelOperation | null;
  run: RunOperation;
}

function actionFactory({ model, name, operation, run }: ActionContext) {
  return (
    key: ModelOperation,
    label: string,
    perform: () => Promise<unknown>,
    options: Omit<Partial<InlineAction>, 'key' | 'label' | 'onPress'> & { done?: string } = {},
  ): InlineAction => {
    const { done, ...extra } = options;
    return {
      key,
      label,
      accessibilityLabel: `${label} ${name}`,
      busy: operation === key,
      disabled: operation !== null && operation !== key,
      onPress: () => run(key, perform, done),
      testID: `local-model-${key}-${model.id}`,
      ...extra,
    };
  };
}

function modelActions(context: ActionContext): InlineAction[] {
  const { runtime, model, name, state, operation } = context;
  const id = model.id;
  const action = actionFactory(context);
  const cancel = action('cancel', 'Cancel', () => runtime.downloads.cancel(id), {
    icon: 'close',
    tone: 'destructive',
    done: `${name} download cancelled.`,
  });
  switch (state.transfer.kind) {
    case 'checking':
      return [];
    case 'queued':
    case 'downloading':
    case 'verifying':
      return [
        action('pause', 'Pause', () => runtime.downloads.pause(id), { icon: 'pause' }),
        cancel,
      ];
    case 'paused':
    case 'error':
      return [{ ...continueAction(context), tone: 'prominent' }, cancel];
    case 'ready':
      return readyActions(context);
    default:
      return [
        action('download', 'Download', () => runtime.downloadModel(id), {
          icon: 'arrow-down-circle-outline',
          tone: 'prominent',
          disabled:
            (operation !== null && operation !== 'download') ||
            state.admission.status === 'unsupported',
        }),
      ];
  }
}

function continueAction(context: ActionContext): InlineAction {
  const { runtime, model, state } = context;
  const action = actionFactory(context);
  if (state.download.verificationPending) {
    return action('download', 'Verify', () => runtime.downloads.verify(model.id), {
      icon: 'shield-checkmark-outline',
    });
  }
  return state.download.canResume
    ? action('download', 'Resume', () => runtime.resumeModelDownload(model.id), { icon: 'play' })
    : action('download', 'Try again', () => runtime.downloadModel(model.id), { icon: 'refresh' });
}

function readyActions(context: ActionContext): InlineAction[] {
  const { runtime, model, name, state, operation } = context;
  const action = actionFactory(context);
  const remove = action('delete', 'Delete', () => runtime.removeModel(model.id), {
    icon: 'trash-outline',
    tone: 'destructive',
    done: `${name} deleted.`,
  });
  if (state.residency === 'loading' || state.residency === 'unloading') {
    return [remove];
  }
  if (state.residency === 'loaded') {
    const select = action('select', 'Use for new chats', () => runtime.selectModel(model.id), {
      done: `New chats use ${name}.`,
    });
    const unload = action('unload', 'Unload', () => runtime.unloadModel(), {
      icon: 'arrow-undo-outline',
      done: `${name} unloaded.`,
    });
    return state.selected ? [unload, remove] : [select, unload, remove];
  }
  return [
    action('load', 'Load', () => runtime.selectModel(model.id), {
      icon: 'flash-outline',
      tone: 'prominent',
      disabled: (operation !== null && operation !== 'load') || state.admission.status !== 'ready',
    }),
    remove,
  ];
}
