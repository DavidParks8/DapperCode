import { createElement } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import { useDrawerForegroundSync } from '@shell/navigation/useDrawerForegroundSync';

interface ProbeProps {
  drawerStatus: 'open' | 'closed';
  navigation: { openDrawer: () => void } | null;
}

function Probe({ drawerStatus, navigation }: ProbeProps) {
  useDrawerForegroundSync(navigation, drawerStatus);
  return null;
}

describe('useDrawerForegroundSync', () => {
  const listeners = new Set<(state: AppStateStatus) => void>();
  const openDrawer = jest.fn();

  beforeEach(() => {
    listeners.clear();
    openDrawer.mockClear();
    Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' });
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, handler) => {
      listeners.add(handler);
      return {
        remove: () => {
          listeners.delete(handler);
        },
      };
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function emit(state: AppStateStatus): void {
    Object.defineProperty(AppState, 'currentState', { configurable: true, value: state });
    for (const listener of listeners) {
      listener(state);
    }
  }

  function renderProbe(props: ProbeProps): ReactTestRenderer {
    let tree: ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(createElement(Probe, props));
    });
    if (!tree) {
      throw new Error('Expected drawer foreground sync probe');
    }
    return tree;
  }

  it('does not re-open a list the navigator still reports as open', () => {
    const tree = renderProbe({ drawerStatus: 'open', navigation: { openDrawer } });

    act(() => {
      emit('inactive');
      emit('background');
      emit('active');
    });

    expect(openDrawer).not.toHaveBeenCalled();
    act(() => tree.unmount());
  });

  it('restores agreement when unlock reports the list closed while it is still visible', () => {
    const tree = renderProbe({ drawerStatus: 'open', navigation: { openDrawer } });

    act(() => {
      emit('inactive');
    });
    act(() => {
      tree.update(createElement(Probe, { drawerStatus: 'closed', navigation: { openDrawer } }));
    });
    act(() => {
      emit('background');
      emit('active');
    });

    expect(openDrawer).toHaveBeenCalledTimes(1);
    act(() => tree.unmount());
  });

  it('does not open a list that was already dismissed before lock', () => {
    const tree = renderProbe({ drawerStatus: 'closed', navigation: { openDrawer } });

    act(() => {
      emit('inactive');
      emit('background');
      emit('active');
    });

    expect(openDrawer).not.toHaveBeenCalled();
    act(() => tree.unmount());
  });

  it('skips permanent sidebars that have no overlay to resync', () => {
    const tree = renderProbe({ drawerStatus: 'open', navigation: null });

    act(() => {
      emit('inactive');
      emit('background');
      emit('active');
    });

    expect(openDrawer).not.toHaveBeenCalled();
    act(() => tree.unmount());
  });
});
