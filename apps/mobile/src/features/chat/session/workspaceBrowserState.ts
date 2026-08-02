import { useSetAtom } from 'jotai';
import { useCallback } from 'react';

import {
  browseWorkspacePathAtom,
  closeGitCheckoutAtom,
  openGitCheckoutAtom,
  openGitCheckoutDestinationPickerAtom,
  openWorkspaceModalAtom,
  openWorkspacePickerAtom,
} from '../../workspace/state/workspaceActions';
import type { WorkspacePickerPurpose } from '../helpers/helpers';
import type {
  MainScreenCapabilityFlagsContext,
  MainScreenCapabilityFlagsResult,
} from '../turn/capabilityFlags';

export type MainScreenWorkspaceBrowserStateContext = MainScreenCapabilityFlagsContext &
  MainScreenCapabilityFlagsResult;

/**
 * Binds the workspace browsing actions for MainScreen. The behaviour lives in store actions so the
 * workspace picker and git checkout screens, which render while MainScreen is unmounted, share it.
 */
export function useMainScreenWorkspaceBrowserState() {
  const browse = useSetAtom(browseWorkspacePathAtom);
  const openPicker = useSetAtom(openWorkspacePickerAtom);
  const openWorkspace = useSetAtom(openWorkspaceModalAtom);
  const openCheckout = useSetAtom(openGitCheckoutAtom);
  const closeCheckout = useSetAtom(closeGitCheckoutAtom);
  const openCheckoutDestination = useSetAtom(openGitCheckoutDestinationPickerAtom);

  const browseWorkspacePath = useCallback(
    async (path: string | null | undefined) => {
      await browse(path);
    },
    [browse],
  );

  const openWorkspacePicker = useCallback(
    (purpose: WorkspacePickerPurpose, initialPathOverride?: string | null) => {
      openPicker(purpose, initialPathOverride);
    },
    [openPicker],
  );

  const openWorkspaceModal = useCallback(() => {
    openWorkspace();
  }, [openWorkspace]);

  const openGitCheckoutModal = useCallback(
    (initialParentPath?: string | null) => {
      openCheckout(initialParentPath);
    },
    [openCheckout],
  );

  const closeGitCheckoutModal = useCallback(() => {
    closeCheckout();
  }, [closeCheckout]);

  const openGitCheckoutDestinationPicker = useCallback(() => {
    openCheckoutDestination();
  }, [openCheckoutDestination]);

  return {
    browseWorkspacePath,
    openWorkspacePicker,
    openWorkspaceModal,
    openGitCheckoutModal,
    closeGitCheckoutModal,
    openGitCheckoutDestinationPicker,
  };
}

export type MainScreenWorkspaceBrowserStateResult = ReturnType<
  typeof useMainScreenWorkspaceBrowserState
>;
