import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const mobileRequire = createRequire(new URL('../../apps/mobile/package.json', import.meta.url));

function loadDependency(...names) {
  let require = mobileRequire;
  for (const name of names.slice(0, -1)) {
    require = createRequire(require.resolve(name));
  }
  const dependency = require(names.at(-1));
  return dependency.default ?? dependency;
}

const configPlugins = ['expo', '@expo/config-plugins'];
const plistPaths = [
  [...configPlugins, '@expo/plist'],
  [...configPlugins, 'xcode', 'simple-plist', 'plist'],
];

for (const dependencyPath of plistPaths) {
  const name = dependencyPath.at(-1);

  test(`${name} preserves native property-list values`, () => {
    const plist = loadDependency(...dependencyPath);
    const values = {
      CFBundleName: 'DapperCode & <XML>',
      Enabled: true,
      Count: 7,
      Nested: { Schemes: ['dappercode', 'https'] },
    };
    assert.deepEqual(structuredClone(plist.parse(plist.build(values))), values);
  });

  test(`${name}'s XML parser rejects processing-instruction target injection`, () => {
    const { DOMImplementation, XMLSerializer } = loadDependency(
      ...dependencyPath,
      '@xmldom/xmldom',
    );
    const document = new DOMImplementation().createDocument(null, 'root', null);
    document.documentElement.appendChild(document.createProcessingInstruction('a>', 'data'));

    // GHSA-c7q8-3ch8-vqpv: invalid targets must not bypass strict serialization.
    // The 0.8 API used by @expo/plist takes serializer options as its fourth argument.
    const options = { requireWellFormed: true };
    const args =
      name === '@expo/plist' ? [document, false, undefined, options] : [document, options];
    assert.throws(() => new XMLSerializer().serializeToString(...args), { code: 11 });
  });
}

const yamlPaths = [
  ['expo', '@expo/cli', '@expo/xcpretty', 'js-yaml'],
  ['jest-expo', 'babel-jest', 'babel-plugin-istanbul', '@istanbuljs/load-nyc-config', 'js-yaml'],
];

for (const dependencyPath of yamlPaths) {
  test(`${dependencyPath.at(-2)}'s YAML parser budgets empty merge sources`, () => {
    const yaml = loadDependency(...dependencyPath);
    assert.deepEqual(yaml.load('defaults: &defaults {enabled: true}\napp: {<<: *defaults}'), {
      defaults: { enabled: true },
      app: { enabled: true },
    });

    // GHSA-2883-xcg3-v3hh: bounded input reproduces the bypass without a CPU-heavy payload.
    const source = 'arr: &arr [{}, {}, {}]\ntargets:\n  - <<: *arr\n  - <<: *arr\n';
    assert.throws(() => yaml.load(source, { maxTotalMergeKeys: 4 }), /merge/i);
  });
}

test("expo-router's query parser decodes through the patched URI decoder", () => {
  const queryString = loadDependency('expo-router', 'query-string');
  const decode = loadDependency('expo-router', 'query-string', 'decode-uri-component');

  // query-string@7 calls require('decode-uri-component') directly, so the patched release must
  // stay a callable CommonJS export rather than an ES module namespace.
  assert.equal(typeof decode, 'function');
  assert.deepEqual(
    { ...queryString.parse('mark=%E2%9C%93&bare=%&mixed=%C3%A5%ZZ') },
    { mark: '✓', bare: '%', mixed: 'å%ZZ' },
  );

  // GHSA-qr28-fpjm-wq7f: malformed percent runs must decode in linear time. Vulnerable releases
  // take many seconds on this input; the patched decoder finishes it in milliseconds.
  const malformed = `${'%C3'.repeat(20_000)}%`;
  const started = performance.now();
  assert.equal(decode(malformed), malformed);
  assert.ok(performance.now() - started < 1_000, 'malformed percent runs decode in linear time');
});
