import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from '../../../metro.config.js';

config.cacheVersion = 'dappercode-owned-product-transport-v1';
const directory = path.dirname(fileURLToPath(import.meta.url));
const adapter = path.join(directory, 'product-transport.ts');
const targets = new Set([
  path.resolve(directory, '../../../src/features/on-device/native/services.ios.ts'),
  path.resolve(directory, '../../../src/features/on-device/runtime/webRequest.ts'),
]);
const resolve = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const result = (resolve ?? context.resolveRequest)(context, moduleName, platform);
  if (
    context.originModulePath !== adapter &&
    result.type === 'sourceFile' &&
    targets.has(result.filePath)
  ) {
    return { type: 'sourceFile', filePath: adapter };
  }
  return result;
};

export default config;
