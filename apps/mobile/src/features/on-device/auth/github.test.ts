import { GitHubAuthStrategy, type GitHubRequest } from './github';
import { authorizationClock, type AuthorizationClock } from './polling';
import type { GitAccount, GitCredentialVault } from './strategy';

const device = {
  device_code: 'test-device-code',
  user_code: 'ABCD-EFGH',
  verification_uri: 'https://github.com/login/device',
  expires_in: 900,
  interval: 5,
};
const token = { access_token: 'test-token-not-a-secret', scope: 'repo', token_type: 'bearer' };
const identity = { id: 42, login: 'example-user' };
const account: GitAccount = {
  providerId: 'github',
  host: 'github.com',
  id: '42',
  login: 'example-user',
  credentialRef: 'test-credential-reference',
};

function harness(responses: unknown[]) {
  let now = 1000;
  const waits: number[] = [];
  const clock: AuthorizationClock = {
    now: () => now,
    wait: async (milliseconds) => {
      waits.push(milliseconds);
      now += milliseconds;
    },
  };
  const request = jest.fn<ReturnType<GitHubRequest>, Parameters<GitHubRequest>>(async () => {
    if (!responses.length) {
      throw new Error('Unexpected GitHub request.');
    }
    return { ok: true, status: 200, json: async () => responses.shift() };
  });
  const store = jest.fn(async () => account.credentialRef);
  const remove = jest.fn(async () => undefined);
  const credentials: GitCredentialVault = { store, remove };
  const strategy = new GitHubAuthStrategy({
    clientId: 'public-client-id',
    credentials,
    request,
    clock,
  });
  const present = jest.fn(async () => undefined);
  return {
    strategy,
    request,
    clock,
    waits,
    store,
    remove,
    credentials,
    present,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}

describe('GitHub device authorization strategy', () => {
  test('presents the code, waits for authorization, verifies identity, and stores only a credential reference', async () => {
    const h = harness([device, { error: 'authorization_pending' }, token, identity]);
    h.present.mockImplementation(async () => {
      expect(h.request).toHaveBeenCalledTimes(1);
    });
    await expect(h.strategy.signIn(h.present)).resolves.toEqual(account);
    expect(h.present).toHaveBeenCalledWith({
      userCode: 'ABCD-EFGH',
      verificationUrl: device.verification_uri,
      expiresAt: 901_000,
    });
    expect(h.waits).toEqual([5000, 5000]);
    expect(h.store).toHaveBeenCalledWith({
      host: 'github.com',
      accountId: '42',
      username: identity.login,
      token: token.access_token,
    });
    const bodies = h.request.mock.calls
      .map(([, init]) => init.body)
      .filter((body): body is string => typeof body === 'string');
    expect(bodies.every((body) => !body.includes('client_secret'))).toBe(true);
    expect(h.request.mock.calls[0]?.[0]).toBe('https://github.com/login/device/code');
    expect(h.request.mock.calls[0]?.[1].body).toContain('scope=repo');
    expect(h.request.mock.calls.at(-1)?.[0]).toBe('https://api.github.com/user');
  });

  test('honors server slowdown cumulatively and never polls earlier than allowed', async () => {
    const h = harness([
      device,
      { error: 'slow_down', interval: 10 },
      { error: 'slow_down', interval: 1 },
      token,
      identity,
    ]);
    await h.strategy.signIn(h.present);
    expect(h.waits).toEqual([5000, 10_000, 15_000]);
  });

  test.each([
    ['access_denied', 'denied'],
    ['expired_token', 'expired'],
    ['token_expired', 'expired'],
    ['incorrect_client_credentials', 'invalid_response'],
  ])('reports %s without storing a credential', async (error, code) => {
    const h = harness([device, { error }]);
    await expect(h.strategy.signIn(h.present)).rejects.toMatchObject({ code });
    expect(h.store).not.toHaveBeenCalled();
  });

  test('expires after browser suspension without another token request', async () => {
    const h = harness([device]);
    h.present.mockImplementation(async () => {
      h.advance(900_000);
    });
    await expect(h.strategy.signIn(h.present)).rejects.toMatchObject({ code: 'expired' });
    expect(h.request).toHaveBeenCalledTimes(1);
    expect(h.store).not.toHaveBeenCalled();
  });

  test('cancels during polling, prevents duplicate sign-in, and can be retried', async () => {
    const h = harness([device, device, token, identity]);
    let finishWait: (() => void) | undefined;
    const waitStarted = new Promise<void>((resolve) => {
      h.clock.wait = () =>
        new Promise<void>((finish) => {
          finishWait = finish;
          resolve();
        });
    });
    const first = h.strategy.signIn(h.present);
    await waitStarted;
    await expect(h.strategy.signIn(h.present)).rejects.toMatchObject({ code: 'busy' });
    h.strategy.cancelSignIn();
    finishWait?.();
    await expect(first).rejects.toMatchObject({ code: 'cancelled' });
    expect(h.store).not.toHaveBeenCalled();
    h.clock.wait = async () => undefined;
    await expect(h.strategy.signIn(h.present)).resolves.toEqual(account);
  });

  test('does not save a late identity response after cancellation', async () => {
    const h = harness([device, token, identity]);
    h.request.mockImplementationOnce(async () => ({
      ok: true,
      status: 200,
      json: async () => device,
    }));
    h.request.mockImplementationOnce(async () => ({
      ok: true,
      status: 200,
      json: async () => token,
    }));
    h.request.mockImplementationOnce(async () => {
      h.strategy.cancelSignIn();
      return { ok: true, status: 200, json: async () => identity };
    });
    await expect(h.strategy.signIn(h.present)).rejects.toMatchObject({ code: 'cancelled' });
    expect(h.store).not.toHaveBeenCalled();
  });

  test('removes a newly created credential if cancellation races with its write', async () => {
    const h = harness([device, token, identity]);
    h.store.mockImplementation(async () => {
      h.strategy.cancelSignIn();
      return account.credentialRef;
    });
    await expect(h.strategy.signIn(h.present)).rejects.toMatchObject({ code: 'cancelled' });
    expect(h.remove).toHaveBeenCalledWith(account.credentialRef);
  });

  test('does not accept a public-only scope as private repository access', async () => {
    const h = harness([device, { ...token, scope: 'public_repo' }]);
    await expect(h.strategy.signIn(h.present)).rejects.toMatchObject({ code: 'missing_scope' });
    expect(h.store).not.toHaveBeenCalled();
  });

  test('rejects verification URLs outside the fixed GitHub device endpoint', async () => {
    const h = harness([{ ...device, verification_uri: 'https://example.com/login/device' }]);
    await expect(h.strategy.signIn(h.present)).rejects.toMatchObject({ code: 'invalid_response' });
    expect(h.present).not.toHaveBeenCalled();
  });

  test('sign-out removes only the selected account credential', async () => {
    const h = harness([]);
    await h.strategy.signOut(account);
    expect(h.remove.mock.calls).toEqual([[account.credentialRef]]);
    expect(h.request).not.toHaveBeenCalled();
  });

  test('does not return credentials to a different host or unsafe URL', () => {
    const h = harness([]);
    for (const url of [
      'http://github.com/owner/repo.git',
      'git@github.com:owner/repo.git',
      'https://github.com.attacker.example/owner/repo.git',
      'https://gitlab.com/owner/repo.git',
      'https://user:password@github.com/owner/repo.git',
      'https://github.com:444/owner/repo.git',
      'https://github.com/owner/repo.git?token=value',
    ]) {
      expect(() => h.strategy.resolveCredential(account, url)).toThrow();
    }
    expect(h.strategy.resolveCredential(account, 'https://github.com/owner/repo.git')).toBe(
      account.credentialRef,
    );
  });

  test('configuration and malformed responses fail explicitly', async () => {
    const h = harness([]);
    const strategy = new GitHubAuthStrategy({ clientId: '', credentials: h.credentials });
    await expect(strategy.signIn(h.present)).rejects.toMatchObject({ code: 'not_configured' });
    const malformed = harness([{ ...device, interval: 0 }]);
    await expect(malformed.strategy.signIn(malformed.present)).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  test('does not include HTTP response secrets in reported errors', async () => {
    const h = harness([]);
    h.request.mockResolvedValue({ ok: false, status: 401, json: async () => token });
    await expect(h.strategy.signIn(h.present)).rejects.toThrow('GitHub request failed (HTTP 401).');
    expect(h.store).not.toHaveBeenCalled();
  });

  test('rejects credentials that cannot safely be used as bearer tokens', async () => {
    const h = harness([device, { ...token, access_token: 'secret-with\ncontrol-character' }]);
    await expect(h.strategy.signIn(h.present)).rejects.toThrow(
      'GitHub returned an invalid credential.',
    );
    expect(h.request).toHaveBeenCalledTimes(2);
    expect(h.store).not.toHaveBeenCalled();
  });

  test('does not propagate credential-bearing JSON parser errors', async () => {
    const h = harness([]);
    h.request.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('unexpected test-token-not-a-secret');
      },
    });
    await expect(h.strategy.signIn(h.present)).rejects.toThrow('GitHub did not return valid JSON.');
    expect(h.store).not.toHaveBeenCalled();
  });
});

describe('authorization cancellation and timeouts', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test('aborting a real polling wait clears its timer', async () => {
    jest.useFakeTimers();
    const controller = new AbortController();
    const wait = authorizationClock.wait(5000, controller.signal);
    controller.abort();
    await expect(wait).rejects.toMatchObject({ code: 'cancelled' });
    expect(jest.getTimerCount()).toBe(0);
  });

  test('a hung request times out, stops sign-in, and leaves no polling timer', async () => {
    jest.useFakeTimers();
    const h = harness([]);
    h.request.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener(
            'abort',
            () => {
              reject(new Error('aborted'));
            },
            { once: true },
          );
        }),
    );
    const signIn = h.strategy.signIn(h.present);
    const result = signIn.catch((error: unknown) => error);
    await jest.advanceTimersByTimeAsync(30_000);
    await expect(result).resolves.toMatchObject({ code: 'timeout' });
    expect(h.present).not.toHaveBeenCalled();
    expect(h.store).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });
});
