import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '../..');
const read = (relative) => readFileSync(path.join(root, relative), 'utf8');
const buildScript = read('scripts/build-desktop-windows.ps1');
const testScript = read('scripts/test-desktop-windows.ps1');
const workflow = read('.github/workflows/build-and-test.yml');
const readme = read('README.md');
const setupOperations = read('docs/setup-and-operations.md');
const troubleshooting = read('docs/troubleshooting.md');
const packageManifest = JSON.parse(read('package.json'));
const gitignore = read('.gitignore');
const globalJson = JSON.parse(read('global.json'));
const windowsProject = read(
  'apps/desktop/windows/src/DapperCode.Windows/DapperCode.Windows.csproj',
);
const applicationManifest = read('apps/desktop/windows/src/DapperCode.Windows/app.manifest');
const appxManifest = read('apps/desktop/windows/src/DapperCode.Windows/Package.appxmanifest');
const workflowJob = (name) =>
  workflow.match(new RegExp(`\\n  ${name}:\\n[\\s\\S]*?(?=\\n  [\\w-]+:\\n|$)`))?.[0];

test('Windows packaging builds architecture-matched native binaries and an MSIX bundle', () => {
  assert.deepEqual(globalJson.sdk, {
    version: '10.0.302',
    rollForward: 'disable',
    allowPrerelease: false,
  });
  for (const target of ['x86_64-pc-windows-msvc', 'aarch64-pc-windows-msvc']) {
    assert.match(buildScript, new RegExp(target));
  }
  assert.match(buildScript, /RustOperatorPath/);
  assert.match(buildScript, /RustBridgePath/);
  assert.match(buildScript, /build\/windows-source/);
  for (const property of ['PackageIdentityName', 'PackagePublisher', 'PackageVersion']) {
    assert.match(buildScript, new RegExp(`/p:${property}=`));
    assert.match(windowsProject, new RegExp(`<${property}>`));
  }
  assert.match(windowsProject, /GenerateParameterizedPackageManifest/);
  assert.match(buildScript, /makeappx\.exe/);
  assert.match(buildScript, /"bundle"/);
  assert.match(buildScript, /"\/bv", \$msixVersion/);
  assert.match(buildScript, /x64_arm64\.msixbundle/);
  assert.match(buildScript, /"\/t:Restore"/);
  assert.match(buildScript, /\$requiredDotNetSdkVersion = "10\.0\.302"/);
  assert.match(buildScript, /Resolve-PinnedDotNet/);
  assert.match(buildScript, /dotnet --version/);
  assert.match(buildScript, /must provide MSBuild 18/);
  assert.match(buildScript, /Invoke-Native \$dotnet @\(\s*"msbuild",[\s\S]{0,300}"\/t:Restore"/);
  assert.match(buildScript, /Invoke-Native \$dotnet @\(\s*"msbuild",[\s\S]{0,300}"\/t:Build"/);
  assert.doesNotMatch(
    buildScript,
    /Find-MSBuild|vswhere|Visual Studio Build Tools|Get-Command "msbuild\.exe"/i,
  );
  assert.match(buildScript, /"--platform", "windows"/);
  assert.match(buildScript, /"--cargo-target", \$rustTarget/);
  assert.match(buildScript, /"--nuget-assets", \$nugetAssets/);
  assert.match(buildScript, /Licenses\/THIRD_PARTY_NOTICES\.txt/);
  assert.match(windowsProject, /<AssemblyName>DapperCode<\/AssemblyName>/);
  assert.match(windowsProject, /Link="bin\\dappercode\.exe"/);
  assert.match(windowsProject, /Link="bin\\dappercode-bridge\.exe"/);
  assert.match(windowsProject, /Link="Licenses\\DapperCode-LICENSE\.txt"/);
  for (const [platform, runtime, rustTarget, machine] of [
    ['x64', 'win-x64', 'x86_64-pc-windows-msvc', 'x64'],
    ['ARM64', 'win-arm64', 'aarch64-pc-windows-msvc', 'arm64'],
  ]) {
    assert.match(
      buildScript,
      new RegExp(
        `Platform = "${platform}"[\\s\\S]{0,160}` +
          `Runtime = "${runtime}"[\\s\\S]{0,160}` +
          `RustTarget = "${rustTarget}"[\\s\\S]{0,160}` +
          `Machine = "${machine}"`,
      ),
    );
  }
  assert.match(
    buildScript,
    /foreach \(\$architecture in \$architectures\)[\s\S]+?"--cargo-target", \$rustTarget[\s\S]+?\/p:Platform=\$\(\$architecture\.Platform\)/,
  );
});

test('Windows signing keeps private keys outside artifacts and fails closed in production', () => {
  assert.match(buildScript, /\} else \{\s+"Test"\s+\}\),/);
  assert.match(buildScript, /Cert:\\CurrentUser\\My/);
  assert.match(buildScript, /LOCALAPPDATA/);
  assert.match(buildScript, /\[ValidateSet\("Package", "Sign"\)\]/);
  assert.match(buildScript, /DAPPERCODE_WINDOWS_CERTIFICATE_(PATH|BASE64)/);
  assert.match(buildScript, /DAPPERCODE_WINDOWS_CERTIFICATE_PASSWORD is missing/);
  assert.match(buildScript, /DAPPERCODE_WINDOWS_PUBLISHER is missing/);
  assert.match(buildScript, /production certificate inputs.+dedicated Sign.+operation/is);
  assert.match(buildScript, /signing certificate must be stored outside the repository/);
  assert.match(buildScript, /DAPPERCODE_WINDOWS_TIMESTAMP_URL is missing/);
  assert.match(buildScript, /"\/tr", \$timestampUrl, "\/td", "SHA256"/);
  assert.match(buildScript, /DapperCode-Signing\.cer/);
  assert.doesNotMatch(buildScript, /Join-Path \$distDirectory "[^"]*\.pfx"/);
  assert.doesNotMatch(buildScript, /CurrentUser\\TrustedPeople/);
  assert.match(buildScript, /LocalMachine\\TrustedPeople/);
  assert.match(gitignore, /^\*\.pfx$/m);
  assert.match(setupOperations, /RFC 3161/);
  assert.match(setupOperations, /DAPPERCODE_WINDOWS_TIMESTAMP_URL/);
  assert.match(setupOperations, /-Operation Sign/);
});

