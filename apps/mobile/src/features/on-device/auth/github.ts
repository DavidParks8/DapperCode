import { authorizationClock, checkCancellation, type AuthorizationClock } from './polling';
import { isRecord } from '@shared/records';
import {
  GitAuthenticationError,
  type GitAccount,
  type GitCredentialVault,
  type GitDeviceAuthorization,
  type GitProviderAuthStrategy,
} from './strategy';

interface GitHubResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type GitHubRequest = (url: string, init: RequestInit) => Promise<GitHubResponse>;

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new GitAuthenticationError('invalid_response', 'GitHub returned an invalid response.');
  }
  return value;
}

function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new GitAuthenticationError('invalid_response', 'GitHub returned an invalid response.');
  }
  return value;
}

function positiveInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new GitAuthenticationError('invalid_response', 'GitHub returned an invalid response.');
  }
  return value;
}

function signInError(code: unknown): never {
  if (code === 'access_denied') {
    throw new GitAuthenticationError('denied', 'GitHub authorization was denied.');
  }
  if (code === 'expired_token' || code === 'token_expired') {
    throw new GitAuthenticationError('expired', 'The GitHub sign-in code expired. Start again.');
  }
  throw new GitAuthenticationError(
    'invalid_response',
    'GitHub could not complete authorization. Check the OAuth app configuration and retry.',
  );
}

export class GitHubAuthStrategy implements GitProviderAuthStrategy {
  readonly providerId = 'github';
  private pending: AbortController | null = null;
  private readonly request: GitHubRequest;
  private readonly clock: AuthorizationClock;

  constructor(
    private readonly options: {
      clientId: string;
      credentials: GitCredentialVault;
      request?: GitHubRequest;
      clock?: AuthorizationClock;
    },
  ) {
    this.request = options.request ?? fetch;
    this.clock = options.clock ?? authorizationClock;
  }

  async signIn(presentCode: (code: GitDeviceAuthorization) => Promise<void>): Promise<GitAccount> {
    if (!this.options.clientId.trim()) {
      throw new GitAuthenticationError('not_configured', 'GitHub sign-in is not configured.');
    }
    if (this.pending) {
      throw new GitAuthenticationError('busy', 'GitHub sign-in is already in progress.');
    }
    const controller = new AbortController();
    this.pending = controller;
    try {
      return await this.authorize(presentCode, controller.signal);
    } finally {
      this.pending = null;
    }
  }

  cancelSignIn(): void {
    this.pending?.abort();
  }

  resolveCredential(account: GitAccount, remoteUrl: string): string {
    let url: URL;
    try {
      url = new URL(remoteUrl);
    } catch {
      throw new GitAuthenticationError('invalid_remote', 'Enter a valid HTTPS repository URL.');
    }
    if (
      account.providerId !== this.providerId ||
      account.host !== 'github.com' ||
      url.protocol !== 'https:' ||
      url.hostname !== account.host ||
      (url.port !== '' && url.port !== '443') ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new GitAuthenticationError(
        'invalid_remote',
        'This GitHub account can only authenticate HTTPS repositories on github.com.',
      );
    }
    return account.credentialRef;
  }

  async signOut(account: GitAccount): Promise<void> {
    if (account.providerId !== this.providerId || account.host !== 'github.com') {
      throw new GitAuthenticationError('invalid_remote', 'This account is not a GitHub account.');
    }
    this.cancelSignIn();
    await this.options.credentials.remove(account.credentialRef);
  }

  private async authorize(
    presentCode: (code: GitDeviceAuthorization) => Promise<void>,
    signal: AbortSignal,
  ): Promise<GitAccount> {
    const response = await this.post(
      '/login/device/code',
      { client_id: this.options.clientId, scope: 'repo' },
      signal,
    );
    const deviceCode = text(response['device_code']);
    const userCode = text(response['user_code']);
    const verificationUrl = text(response['verification_uri']);
    if (verificationUrl !== 'https://github.com/login/device') {
      throw new GitAuthenticationError(
        'invalid_response',
        'GitHub returned an invalid sign-in URL.',
      );
    }
    const expiresAt = this.clock.now() + positiveInteger(response['expires_in']) * 1000;
    const interval = positiveInteger(response['interval']) * 1000;
    await presentCode({ userCode, verificationUrl, expiresAt });
    checkCancellation(signal);
    const token = await this.poll(deviceCode, expiresAt, interval, signal);
    return this.saveAccount(token, signal);
  }

  private async poll(
    deviceCode: string,
    expiresAt: number,
    initialInterval: number,
    signal: AbortSignal,
  ): Promise<string> {
    let interval = initialInterval;
    while (this.clock.now() < expiresAt) {
      await this.clock.wait(Math.min(interval, expiresAt - this.clock.now()), signal);
      checkCancellation(signal);
      if (this.clock.now() >= expiresAt) {
        break;
      }
      const response = await this.post(
        '/login/oauth/access_token',
        {
          client_id: this.options.clientId,
          device_code: deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        },
        signal,
      );
      if (response['error'] === 'authorization_pending') {
        continue;
      }
      if (response['error'] === 'slow_down') {
        interval = Math.max(
          interval + 5000,
          response['interval'] === undefined ? 0 : positiveInteger(response['interval']) * 1000,
        );
        continue;
      }
      if (response['error'] !== undefined) {
        signInError(response['error']);
      }
      if (
        !text(response['scope'])
          .split(/[,\s]+/u)
          .includes('repo')
      ) {
        throw new GitAuthenticationError(
          'missing_scope',
          'GitHub did not grant private repository access. Sign in again and authorize repository access.',
        );
      }
      const token = text(response['access_token']);
      if (token.length > 16_384 || !/^[A-Za-z0-9._~+\/-]+=*$/u.test(token)) {
        throw new GitAuthenticationError(
          'invalid_response',
          'GitHub returned an invalid credential.',
        );
      }
      return token;
    }
    throw new GitAuthenticationError('expired', 'The GitHub sign-in code expired. Start again.');
  }

  private async saveAccount(token: string, signal: AbortSignal): Promise<GitAccount> {
    const response = record(
      await this.json('https://api.github.com/user', {
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}` },
        signal,
      }),
    );
    checkCancellation(signal);
    const id = String(positiveInteger(response['id']));
    const login = text(response['login']);
    const credentialRef = await this.options.credentials.store({
      host: 'github.com',
      accountId: id,
      username: login,
      token,
    });
    if (signal.aborted) {
      await this.options.credentials.remove(credentialRef);
      checkCancellation(signal);
    }
    return { providerId: this.providerId, host: 'github.com', id, login, credentialRef };
  }

  private async post(
    pathname: string,
    body: Record<string, string>,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    return record(
      await this.json(`https://github.com${pathname}`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(body).toString(),
        signal,
      }),
    );
  }

  private async json(url: string, init: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    const signal = init.signal;
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) {
      controller.abort();
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 30_000);
    try {
      const response = await this.request(url, { ...init, signal: controller.signal });
      checkCancellation(controller.signal);
      if (!response.ok) {
        throw new GitAuthenticationError(
          'http',
          `GitHub request failed (HTTP ${response.status}).`,
        );
      }
      const value: unknown = await response.json();
      checkCancellation(controller.signal);
      return value;
    } catch (error) {
      if (signal?.aborted) {
        checkCancellation(signal);
      }
      if (timedOut) {
        throw new GitAuthenticationError(
          'timeout',
          'GitHub did not respond. Check your connection and retry.',
        );
      }
      if (error instanceof SyntaxError) {
        throw new GitAuthenticationError('invalid_response', 'GitHub did not return valid JSON.');
      }
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    }
  }
}
