import { requireNativeView } from 'expo';
import { useSetAtom } from 'jotai';
import { StyleSheet, type NativeSyntheticEvent, type ViewProps } from 'react-native';

import { parseWindowTraits } from '@shell/layout/windowLayout';
import { windowTraitsAtom } from '@shell/state/layout/atoms';

interface NativeWindowLayoutObserverProps extends ViewProps {
  onWindowLayoutChange: (event: NativeSyntheticEvent<unknown>) => void;
}

const NativeWindowLayoutObserver =
  requireNativeView<NativeWindowLayoutObserverProps>('WindowLayout');

export function WindowLayoutObserver() {
  const setWindowTraits = useSetAtom(windowTraitsAtom);
  return (
    <NativeWindowLayoutObserver
      pointerEvents="none"
      style={StyleSheet.absoluteFill}
      onWindowLayoutChange={(event) => setWindowTraits(parseWindowTraits(event.nativeEvent))}
    />
  );
}
