export interface GitAccount {
  providerId: string;
  host: string;
  id: string;
  login: string;
  credentialRef: string;
}

export interface GitDeviceAuthorization {
  userCode: string;
  verificationUrl: string;
  expiresAt: number;
}

export interface GitCredentialVault {
  store(input: {
    host: string;
    accountId: string;
    username: string;
    token: string;
  }): Promise<string>;
  remove(reference: string): Promise<void>;
}

export interface GitProviderAuthStrategy {
  readonly providerId: string;
  signIn(presentCode: (code: GitDeviceAuthorization) => Promise<void>): Promise<GitAccount>;
  cancelSignIn(): void;
  resolveCredential(account: GitAccount, remoteUrl: string): string;
  signOut(account: GitAccount): Promise<void>;
}

export class GitAuthenticationError extends Error {
  constructor(
    readonly code:
      | 'not_configured'
      | 'busy'
      | 'cancelled'
      | 'expired'
      | 'denied'
      | 'invalid_response'
      | 'http'
      | 'timeout'
      | 'missing_scope'
      | 'invalid_remote',
    message: string,
  ) {
    super(message);
    this.name = 'GitAuthenticationError';
  }
}