test('production signing credentials are isolated from checkout, npm, build, and tests', () => {
  const buildJob = workflowJob('desktop-windows');
  const signingJob = workflowJob('desktop-windows-production-sign');
  assert.ok(buildJob, 'Desktop Windows build/test workflow job is missing');
  assert.ok(signingJob, 'Protected production signing workflow job is missing');

  assert.match(
    buildJob,
    /if: inputs\.windows_signing_mode != 'Production' \|\| github\.ref == 'refs\/heads\/main'/,
  );
  assert.match(
    signingJob,
    /github\.event_name == 'workflow_dispatch'[\s\S]+inputs\.windows_signing_mode == 'Production'[\s\S]+github\.ref == 'refs\/heads\/main'/,
  );
  assert.match(signingJob, /needs: desktop-windows/);
  assert.match(signingJob, /environment: windows-production-signing/);
  assert.match(signingJob, /actions\/download-artifact@v4/);
  assert.match(signingJob, /actions\/upload-artifact@v4/);
  assert.doesNotMatch(signingJob, /actions\/checkout|Checkout code/);
  assert.doesNotMatch(
    signingJob,
    /(?:npm|node|dotnet|cargo)\s|[.][\\/](?:scripts|apps|services)\b|build-desktop-windows|test-desktop-windows|Invoke-Expression|\biex\b|\.ps1\b/i,
  );

  const signingStep = signingJob.match(
    /\n      - name: Sign and verify production packages[\s\S]*?(?=\n      - name:)/,
  )?.[0];
  assert.ok(signingStep, 'Inline production signing step is missing');
  assert.match(signingStep, /WINDOWS_SIGNING_CERTIFICATE_BASE64/);
  assert.match(signingStep, /WINDOWS_SIGNING_CERTIFICATE_PASSWORD/);
  assert.match(signingStep, /WINDOWS_SIGNING_TIMESTAMP_URL/);
  assert.match(signingStep, /expectedRelativeFiles/);
  assert.match(signingStep, /DapperCode-\$version-x64\.msix/);
  assert.match(signingStep, /DapperCode-\$version-arm64\.msix/);
  assert.match(signingStep, /certificate\.Subject -ne \$env:DAPPERCODE_WINDOWS_PUBLISHER/);
  assert.match(signingStep, /absolute HTTPS RFC 3161 endpoint/);
  assert.match(signingStep, /"\/tr", \$timestampUrl, "\/td", "SHA256"/);
  assert.match(signingStep, /"verify", "\/pa", "\/all", "\/v"/);
  assert.match(signingStep, /DapperCode-Signing\.cer/);
  assert.match(signingStep, /INSTALL-WINDOWS\.txt/);
  assert.doesNotMatch(signingStep, /\bnpm\b/);

  const workflowWithoutSigningStep = workflow.replace(signingStep, '');
  assert.doesNotMatch(workflowWithoutSigningStep, /secrets\.WINDOWS_SIGNING_CERTIFICATE_BASE64/);
  assert.doesNotMatch(workflowWithoutSigningStep, /secrets\.WINDOWS_SIGNING_CERTIFICATE_PASSWORD/);
  assert.ok(
    buildJob.indexOf('Build unsigned production') < buildJob.indexOf('Inspect unsigned production'),
    'Unsigned production inspection must happen after the build',
  );
  assert.ok(
    buildJob.indexOf('Inspect unsigned production') <
      buildJob.indexOf('Upload inspected unsigned production'),
    'Only an inspected unsigned production artifact may be uploaded for signing',
  );
  assert.match(buildJob, /desktop:test:windows -- -SigningMode Production -SkipSignature/);
  assert.match(buildJob, /retention-days: 1/);
  assert.doesNotMatch(buildJob, /secrets\.WINDOWS_SIGNING_/);
});

