import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Linking, Switch, View } from 'react-native';

import { LOCAL_MODEL_CATALOG } from '../models/catalog';
import type { ModelDownloadSnapshot } from '../models/downloads';
import { modelMemoryAdmission, modelMemoryBytes } from '../models/memory';
import type { DeviceMemory, LocalModelDefinition } from '../models/types';
import { useOnDeviceRuntime } from '../runtime/OnDeviceProvider';
import {
  LocalAction,
  LocalCard,
  LocalField,
  LocalPage,
  LocalText,
  modelSize,
  useLocalOperation,
} from './ui';

export function ModelLibraryScreen() {
  const runtime = useOnDeviceRuntime();
  const router = useRouter();
  const { threadId } = useLocalSearchParams<{ threadId?: string }>();
  const [search, setSearch] = useState('');
  const [showUnsupported, setShowUnsupported] = useState(false);
  const [downloadedOnly, setDownloadedOnly] = useState(false);
  const [memory, setMemory] = useState(() => runtime.native.getMemoryInfo());
  const operation = useLocalOperation();
  const models = LOCAL_MODEL_CATALOG.filter(
    (model) =>
      model.name.toLowerCase().includes(search.toLowerCase()) &&
      (!downloadedOnly || runtime.downloads.snapshot(model.id).phase === 'ready') &&
      (showUnsupported || modelMemoryAdmission(model, memory).status !== 'unsupported'),
  ).sort(
    (left, right) =>
      Number(runtime.downloads.snapshot(right.id).phase === 'ready') -
        Number(runtime.downloads.snapshot(left.id).phase === 'ready') ||
      Number(right.recommended) - Number(left.recommended) ||
      left.bytes - right.bytes,
  );
  const select = (model: LocalModelDefinition) =>
    operation.run(async () => {
      await runtime.selectModel(model.id, threadId);
      setMemory(runtime.native.getMemoryInfo());
      if (threadId) {
        router.back();
      }
    });
  return (
    <LocalPage
      title="Model library"
      busy={operation.busy}
      error={operation.error ?? runtime.error()?.message}
    >
      <LocalText>
        {memory.isSimulator ? 'Simulator host estimate' : 'iPhone RAM'}:{' '}
        {modelSize(memory.physicalBytes)} · Available app headroom:{' '}
        {modelSize(memory.availableBytes)}
      </LocalText>
      <LocalText>
        Compatibility is a conservative estimate, not a guarantee against iOS memory pressure.
        Models run locally; downloads require internet.
      </LocalText>
      <LocalAction
        title="Refresh memory"
        onPress={() => setMemory(runtime.native.getMemoryInfo())}
      />
      <LocalAction
        title="Unload active model"
        disabled={operation.busy || runtime.models.snapshot().phase === 'empty'}
        onPress={() =>
          operation.run(async () => {
            await runtime.stop();
            await runtime.models.unload();
            setMemory(runtime.native.getMemoryInfo());
          })
        }
      />
      <LocalField label="Search models" value={search} onChangeText={setSearch} />
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <Switch
          accessibilityLabel="Downloaded models only"
          value={downloadedOnly}
          onValueChange={setDownloadedOnly}
        />
        <LocalText>Downloaded only</LocalText>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <Switch
          accessibilityLabel="Show models beyond this device's RAM budget"
          value={showUnsupported}
          onValueChange={setShowUnsupported}
        />
        <LocalText>Show unsupported models</LocalText>
      </View>
      {models.map((model) => (
        <ModelCard
          key={model.id}
          model={model}
          memory={memory}
          operation={operation}
          select={select}
        />
      ))}
    </LocalPage>
  );
}

interface ModelCardProps {
  model: LocalModelDefinition;
  memory: DeviceMemory;
  operation: ReturnType<typeof useLocalOperation>;
  select: (model: LocalModelDefinition) => void;
}

function ModelCard({ model, memory, operation, select }: ModelCardProps) {
  const runtime = useOnDeviceRuntime();
  const download = runtime.downloads.snapshot(model.id);
  const admission = modelMemoryAdmission(model, memory);
  const loaded =
    runtime.models.snapshot().modelId === model.id && runtime.models.snapshot().phase === 'ready';
  return (
    <LocalCard>
      <LocalText title>
        {model.name}
        {model.recommended ? ' · Recommended' : ''}
      </LocalText>
      <LocalText>
        {model.parameters} · {model.quantization} · {modelSize(model.bytes)} · {model.contextTokens}{' '}
        context
      </LocalText>
      <LocalText>Estimated load budget {modelSize(modelMemoryBytes(model))}.</LocalText>
      {admission.status !== 'ready' && !loaded ? <LocalText>{admission.message}</LocalText> : null}
      <LocalText>
        {download.phase.replaceAll('_', ' ')}
        {download.phase === 'downloading'
          ? ` · ${Math.floor((download.bytesWritten / model.bytes) * 100)}%`
          : ''}
        {loaded ? ' · Loaded' : ''}
      </LocalText>
      {download.error ? <LocalText>{download.error}</LocalText> : null}
      <DownloadActions
        model={model}
        download={download}
        loaded={loaded}
        admission={admission.status}
        operation={operation}
        select={select}
      />
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
  if (['downloading', 'preparing'].includes(download.phase)) {
    return (
      <>
        <LocalAction
          title="Pause download"
          onPress={() => {
            void runtime.downloads.pause().catch((error: unknown) => runtime.report(error));
          }}
        />
        <LocalAction
          title="Cancel download"
          destructive
          onPress={() => {
            void runtime.downloads.cancel().catch((error: unknown) => runtime.report(error));
          }}
        />
      </>
    );
  }
  if (download.phase === 'verifying') {
    return <LocalText>Verifying pinned SHA-256 before use…</LocalText>;
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
