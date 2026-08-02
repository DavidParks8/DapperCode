import { screenAtom } from '../../chat/state/registry';

export const gitCheckoutRepoUrlAtom = screenAtom('');

export const gitCheckoutParentPathAtom = screenAtom<string | null>(null);

export const gitCheckoutDirectoryNameAtom = screenAtom('');

export const gitCheckoutDirectoryNameEditedAtom = screenAtom(false);

export const gitCheckoutErrorAtom = screenAtom<string | null>(null);

export const gitCheckoutCloningAtom = screenAtom(false);

export const resumeGitCheckoutAfterWorkspacePickerAtom = screenAtom(false);
