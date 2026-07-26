const fs = require('fs');
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

/**
 * Metro emits CommonJS, so a dependency whose `import` export condition uses `import.meta` produces
 * a bundle that throws `Cannot use 'import.meta' outside a module` before any app code runs. Jotai's
 * `.mjs` build does exactly that, and the web platform resolves through that condition, so the web
 * bundle white-screened as soon as app state moved onto Jotai. Native is unaffected because the
 * `react-native` condition already selects the CommonJS build.
 *
 * Map the package to its CommonJS files explicitly rather than dropping the `import` condition
 * globally, which would silently change resolution for unrelated dependencies.
 */
const COMMONJS_ONLY_PACKAGES = ['jotai'];

const commonJsRoots = new Map(
  COMMONJS_ONLY_PACKAGES.map((name) => [
    name,
    path.dirname(require.resolve(`${name}/package.json`)),
  ]),
);

function resolveCommonJsEntry(moduleName) {
  const separator = moduleName.indexOf('/');
  const packageName = separator === -1 ? moduleName : moduleName.slice(0, separator);
  const root = commonJsRoots.get(packageName);
  if (!root) {
    return null;
  }
  const subpath = separator === -1 ? 'index' : moduleName.slice(separator + 1);
  const candidates = [path.join(root, `${subpath}.js`), path.join(root, subpath, 'index.js')];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

const defaultResolveRequest = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  const filePath = resolveCommonJsEntry(moduleName);
  if (filePath) {
    return { type: 'sourceFile', filePath };
  }
  return (defaultResolveRequest ?? context.resolveRequest)(context, moduleName, platform);
};

module.exports = config;
