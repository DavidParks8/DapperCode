import { toBridgeHealthUrl } from '@shell/state/bridgeUrl';
import { HostBridgeWsClient } from '@bridge/ws/ws';
import { CONNECTION_CHECK_TIMEOUT_MS } from './constants';

interface ProbeOptions {
  normalizedUrl: string;
  token: string | null;
  workspaceId?: string | null;
  allowQueryTokenAuth: boolean;
  abortController?: AbortController | null;
}

export interface ProbeResult {
  ok: boolean;
  healthCheckError: string | null;
}

async function readHealthCheckError(
  normalizedUrl: string,
  token: string | null,
  signal: AbortSignal | undefined,
  wasCancelled: () => boolean,
  timeoutMessage: string,
): Promise<string | null> {
  try {
    const response = await fetch(toBridgeHealthUrl(normalizedUrl), {
      method: 'GET',
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      signal,
    });
    return response.status === 200 ? null : `health returned ${response.status}`;
  } catch (error) {
    if (wasCancelled()) {
      throw new Error(timeoutMessage);
    }
    return (error as Error).message || 'network request failed';
  }
}

export async function probeBridgeConnection(options: ProbeOptions): Promise<ProbeResult> {
  const { normalizedUrl, token, workspaceId, allowQueryTokenAuth } = options;
  let probeClient: HostBridgeWsClient | null = null;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  const abortController =
    options.abortController ??
    (typeof AbortController !== 'undefined' ? new AbortController() : null);
  const timeoutMessage = 'connection timed out after 70 seconds';

  const disconnectProbe = () => {
    probeClient?.disconnect();
  };
  let rejectAbort: (reason?: unknown) => void = () => {};
  const onAbort = () => {
    disconnectProbe();
    rejectAbort(new Error(timedOut ? timeoutMessage : 'connection check cancelled'));
  };

  try {
    const probe = async (): Promise<string | null> => {
      const wasCancelled = () => timedOut || Boolean(abortController?.signal.aborted);
      const healthCheckError = await readHealthCheckError(
        normalizedUrl,
        token,
        abortController?.signal,
        wasCancelled,
        timeoutMessage,
      );
      if (wasCancelled()) {
        throw new Error(timeoutMessage);
      }

      probeClient = new HostBridgeWsClient(normalizedUrl, {
        authToken: token,
        workspaceId,
        allowQueryTokenAuth,
        requestTimeoutMs: CONNECTION_CHECK_TIMEOUT_MS,
      });
      probeClient.connect();
      const rpcHealth = await probeClient.request<{ status?: string }>('bridge/health/read');
      if (rpcHealth?.status !== 'ok' && rpcHealth?.status !== 'degraded') {
        throw new Error('authenticated RPC probe returned unexpected response');
      }
      return healthCheckError;
    };

    const abortPromise = new Promise<never>((_, reject) => {
      rejectAbort = reject;
      const signal = abortController?.signal;
      if (!signal) {
        return;
      }
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    });
    const healthCheckError = await Promise.race([
      probe(),
      abortPromise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          timedOut = true;
          abortController?.abort();
          disconnectProbe();
          reject(new Error(timeoutMessage));
        }, CONNECTION_CHECK_TIMEOUT_MS);
      }),
    ]);

    return { ok: true, healthCheckError };
  } catch {
    return { ok: false, healthCheckError: null };
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    abortController?.signal.removeEventListener('abort', onAbort);
    disconnectProbe();
  }
}
