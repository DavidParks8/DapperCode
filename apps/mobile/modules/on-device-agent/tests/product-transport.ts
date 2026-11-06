import { File, Paths } from 'expo-file-system';
import { getOnDeviceNativeServices as originalServices } from '../../../src/features/on-device/native/services.ios';
import type { OnDeviceNativeServices } from '../../../src/features/on-device/native/services.types';
import { requestWeb as originalRequest } from '../../../src/features/on-device/runtime/webRequest';
import { toRecord } from '../../../src/shared/runtimeValidation';

export * from '../../../src/features/on-device/runtime/webRequest';

const observedFiles: Record<string, { uri: string }> = {};

function configuration() {
  const value = toRecord(JSON.parse(new File(Paths.document, 'product-transport.json').textSync()));
  if (!value) {
    throw new Error('The owned product transport configuration is missing or invalid.');
  }
  return value;
}

function ownedHttps(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('The product fixture requires its owned HTTPS endpoint.');
  }
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== '127.0.0.1' || !url.port) {
    throw new Error('The product fixture endpoint must be its allocated loopback HTTPS port.');
  }
  return url.toString().replace(/\/$/u, '');
}

export const requestWeb: typeof originalRequest = (url, init) => {
  if (url !== 'https://mcp.exa.ai/mcp') {
    return originalRequest(url, init);
  }
  const origin = ownedHttps(configuration()['searchOrigin']);
  const headers = new Headers(init.headers);
  headers.set('X-DapperCode-Fixture-Target', url);
  return originalRequest(`${origin}/mcp`, { ...init, headers });
};

export function getOnDeviceNativeServices(): OnDeviceNativeServices {
  return new Proxy(originalServices(), {
    get(target, property, receiver) {
      if (property === 'startModelDownload') {
        return (id: string, url: string, bytes: number) => {
          const overrides = toRecord(configuration()['modelDownloads']);
          const override = overrides?.[id];
          return target.startModelDownload(
            id,
            override === undefined ? url : ownedHttps(override),
            bytes,
          );
        };
      }
      if (property === 'getDownloadedModelFile') {
        return async (id: string) => {
          const file = await target.getDownloadedModelFile(id);
          if (file && observedFiles[id]?.uri !== file.uri) {
            observedFiles[id] = { uri: file.uri };
            new File(Paths.document, 'product-model-files.json').write(
              JSON.stringify(observedFiles),
            );
          }
          return file;
        };
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return value;
    },
  });
}
