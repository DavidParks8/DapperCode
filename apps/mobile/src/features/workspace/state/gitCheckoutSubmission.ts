import type { Getter, Setter } from 'jotai';
import { router } from 'expo-router';
import {
  activeProfileFeaturesAtom,
  activeProfileIdAtom,
  apiClientAtom,
} from '@shell/state/bridge/atoms';
import { defaultStartCwdAtom } from '@shell/state/appState/settings';
import { routes } from '@shell/navigation/routes';
import {
  formatGitCloneFailureMessage,
  joinWorkspacePath,
  normalizeCloneDirectoryName,
  normalizeWorkspacePath,
} from '../../chat/helpers/helpers';
import { describeHostError } from '../api/errors';
import { httpsRemoteError } from '../api/remoteUrl';
import {
  gitCheckoutCloningAtom,
  gitCheckoutDirectoryNameAtom,
  gitCheckoutErrorAtom,
  gitCheckoutParentPathAtom,
  gitCheckoutRepoUrlAtom,
  gitCheckoutRequestOwnerAtom,
} from './gitCheckout';
import {
  activeWorkspaceIdentityAtom,
  workspaceBridgeRootAtom,
  workspaceBrowseErrorAtom,
  workspaceBrowseParentPathAtom,
  workspaceBrowsePathAtom,
} from './workspace';
import { getWorkspaceRouteIds } from './workspaceRouteNavigation';

export async function submitGitCheckoutRequest(
  get: Getter,
  set: Setter,
  lookupRoots: () => Promise<{ bridgeRoot: string | null } | null>,
): Promise<void> {
  const startedForProfile = get(activeProfileIdAtom);
  const startedIdentityKey = get(activeWorkspaceIdentityAtom)?.identityKey;
  const pendingOwner = get(gitCheckoutRequestOwnerAtom);
  if (pendingOwner && pendingOwner.identityKey === startedIdentityKey) {
    set(gitCheckoutCloningAtom, true);
    return;
  }
  if (!pendingOwner && get(gitCheckoutCloningAtom)) {
    return;
  }
  const api = get(apiClientAtom);
  const url = get(gitCheckoutRepoUrlAtom).trim();
  const directoryName = normalizeCloneDirectoryName(get(gitCheckoutDirectoryNameAtom));
  if (!url) {
    set(gitCheckoutErrorAtom, 'Paste an HTTPS or SSH repository URL first.');
    return;
  }
  const urlError = get(activeProfileFeaturesAtom).managedWorkspaces ? httpsRemoteError(url) : null;
  if (urlError) {
    set(gitCheckoutErrorAtom, urlError);
    return;
  }
  if (!directoryName) {
    set(gitCheckoutErrorAtom, 'Choose a valid folder name for the cloned repo.');
    return;
  }
  const owner = { identityKey: startedIdentityKey };
  const ownsRequest = () => get(gitCheckoutRequestOwnerAtom) === owner;
  const appliesToProfile = () =>
    ownsRequest() &&
    get(activeProfileIdAtom) === startedForProfile &&
    get(activeWorkspaceIdentityAtom)?.identityKey === startedIdentityKey;
  set(gitCheckoutRequestOwnerAtom, owner);
  set(gitCheckoutCloningAtom, true);
  set(gitCheckoutErrorAtom, null);

  const cloneWorkspace = async () => {
    let parentPath =
      normalizeWorkspacePath(get(gitCheckoutParentPathAtom)) ?? get(workspaceBridgeRootAtom);
    if (!parentPath) {
      const response = await lookupRoots();
      if (!appliesToProfile()) {
        return;
      }
      parentPath = normalizeWorkspacePath(response?.bridgeRoot);
    }
    if (!appliesToProfile()) {
      return;
    }
    if (!parentPath || !api) {
      set(gitCheckoutErrorAtom, 'Choose where the repository should be cloned.');
      return;
    }
    const cloned = await api.gitClone({ url, parentPath, directoryName });
    if (!appliesToProfile()) {
      return;
    }
    const cloneFailureMessage = formatGitCloneFailureMessage(cloned, directoryName);
    if (cloneFailureMessage) {
      set(gitCheckoutErrorAtom, cloneFailureMessage);
      return;
    }
    const clonedPath =
      normalizeWorkspacePath(cloned.cwd) ?? joinWorkspacePath(parentPath, directoryName);
    set(defaultStartCwdAtom, clonedPath);
    set(workspaceBrowsePathAtom, clonedPath);
    set(workspaceBrowseParentPathAtom, parentPath);
    set(workspaceBrowseErrorAtom, null);
    const { profileId, chatId } = getWorkspaceRouteIds(get);
    if (profileId) {
      set(gitCheckoutCloningAtom, false);
      router.dismissTo(routes.chat(profileId, chatId));
    }
  };
  try {
    await cloneWorkspace();
  } catch (error) {
    if (appliesToProfile()) {
      set(gitCheckoutErrorAtom, describeHostError(error, 'The repository could not be cloned.'));
    }
  } finally {
    if (ownsRequest()) {
      set(gitCheckoutRequestOwnerAtom, null);
      set(gitCheckoutCloningAtom, false);
    }
  }
}
