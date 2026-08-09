import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  collectCargoPackages,
  collectNuGetPackages,
  parseArgs,
  renderNotices,
} from '../generate-desktop-notices.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const fixtureAssets = path.join(
  root,
  'scripts/__tests__/fixtures/desktop-notices/project.assets.json',
);
const actualWindowsAssets = path.join(
  root,
  'apps/desktop/windows/src/DapperCode.Windows/obj/project.assets.json',
);
const checkedInWindowsNotices = path.join(
  root,
  'apps/desktop/windows/src/DapperCode.Windows/Licenses/THIRD_PARTY_NOTICES.txt',
);
const packageRoot = root;
const cargoPackage = {
  ecosystem: 'Cargo',
  license: 'MIT',
  name: 'cargo-example',
  root: packageRoot,
  version: '1.0.0',
};
const nugetPackage = {
  ecosystem: 'NuGet',
  license: 'MIT',
  name: 'NuGet.Example',
  root: packageRoot,
  version: '2.0.0',
};

function cargoMetadataFor(target) {
  const rootPackage = {
    id: 'path+file:///fixture/desktop#desktop@1.0.0',
    manifest_path: path.join(root, 'fixtures/desktop/Cargo.toml'),
    name: 'desktop',
    source: null,
    version: '1.0.0',
  };
  const shared = {
    id: 'registry+https://example.invalid/index#shared-runtime@1.0.0',
    manifest_path: path.join(root, 'fixtures/shared-runtime/Cargo.toml'),
    name: 'shared-runtime',
    source: 'registry+https://example.invalid/index',
    version: '1.0.0',
  };
  const architecturePackage =
    target === 'x86_64-pc-windows-msvc'
      ? {
          id: 'registry+https://example.invalid/index#windows-x64-runtime@1.0.0',
          manifest_path: path.join(root, 'fixtures/windows-x64-runtime/Cargo.toml'),
          name: 'windows-x64-runtime',
          source: 'registry+https://example.invalid/index',
          version: '1.0.0',
        }
      : {
          id: 'registry+https://example.invalid/index#windows-arm64-runtime@1.0.0',
          manifest_path: path.join(root, 'fixtures/windows-arm64-runtime/Cargo.toml'),
          name: 'windows-arm64-runtime',
          source: 'registry+https://example.invalid/index',
          version: '1.0.0',
        };
  return {
    packages: [rootPackage, shared, architecturePackage],
    resolve: {
      nodes: [
        {
          deps: [{ pkg: shared.id }, { pkg: architecturePackage.id }],
          id: rootPackage.id,
        },
        { deps: [], id: shared.id },
        { deps: [], id: architecturePackage.id },
      ],
      root: rootPackage.id,
    },
  };
}

test('desktop notices remain macOS-compatible and describe the Windows managed payload', () => {
  const macos = renderNotices({
    cargoPackages: [cargoPackage],
    nugetPackages: [nugetPackage],
    platform: 'macos',
  });
  assert.match(macos, /macOS application.+bundles only Rust executables/);
  assert.doesNotMatch(macos, /Bundled NuGet packages/);
  assert.doesNotMatch(macos, /NuGet\.Example/);

  const windows = renderNotices({
    cargoPackages: [cargoPackage],
    nugetPackages: [nugetPackage],
    platform: 'windows',
  });
  assert.match(windows, /managed \.NET shell with native Rust executables/);
  assert.match(windows, /Bundled NuGet packages:\n\n- NuGet\.Example 2\.0\.0 \(MIT\)/);
  assert.match(windows, /Applies to:/);
  assert.match(windows, /License Texts/);
});

test('Cargo notices accept separated license names and fail closed without terms', () => {
  const separated = {
    ...cargoPackage,
    name: 'cargo-separated-license',
    root: path.join(root, 'scripts/__tests__/fixtures/desktop-notices/cargo-separated-license'),
  };
  const notices = renderNotices({
    cargoPackages: [separated],
    platform: 'macos',
  });
  assert.match(notices, /Separated Cargo license terms\./);

  assert.throws(
    () =>
      renderNotices({
        cargoPackages: [
          {
            ...cargoPackage,
            license: 'Unknown-1.0',
            name: 'cargo-no-license',
            root: path.join(root, 'scripts/__tests__/fixtures/desktop-notices/cargo-no-license'),
          },
        ],
        platform: 'macos',
      }),
    /does not provide distributable license terms/,
  );
});

test('Windows notices require a Cargo target while macOS defaults to the Rust host', () => {
  assert.throws(
    () =>
      parseArgs([
        '--platform',
        'windows',
        '--nuget-assets',
        fixtureAssets,
        '--output',
        'notices.txt',
      ]),
    /--cargo-target is required for Windows notices/,
  );
  assert.equal(parseArgs(['--output', 'notices.txt']).cargoTarget, undefined);

  const invocations = [];
  collectCargoPackages(root, 'apps/desktop/Cargo.toml', undefined, (command, args) => {
    invocations.push({ args, command });
    if (command === 'rustc') return 'rustc 1.0.0\nhost: aarch64-apple-darwin\n';
    return JSON.stringify(cargoMetadataFor('aarch64-apple-darwin'));
  });
  assert.equal(invocations[0].command, 'rustc');
  assert.deepEqual(
    invocations[1].args.slice(
      invocations[1].args.indexOf('--filter-platform'),
      invocations[1].args.indexOf('--filter-platform') + 2,
    ),
    ['--filter-platform', 'aarch64-apple-darwin'],
  );
});

