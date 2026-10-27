import { registerRootComponent } from 'expo';
import { File, Paths } from 'expo-file-system';
import { ExpoRoot } from 'expo-router';
import { useEffect, useState } from 'react';
import { Text } from 'react-native';

import { getOnDeviceNativeServices } from '../../../src/features/on-device/native/services';
import { localModelDefinition } from '../../../src/features/on-device/models/catalog';
import { emptyLocalPreferences } from '../../../src/features/on-device/runtime/preferences';

const context = require.context('../../../src/app', true, /\.[jt]sx?$/);
const prepared = new File(Paths.document, 'product-prepared.json');
const continueBoot = new File(Paths.document, 'continue-boot');
const result = new File(Paths.document, 'product-network.json');
let networkRequests = 0;
globalThis.fetch = () => {
  networkRequests += 1;
  result.write(JSON.stringify({ networkRequests }));
  return Promise.reject(new Error('Network is disabled for the offline product fixture.'));
};

async function prepare() {
  if (!prepared.exists) {
    const native = getOnDeviceNativeServices();
    const model = localModelDefinition('qwen3-1.7b-q4-k-m');
    const paths = await native.getModelFilePaths(model.id);
    await new File(Paths.document, 'model.gguf').copy(new File(paths.partialUri));
    await native.finalizeModelDownload(model.id, model.sha256, model.bytes);
    const workspace = await native.createWorkspace('Offline UI fixture');
    await native.writeRuntimeDocument(
      'preferences.json',
      JSON.stringify({
        ...emptyLocalPreferences(),
        modelId: model.id,
        workspaceId: workspace.id,
        author: { name: 'Offline UI Fixture', email: 'fixture@example.invalid' },
      }),
    );
    prepared.write(JSON.stringify({ workspaceId: workspace.id }));
  }
  result.write(JSON.stringify({ networkRequests }));
}

function ProductFixture() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setInterval> | undefined;
    void prepare()
      .then(() => {
        timer = setInterval(() => {
          if (alive && continueBoot.exists) {
            clearInterval(timer);
            setReady(true);
          }
        }, 100);
      })
      .catch((failure: unknown) => {
        if (alive) {
          setError(failure instanceof Error ? failure.message : 'Fixture preparation failed.');
        }
      });
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  if (error) {
    return <Text>{error}</Text>;
  }
  return ready ? (
    <ExpoRoot context={context} />
  ) : (
    <Text>Preparing isolated offline product fixture…</Text>
  );
}

registerRootComponent(ProductFixture);