test('Windows app remains per-user and does not require an administrator or service', () => {
  assert.match(applicationManifest, /requestedExecutionLevel level="asInvoker"/);
  assert.doesNotMatch(applicationManifest, /requireAdministrator|highestAvailable/);
  assert.match(appxManifest, /Category="windows\.startupTask"/);
  assert.match(appxManifest, /Enabled="false"/);
  assert.doesNotMatch(
    [windowsProject, applicationManifest, appxManifest].join('\n'),
    /CreateService|ServiceProcess|windows\.service|scheduledTask|requireAdministrator/i,
  );
});

test('Windows inspection covers signatures, identity, architecture, layout, and runtime policy', () => {
  assert.match(testScript, /signtool\.exe/);
  assert.match(testScript, /\[ValidateSet\("Test", "Production"\)\]/);
  assert.match(testScript, /\[switch\]\$SkipSignature/);
  assert.match(testScript, /\$SkipSignature -and \$SigningMode -ne "Production"/);
  assert.match(testScript, /ExpectedIdentity/);
  assert.match(testScript, /ExpectedPublisher/);
  assert.match(testScript, /Cert:\\CurrentUser\\Root/);
  assert.match(testScript, /temporaryTrustedRootThumbprint/);
  assert.match(testScript, /bundleIdentity\.Version -ne \$packageVersions\[0\]/);
  const inspectionParameters = testScript.slice(0, testScript.indexOf('$ErrorActionPreference'));
  assert.doesNotMatch(inspectionParameters, /DAPPERCODE_WINDOWS_PUBLISHER/);
  assert.match(
    testScript,
    /if \(\$SigningMode -eq "Production"\)[\s\S]+DAPPERCODE_WINDOWS_PUBLISHER[\s\S]+else \{[\s\S]+CN=DapperCode/,
  );
  assert.match(testScript, /ProcessorArchitecture/);
  assert.match(testScript, /Get-PeMachine/);
  assert.match(
    testScript,
    /if \(\$SkipSignature\)[\s\S]+standaloneArchitectures[\s\S]+Assert-PackagePayload/,
  );
  assert.match(testScript, /Get-FileHash \$package\.FullName -Algorithm SHA256/);
  assert.match(testScript, /does not match the inspected package/);
  for (const required of [
    'DapperCode.exe',
    'bin/dappercode.exe',
    'bin/dappercode-bridge.exe',
    'Licenses/DapperCode-LICENSE.txt',
    'Licenses/QRCoder-LICENSE.txt',
    'Licenses/THIRD_PARTY_NOTICES.txt',
    'Assets/AppIcon.ico',
    'Assets/StoreLogo.png',
    'Assets/TrayActive.ico',
    'Assets/TrayIdle.ico',
  ]) {
    assert.match(testScript, new RegExp(required.replaceAll('.', '\\.')));
  }
  for (const forbidden of ['node_modules', 'package-lock.json', '.mjs', 'slint']) {
    assert.match(testScript.toLowerCase(), new RegExp(forbidden.replaceAll('.', '\\.')));
  }
});

test('npm and CI expose the complete pinned Windows packaging flow', () => {
  assert.equal(
    packageManifest.scripts['desktop:build:windows'],
    'pwsh -NoProfile -File ./scripts/build-desktop-windows.ps1',
  );
  assert.equal(
    packageManifest.scripts['desktop:test:windows'],
    'pwsh -NoProfile -File ./scripts/test-desktop-windows.ps1',
  );
  assert.match(workflow, /runs-on: windows-latest/);
  assert.match(workflow, /windows_signing_mode:[\s\S]+default: Test/);
  assert.match(workflow, /DOTNET_VERSION: ['"]10\.0\.302['"]/);
  assert.match(workflow, /NUGET_VERSION: ['"]6\.14\.0['"]/);
  assert.match(workflow, /targets: x86_64-pc-windows-msvc,aarch64-pc-windows-msvc/);
  assert.match(
    workflow,
    /dotnet msbuild apps\/desktop\/windows\/DapperCode\.Windows\.slnx \/t:Restore/,
  );
  assert.match(workflow, /Get-ChildItem.+\*\.Tests\.csproj/);
  assert.doesNotMatch(
    workflow,
    /dotnet test\s+apps\/desktop\/windows\/tests\/DapperCode\.Core\.Tests/,
  );
  assert.match(workflow, /desktop:build:windows/);
  assert.match(workflow, /desktop:build:windows -- -SkipInspection/);
  assert.match(workflow, /desktop:test:windows/);
  assert.match(workflow, /dappercode-desktop-windows-unsigned-production/);
  assert.match(workflow, /Upload test-signed Windows bundle and public certificate/);
  assert.match(workflow, /Upload signed production bundle/);
  assert.match(workflow, /DapperCode-Signing\.cer/);
});

test('Windows build and certificate trust documentation matches the packaging behavior', () => {
  const buildDocumentation = [readme, setupOperations].join('\n');
  const installDocumentation = [readme, setupOperations, troubleshooting].join('\n');

  assert.doesNotMatch(buildDocumentation, /Visual Studio Build Tools/);
  assert.match(buildDocumentation, /10\.0\.302/);
  assert.match(buildDocumentation, /MSBuild 18/);
  assert.match(readme, /does not install its generated test certificate[\s\S]+leave it trusted/);
  assert.doesNotMatch(readme, /build imports its generated test certificate/i);
  assert.match(
    installDocumentation,
    /one-time elevated|import the emitted public certificate once[\s\S]+elevated terminal/i,
  );
  assert.match(setupOperations, /windows-production-signing/);
  assert.match(setupOperations, /performs no checkout/);
  assert.match(setupOperations, /required\s+reviewers/);
});