test('Cargo notice closures are filtered independently for x64 and ARM64', () => {
  const metadataTargets = [];
  const execute = (command, args) => {
    assert.equal(command, 'cargo');
    const target = args[args.indexOf('--filter-platform') + 1];
    metadataTargets.push(target);
    return JSON.stringify(cargoMetadataFor(target));
  };
  const x64 = collectCargoPackages(
    root,
    'apps/desktop/Cargo.toml',
    'x86_64-pc-windows-msvc',
    execute,
  );
  const arm64 = collectCargoPackages(
    root,
    'apps/desktop/Cargo.toml',
    'aarch64-pc-windows-msvc',
    execute,
  );

  assert.deepEqual(metadataTargets, ['x86_64-pc-windows-msvc', 'aarch64-pc-windows-msvc']);
  assert.deepEqual(x64.map((pkg) => pkg.name).sort(), ['shared-runtime', 'windows-x64-runtime']);
  assert.deepEqual(arm64.map((pkg) => pkg.name).sort(), [
    'shared-runtime',
    'windows-arm64-runtime',
  ]);
});

test('NuGet attribution follows runtime dictionaries and build-injected payloads', () => {
  const fixture = JSON.parse(readFileSync(fixtureAssets, 'utf8'));
  for (const target of Object.values(fixture.targets)) {
    for (const name of [
      'Microsoft.WindowsAppSDK.DWrite/1.8.25122902',
      'Microsoft.WindowsAppSDK.Runtime/1.8.260710003',
    ]) {
      if (!target[name]) continue;
      assert.ok(target[name].build, `${name} must be represented by imported build targets`);
      assert.equal(target[name].runtime, undefined);
      assert.equal(target[name].native, undefined);
      assert.equal(target[name].runtimeTargets, undefined);
    }
  }
  const packages = collectNuGetPackages(fixtureAssets);
  assert.deepEqual(
    packages.map((pkg) => pkg.name),
    [
      'Example.ExpressionOnly.Runtime',
      'Example.Managed.Package',
      'Example.Native.Payload',
      'Example.Resource.Payload',
      'Microsoft.NETCore.App.Runtime.win-arm64',
      'Microsoft.NETCore.App.Runtime.win-x64',
      'Microsoft.WindowsAppSDK.DWrite',
      'Microsoft.WindowsAppSDK.Runtime',
      'Microsoft.WindowsDesktop.App.Runtime.win-x64',
    ],
  );
  assert.equal(packages.length, new Set(packages.map((pkg) => pkg.name)).size);

  const notices = renderNotices({
    cargoPackages: [],
    nugetPackages: packages,
    platform: 'windows',
  });
  assert.match(notices, /Example NuGet license attribution\./);
  assert.match(notices, /Example resource package license attribution\./);
  assert.match(notices, /Bundled \.NET ARM64 runtime license attribution\./);
  assert.match(notices, /Bundled Windows Desktop runtime license attribution\./);
  assert.match(notices, /Microsoft Windows App SDK DWrite fixture license attribution\./);
  assert.match(notices, /Microsoft Windows App SDK Runtime fixture license attribution\./);
  assert.match(
    notices,
    /Package metadata attribution: Example\.ExpressionOnly\.Runtime 2\.0\.0 declares the MIT license/,
  );
  assert.match(
    notices,
    /Package metadata attribution: Microsoft\.NETCore\.App\.Runtime\.win-x64 10\.0\.9 declares the MIT license/,
  );
  assert.match(
    notices,
    /Permission is hereby granted, free of charge, to any person obtaining a copy/,
  );
  assert.match(
    notices,
    /OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE\./,
  );
  for (const excluded of [
    'DapperCode.Core',
    'Example.Ref.Only',
    'Example.RestoreOnly.Package',
    'Microsoft.Windows.SDK.BuildTools',
    'Microsoft.WindowsDesktop.App.Ref',
  ]) {
    assert.ok(!packages.some((pkg) => pkg.name === excluded), `${excluded} must be excluded`);
  }
  for (const [packageName, payloads] of Object.entries({
    'Microsoft.WindowsAppSDK.Runtime/1.8.260710003': [
      'tools/MSIX/win10-x64/Microsoft.WindowsAppRuntime.Main.1.8.msix',
      'tools/MSIX/win10-x64/Microsoft.WindowsAppRuntime.Singleton.1.8.msix',
    ],
    'Microsoft.WindowsAppSDK.DWrite/1.8.25122902': [
      'runtimes-framework/win-x64/native/DWriteCore.dll',
    ],
  })) {
    const declaredFiles = fixture.libraries[packageName].files;
    for (const payload of payloads) {
      assert.ok(declaredFiles.includes(payload), `${packageName} must declare ${payload}`);
    }
  }
});

