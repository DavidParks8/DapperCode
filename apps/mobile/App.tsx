import { useMemo } from 'react';

import { AppRoot } from './src/app/AppRoot';
import { AppStateProvider, createAppStore } from './src/state/store';

export default function App() {
  const store = useMemo(() => createAppStore(), []);
  return (
    <AppStateProvider store={store}>
      <AppRoot />
    </AppStateProvider>
  );
}
