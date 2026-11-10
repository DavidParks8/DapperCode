import { GitHubAuthStrategy } from '../auth/github';
import type { GitDeviceAuthorization } from '../auth/strategy';
import type { LocalGitIdentity } from '../git/gitTools';
import type { OnDeviceNativeServices } from '../native/services.types';
import type { LocalPreferencesStore } from './preferences';

export interface GitAccountHost {
  requireNetwork(action: string): void;
  /** True while a workspace operation or Git transfer might be using the credential. */
  gitBusy(): boolean;
}

type GitAccountNative = Pick<
  OnDeviceNativeServices,
  'storeGitCredential' | 'removeGitCredential' | 'getWorkspaceGitOrigin'
>;

/** The GitHub sign-in, its Keychain credential, and the Git author used for local commits. */
export class LocalGitAccount {
  readonly authentication: GitHubAuthStrategy;
  private readonly clientId =
    process.env.EXPO_PUBLIC_GITHUB_CLIENT_ID?.trim() ?? 'Ov23ctzKpdigHwQUbG8X';

  constructor(
    private readonly native: GitAccountNative,
    private readonly settings: Pick<LocalPreferencesStore, 'get' | 'update' | 'save'>,
    private readonly host: GitAccountHost,
  ) {
    this.authentication = new GitHubAuthStrategy({
      clientId: this.clientId,
      credentials: {
        store: ({ host: server, accountId, username, token }) =>
          native.storeGitCredential(server, accountId, username, token),
        remove: (reference) => native.removeGitCredential(reference),
      },
    });
  }

  configured(): boolean {
    return Boolean(this.clientId);
  }

  async saveAuthor(author: LocalGitIdentity): Promise<void> {
    if (!author.name.trim() || !author.email.trim()) {
      throw new Error('Enter a Git author name and email.');
    }
    this.settings.update({ author: { name: author.name.trim(), email: author.email.trim() } });
    await this.settings.save();
  }

  async signIn(presentCode: (value: GitDeviceAuthorization) => Promise<void>): Promise<void> {
    this.host.requireNetwork('sign in to GitHub');
    const account = await this.authentication.signIn(presentCode);
    this.settings.update({
      account,
      author: this.settings.get().author ?? {
        name: account.login,
        email: `${account.id}+${account.login}@users.noreply.github.com`,
      },
    });
    await this.settings.save();
  }

  /** Removes the credential; rejects only while a Git transfer might be using it. */
  async signOut(): Promise<void> {
    if (this.host.gitBusy()) {
      throw new Error('Wait for the active Git transfer to finish before signing out.');
    }
    const account = this.settings.get().account;
    if (account) {
      await this.authentication.signOut(account);
    }
    this.settings.update({ account: null });
    await this.settings.save();
  }

  /** The signed-in account's credential for a workspace's origin, if any. */
  async credential(workspaceId: string): Promise<string | null> {
    const account = this.settings.get().account;
    if (!account) {
      return null;
    }
    return this.authentication.resolveCredential(
      account,
      await this.native.getWorkspaceGitOrigin(workspaceId),
    );
  }

  /** The signed-in account's credential for cloning `url`, when it is on the account's host. */
  cloneCredential(url: string): string | null {
    const account = this.settings.get().account;
    return account?.host === new URL(url).hostname
      ? this.authentication.resolveCredential(account, url)
      : null;
  }
}