test('NuGet attribution fails closed when a build-injected package has no license terms', () => {
  assert.throws(
    () =>
      collectNuGetPackages(
        path.join(
          root,
          'scripts/__tests__/fixtures/desktop-notices/missing-license/project.assets.json',
        ),
      ),
    /Example\.Missing\.License 1\.0\.0 has neither a bundled license file nor a supported license expression/,
  );
});

test(
  'current Windows assets include shipped managed and self-contained runtime licenses only',
  { skip: !existsSync(actualWindowsAssets) },
  () => {
    const packages = collectNuGetPackages(actualWindowsAssets);
    const expected = [
      'CommunityToolkit.Mvvm',
      'H.NotifyIcon',
      'H.NotifyIcon.WinUI',
      'QRCoder',
      'Microsoft.NETCore.App.Host.win-arm64',
      'Microsoft.NETCore.App.Host.win-x64',
      'Microsoft.NETCore.App.Runtime.win-arm64',
      'Microsoft.NETCore.App.Runtime.win-x64',
      'Microsoft.WindowsAppSDK.DWrite',
      'Microsoft.WindowsAppSDK.Runtime',
      'Microsoft.WindowsDesktop.App.Runtime.win-arm64',
      'Microsoft.WindowsDesktop.App.Runtime.win-x64',
    ];
    const packageNames = packages.map((pkg) => pkg.name);
    for (const name of expected) {
      assert.ok(packageNames.includes(name), `${name} is missing from the shipped package closure`);
    }
    for (const excluded of [
      'Microsoft.Windows.SDK.BuildTools',
      'Microsoft.Windows.SDK.BuildTools.MSIX',
      'Microsoft.Windows.SDK.NET.Ref',
      'Microsoft.WindowsDesktop.App.Ref',
    ]) {
      assert.ok(!packageNames.includes(excluded), `${excluded} is not a shipped runtime package`);
    }
    assert.equal(
      packages.length,
      new Set(packages.map((pkg) => `${pkg.name}/${pkg.version}`)).size,
    );

    const notices = renderNotices({
      cargoPackages: [],
      nugetPackages: packages,
      platform: 'windows',
    });
    for (const name of expected) {
      const pkg = packages.find((candidate) => candidate.name === name);
      const label = `${pkg.name} ${pkg.version}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      assert.match(notices, new RegExp(`Applies to: [^\\n]*${label}`));
    }
    assert.match(
      notices,
      /Package metadata attribution: H\.NotifyIcon 2\.4\.1 declares the MIT license/,
    );
  },
);

test('checked-in Windows notices include Windows App SDK Runtime and DWrite license text', () => {
  const notices = readFileSync(checkedInWindowsNotices, 'utf8');
  for (const name of [
    'Microsoft.WindowsAppSDK.DWrite 1.8.25122902',
    'Microsoft.WindowsAppSDK.Runtime 1.8.260710003',
  ]) {
    assert.match(notices, new RegExp(`- ${name.replaceAll('.', '\\.')}`));
    assert.match(
      notices,
      new RegExp(`Applies to: [^\\n]*${name.replaceAll('.', '\\.')}[^\\n]*\\n-+\\n\\n\\S`),
    );
  }
});

test('Windows packaging generates notices from each restored NuGet closure', () => {
  const packaging = readFileSync(path.join(root, 'scripts/build-desktop-windows.ps1'), 'utf8');
  for (const required of [
    '"/t:Restore"',
    'obj/project.assets.json',
    'scripts/generate-desktop-notices.mjs',
    '"--platform", "windows"',
    '"--cargo-target", $rustTarget',
    '"--nuget-assets", $nugetAssets',
    'Licenses/THIRD_PARTY_NOTICES.txt',
  ]) {
    assert.ok(packaging.includes(required), `Windows notice packaging is missing ${required}`);
  }
});

test('Windows operations documentation covers package lifecycle and native behavior', () => {
  const documentation = [
    'README.md',
    'docs/setup-and-operations.md',
    'docs/troubleshooting.md',
    'docs/open-source-license-requirements.md',
  ]
    .map((file) => readFileSync(path.join(root, file), 'utf8'))
    .join('\n');

  for (const required of [
    'Windows 11',
    'WinUI 3',
    'x64',
    'ARM64',
    'MSIX',
    'Trusted People',
    'production signing',
    'startup task',
    'DapperCodeStartup',
    'Windows Credential Manager',
    'bridge-auth-token:v2:<sha256-profile-id>',
    'bridge-auth-vault:v2',
    'bridge-auth-vault:v1',
    'remove credentials **before** deleting `%APPDATA%\\DapperCode`',
    '%APPDATA%\\DapperCode',
    'Mica',
    'NuGet',
    'Licenses\\THIRD_PARTY_NOTICES.txt',
  ]) {
    assert.ok(documentation.includes(required), `Windows documentation is missing ${required}`);
  }
});
