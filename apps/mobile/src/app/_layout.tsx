import { useMemo } from 'react';

import { RootLayout } from '../bootstrap/RootLayout';
import { AppStateProvider, createAppStore } from '../state/store';

export default function AppLayout() {
  const store = useMemo(() => createAppStore(), []);
  return (
    <AppStateProvider store={store}>
      <RootLayout />
    </AppStateProvider>
  );
}
