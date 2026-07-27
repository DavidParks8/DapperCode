import { useMemo } from 'react';

import { AppRoot } from './src/app/AppRoot';
import { pinnedTlsProofNativeModule } from './src/proof/nativePinnedTlsProof';
import { PinnedTlsProofScreen } from './src/proof/PinnedTlsProofScreen';
import { AppStateProvider, createAppStore } from './src/state/store';

export default function App() {
  const store = useMemo(() => createAppStore(), []);
  if (pinnedTlsProofNativeModule?.isRequested) {
    return <PinnedTlsProofScreen />;
  }
  return (
    <AppStateProvider store={store}>
      <AppRoot />
    </AppStateProvider>
  );
}
