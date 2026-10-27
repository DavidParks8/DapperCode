import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Switch, View } from 'react-native';

import { LOCAL_MODEL_CATALOG, LOCAL_MODEL_FAMILIES } from '../models/catalog';
import { modelMemoryAdmission } from '../models/memory';
import type { LocalModelDefinition } from '../models/types';
import { useOnDeviceRuntime } from '../runtime/OnDeviceProvider';
import { ModelQuantizationCard } from './ModelQuantizationCard';
import { LocalAction, LocalPage, LocalText, modelSize, useLocalOperation } from './ui';

export function ModelFamilyScreen() {
  const runtime = useOnDeviceRuntime();
  const router = useRouter();
  const params = useLocalSearchParams<{
    familyId?: string;
    threadId?: string;
    downloadedOnly?: string;
    showUnsupported?: string;
  }>();
  const family = LOCAL_MODEL_FAMILIES.find((entry) => entry.id === params.familyId);
  const [downloadedOnly, setDownloadedOnly] = useState(params.downloadedOnly === 'true');
  const [showUnsupported, setShowUnsupported] = useState(params.showUnsupported === 'true');
  const [memory, setMemory] = useState(() => runtime.native.getMemoryInfo());
  const operation = useLocalOperation();
  const models = LOCAL_MODEL_CATALOG.filter(
    (model) =>
      model.family === family?.name &&
      (!downloadedOnly || runtime.downloads.snapshot(model.id).phase === 'ready') &&
      (showUnsupported || modelMemoryAdmission(model, memory).status !== 'unsupported'),
  );
  const sizes = [...new Set(models.map((model) => model.parameters))];
  const select = (model: LocalModelDefinition) =>
    operation.run(async () => {
      await runtime.selectModel(model.id, params.threadId);
      setMemory(runtime.native.getMemoryInfo());
      if (params.threadId) {
        router.dismissTo({
          pathname: '/on-device/chat/[threadId]',
          params: { threadId: params.threadId },
        });
      }
    });
  if (!family) {
    return (
      <LocalPage
        title="Model family"
        error="This model family is unavailable. Go back to the model library."
      />
    );
  }
  return (
    <LocalPage
      title={family.name}
      busy={operation.busy}
      error={operation.error ?? runtime.error()?.message}
    >
      <LocalText>
        {family.publisher} · {family.description}
      </LocalText>
      <LocalText>
        {family.quantizationNote ??
          'Choose a size and quantization. Smaller downloads save storage and RAM; larger quants retain more precision.'}{' '}
        All choices run text-only in this app.
      </LocalText>
      {sizes.map((size) => (
        <View key={size} style={{ gap: 12 }}>
          <LocalText title>{size}</LocalText>
          {models
            .filter((model) => model.parameters === size)
            .sort(
              (left, right) =>
                Number(Boolean(left.runtimeIssue)) - Number(Boolean(right.runtimeIssue)) ||
                Number(right.recommended) - Number(left.recommended) ||
                left.bytes - right.bytes,
            )
            .map((model) => (
              <ModelQuantizationCard
                key={model.id}
                model={model}
                memory={memory}
                operation={operation}
                select={select}
              />
            ))}
        </View>
      ))}
      {models.length === 0 ? <LocalText>No quants match these filters.</LocalText> : null}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <Switch
          accessibilityLabel="Downloaded quants only"
          value={downloadedOnly}
          onValueChange={setDownloadedOnly}
        />
        <LocalText>Downloaded only</LocalText>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <Switch
          accessibilityLabel="Show quants beyond this device's RAM budget"
          value={showUnsupported}
          onValueChange={setShowUnsupported}
        />
        <LocalText>Show larger quants</LocalText>
      </View>
      <LocalText>
        {memory.isSimulator ? 'Simulator host estimate' : 'iPhone RAM'}:{' '}
        {modelSize(memory.physicalBytes)} · Available headroom: {modelSize(memory.availableBytes)}.
        Memory admission is conservative, not a guarantee against iOS termination.
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
    </LocalPage>
  );
}
