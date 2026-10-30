import { Linking } from 'react-native';
import type { ModelDownloadSnapshot } from '../models/downloads';
import { modelMemoryAdmission, modelMemoryBytes } from '../models/memory';
import type { DeviceMemory, LocalModelDefinition } from '../models/types';
import { useOnDeviceRuntime } from '../runtime/OnDeviceProvider';
import type { useLocalOperation } from './ui';
import { LocalAction, LocalCard, LocalText, modelSize } from './ui';

export function ModelQuantizationCard({
  model,
  memory,
  operation,
  select,
}: {
  model: LocalModelDefinition;
  memory: DeviceMemory;
  operation: ReturnType<typeof useLocalOperation>;
  select: (model: LocalModelDefinition) => void;
}) {
  const runtime = useOnDeviceRuntime();
  const download = runtime.downloads.snapshot(model.id);
  const admission = modelMemoryAdmission(model, memory);
  const loaded =
    runtime.models.snapshot().modelId === model.id && runtime.models.snapshot().phase === 'ready';
  return (
    <LocalCard>
      <LocalText title>
        {model.quantization}
        {model.recommended ? ' · Recommended' : ''}
      </LocalText>
      <LocalText>
        {modelSize(model.bytes)} download · {model.contextTokens} context
      </LocalText>
      <LocalText>Estimated load budget {modelSize(modelMemoryBytes(model))}.</LocalText>
      {model.runtimeIssue ? <LocalText>{model.runtimeIssue}</LocalText> : null}
      {admission.status !== 'ready' && !loaded ? <LocalText>{admission.message}</LocalText> : null}
      <LocalText>
        {downloadStatus(download)}
        {loaded ? ' · Loaded' : ''}
      </LocalText>
      {download.error ? <LocalText>{download.error}</LocalText> : null}
      {model.runtimeIssue ? (
        <LocalAction title="Unavailable in this build" disabled onPress={() => undefined} />
      ) : (
        <DownloadActions
          model={model}
          download={download}
          loaded={loaded}
          admission={admission.status}
          operation={operation}
          select={select}
        />
      )}
      <LocalAction
        title={`Source and ${model.license} license`}
        disabled={operation.busy}
        onPress={() => operation.run(() => Linking.openURL(model.sourceUrl))}
      />
    </LocalCard>
  );
}

function DownloadActions({
  model,
  download,
  loaded,
  admission,
  operation,
  select,
}: {
  model: LocalModelDefinition;
  download: ModelDownloadSnapshot;
  loaded: boolean;
  admission: ReturnType<typeof modelMemoryAdmission>['status'];
  operation: ReturnType<typeof useLocalOperation>;
  select: (model: LocalModelDefinition) => void;
}) {
  const runtime = useOnDeviceRuntime();
  if (download.phase === 'ready') {
    return (
      <>
        <LocalAction
          title={loaded ? 'Use loaded model' : 'Load and use'}
          disabled={operation.busy || (!loaded && admission !== 'ready')}
          onPress={() => select(model)}
        />
        <LocalAction
          title="Delete download"
          destructive
          disabled={operation.busy}
          onPress={() => operation.run(() => runtime.removeModel(model.id))}
        />
      </>
    );
  }
  if (['downloading', 'preparing', 'queued', 'verifying'].includes(download.phase)) {
    return (
      <>
        <LocalAction
          title={download.phase === 'verifying' ? 'Pause verification' : 'Pause download'}
          onPress={() => {
            void runtime.downloads.pause(model.id);
          }}
        />
        <LocalAction
          title="Cancel download"
          destructive
          onPress={() => {
            void runtime.downloads.cancel(model.id);
          }}
        />
      </>
    );
  }
  return (
    <>
      <LocalAction
        title={
          download.verificationPending
            ? 'Verify download'
            : download.canResume
              ? 'Resume download'
              : 'Download'
        }
        disabled={operation.busy || admission === 'unsupported' || download.phase === 'loading'}
        onPress={() =>
          operation.run(() =>
            download.verificationPending
              ? runtime.downloads.verify(model.id)
              : download.canResume
                ? runtime.downloads.resume(model.id)
                : runtime.downloads.download(model.id),
          )
        }
      />
      {['paused', 'error'].includes(download.phase) ? (
        <LocalAction
          title="Remove partial download"
          destructive
          disabled={operation.busy}
          onPress={() => operation.run(() => runtime.removeModel(model.id))}
        />
      ) : null}
    </>
  );
}

function downloadStatus(download: ModelDownloadSnapshot): string {
  const percent = (bytes: number) =>
    `${Math.floor((bytes / Math.max(download.totalBytes, 1)) * 100)}%`;
  const rate =
    download.bytesPerSecond === null
      ? ''
      : ` · ${(download.bytesPerSecond / 1024 ** 2).toFixed(1)} MiB/s`;
  const eta =
    download.etaSeconds === null
      ? ''
      : ` · ${Math.max(1, Math.ceil(download.etaSeconds / 60))} min left`;
  switch (download.phase) {
    case 'downloading':
      return `Downloading ${percent(download.bytesWritten)} · ${modelSize(download.bytesWritten)} of ${modelSize(download.totalBytes)}${rate}${eta}`;
    case 'verifying':
      return `Verifying pinned SHA-256 ${percent(download.verifiedBytes)}${eta}`;
    case 'queued':
      return 'Queued · starts when another download finishes';
    case 'paused':
      return download.verificationPending
        ? 'Downloaded · verification paused'
        : `Paused at ${percent(download.bytesWritten)}`;
    default:
      return download.phase.replaceAll('_', ' ');
  }
}
