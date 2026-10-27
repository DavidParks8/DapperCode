import { getOnDeviceNativeServices } from '../native/services';
import type { GitCredentialVault } from './strategy';

export const gitCredentialVault: GitCredentialVault = {
  store: ({ host, accountId, username, token }) =>
    getOnDeviceNativeServices().storeGitCredential(host, accountId, username, token),
  remove: (reference) => getOnDeviceNativeServices().removeGitCredential(reference),
};
