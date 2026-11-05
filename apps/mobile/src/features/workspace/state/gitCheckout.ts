import { atom } from 'jotai';
import { screenAtom } from '../../chat/state/registry';

export const gitCheckoutRepoUrlAtom = screenAtom('');

export const gitCheckoutParentPathAtom = screenAtom<string | null>(null);

export const gitCheckoutDirectoryNameAtom = screenAtom('');

export const gitCheckoutDirectoryNameEditedAtom = screenAtom(false);

export const gitCheckoutErrorAtom = screenAtom<string | null>(null);

export const gitCheckoutCloningAtom = screenAtom(false);

// Transfers outlive MainScreen remounts; ownership must not be reset with presentation state.
export const gitCheckoutRequestOwnerAtom = atom<{ identityKey: string | undefined } | null>(null);

export const resumeGitCheckoutAfterWorkspacePickerAtom = screenAtom(false);
