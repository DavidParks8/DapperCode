import { useMemo } from 'react';

import { RootLayout } from '@shell/boot/RootLayout';
import { AppStateProvider, createAppStore } from '@shell/state/store';

export default function AppLayout() {
  const store = useMemo(() => createAppStore(), []);
  return (
    <AppStateProvider store={store}>
      <RootLayout />
    </AppStateProvider>
  );
}
