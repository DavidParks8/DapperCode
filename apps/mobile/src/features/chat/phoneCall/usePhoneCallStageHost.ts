import { useAtom } from 'jotai';
import { useCallback, useContext, useEffect } from 'react';
import { useWindowDimensions } from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';

import type { BridgeUiSurface } from '@bridge/types/types';
import { useSceneHorizontalInsets, useShellLayout } from '@shell/layout/useShellLayout';
import { openPhoneCallSurfaceIdAtom, phoneCallWhisperDraftByIdAtom } from '../state/composer';
import { resolvePhoneCallStageLayout } from './stageLayout';

export function usePhoneCallStageHost(options: {
  callBridgeUiSurfaces: BridgeUiSurface[];
  supersededCallBridgeUiSurfaces: BridgeUiSurface[];
  dismissBridgeUiSurface?: (surface: BridgeUiSurface) => void | Promise<void>;
}) {
  const { callBridgeUiSurfaces, supersededCallBridgeUiSurfaces, dismissBridgeUiSurface } = options;
  const [openPhoneCallSurfaceId, setOpenPhoneCallSurfaceId] = useAtom(openPhoneCallSurfaceIdAtom);
  const [whisperDraftById, setWhisperDraftById] = useAtom(phoneCallWhisperDraftByIdAtom);
  const sceneInsets = useSceneHorizontalInsets();
  const shellLayout = useShellLayout();
  const safeAreaInsets = useContext(SafeAreaInsetsContext);
  const { width: windowWidth } = useWindowDimensions();

  const openSurface = openPhoneCallSurfaceId
    ? (callBridgeUiSurfaces.find((surface) => surface.id === openPhoneCallSurfaceId) ?? null)
    : null;
  const stageLayout = resolvePhoneCallStageLayout({
    windowWidth,
    layout: shellLayout,
    sceneInsets,
  });

  useEffect(() => {
    if (openPhoneCallSurfaceId && !openSurface) {
      setOpenPhoneCallSurfaceId(null);
    }
  }, [openPhoneCallSurfaceId, openSurface, setOpenPhoneCallSurfaceId]);

  useEffect(() => {
    const activeIds = new Set(callBridgeUiSurfaces.map((surface) => surface.id));
    setWhisperDraftById((previous) => {
      const keys = Object.keys(previous);
      if (keys.every((id) => activeIds.has(id))) {
        return previous;
      }
      const next: Record<string, string> = {};
      for (const id of keys) {
        if (activeIds.has(id) && previous[id] !== undefined) {
          next[id] = previous[id];
        }
      }
      return next;
    });
  }, [callBridgeUiSurfaces, setWhisperDraftById]);

  const closeStage = useCallback(() => {
    setOpenPhoneCallSurfaceId(null);
  }, [setOpenPhoneCallSurfaceId]);

  const changeWhisperDraft = useCallback(
    (nextDraft: string) => {
      if (!openSurface) {
        return;
      }
      const surfaceId = openSurface.id;
      setWhisperDraftById((previous) =>
        previous[surfaceId] === nextDraft ? previous : { ...previous, [surfaceId]: nextDraft },
      );
    },
    [openSurface, setWhisperDraftById],
  );

  const dismissStage = useCallback(
    (surface: BridgeUiSurface) => {
      setOpenPhoneCallSurfaceId(null);
      if (!dismissBridgeUiSurface) {
        return;
      }
      for (const retired of [surface, ...supersededCallBridgeUiSurfaces]) {
        void dismissBridgeUiSurface(retired);
      }
    },
    [dismissBridgeUiSurface, setOpenPhoneCallSurfaceId, supersededCallBridgeUiSurfaces],
  );

  return {
    openSurface,
    stageLayout,
    showSplitPane: openSurface !== null && stageLayout.mode === 'split-pane',
    whisperDraft: openSurface ? (whisperDraftById[openSurface.id] ?? '') : '',
    safeAreaBottom: safeAreaInsets?.bottom ?? 0,
    closeStage,
    changeWhisperDraft,
    dismissStage,
  };
}
