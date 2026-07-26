import { toBridgeHealthUrl } from '../../bridgeUrl';
import { HostBridgeWsClient } from '../../api/ws';
import { CONNECTION_CHECK_TIMEOUT_MS } from './onboardingScreenConstants';

interface ProbeOptions {
  normalizedUrl: string;
  token: string | null;
  allowQueryTokenAuth: boolean;
}

export interface ProbeResult {
  ok: boolean;
  healthCheckError: string | null;
}

export async function probeBridgeConnection(options: ProbeOptions): Promise<ProbeResult> {
  const { normalizedUrl, token, allowQueryTokenAuth } = options;
  let probeClient: HostBridgeWsClient | null = null;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  const abortController = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeoutMessage = 'connection timed out after 7 seconds';

  const disconnectProbe = () => {
    probeClient?.disconnect();
  };

  try {
    const probe = async (): Promise<string | null> => {
      let healthCheckError: string | null = null;
      const headers: Record<string, string> | undefined = token
        ? { Authorization: `Bearer ${token}` }
        : undefined;
      const healthUrl = toBridgeHealthUrl(normalizedUrl);

      try {
        const response = await fetch(healthUrl, {
          method: 'GET',
          headers,
          signal: abortController?.signal,
        });
        if (response.status !== 200) {
          healthCheckError = `health returned ${response.status}`;
        }
      } catch (error) {
        if (timedOut) {
          throw new Error(timeoutMessage);
        }
        healthCheckError = (error as Error).message || 'network request failed';
      }

      if (timedOut) {
        throw new Error(timeoutMessage);
      }

      probeClient = new HostBridgeWsClient(normalizedUrl, {
        authToken: token,
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

    const healthCheckError = await Promise.race([
      probe(),
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
    disconnectProbe();
  }
}
