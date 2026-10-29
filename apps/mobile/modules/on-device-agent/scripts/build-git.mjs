import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const moduleRoot = fileURLToPath(new URL('..', import.meta.url));
const buildRoot = path.join(moduleRoot, 'ios', 'build', 'git');
const version = '1.9.7';
const sha256 = '1a4fbe7589e814777ae76b64734ad80f4ecad22cd33a22682a2aaea4ae5375e7';
const deploymentTarget = '16.4';
const cmake = process.env.DAPPERCODE_CMAKE ?? 'cmake';
const framework = path.join(buildRoot, 'libgit2.xcframework');
const marker = path.join(buildRoot, 'configuration.json');
const configuration = JSON.stringify({
  version,
  sha256,
  deploymentTarget,
  https: true,
  ssh: false,
  simulatorArchitectures: ['arm64', 'x86_64'],
});

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error) {
    throw new Error(`Could not run ${command}: ${result.error.message}`, { cause: result.error });
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} failed (${result.status ?? result.signal}):\n${result.stderr}\n${result.stdout}`,
    );
  }
  return result.stdout.trim();
}

async function exists(filename) {
  try {
    await access(filename);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function verifyArchive(archive) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(archive)) {
    hash.update(chunk);
  }
  if (hash.digest('hex') !== sha256) {
    throw new Error(`libgit2 ${version} source checksum mismatch. Remove ${archive} and retry.`);
  }
}

async function prepareSource() {
  const archive = path.join(buildRoot, `libgit2-${version}.tar.gz`);
  if (!(await exists(archive))) {
    const response = await fetch(
      `https://github.com/libgit2/libgit2/archive/refs/tags/v${version}.tar.gz`,
      { signal: AbortSignal.timeout(120_000) },
    );
    if (!response.ok || !response.body) {
      throw new Error(`Could not download libgit2 ${version}: HTTP ${response.status}`);
    }
    const temporary = `${archive}.partial`;
    try {
      await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary));
      await verifyArchive(temporary);
      await rename(temporary, archive);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  await verifyArchive(archive);
  const source = path.join(buildRoot, `libgit2-${version}`);
  if (!(await exists(source))) {
    run('tar', ['-xzf', archive, '-C', buildRoot]);
  }
  return source;
}

async function buildSlice(source, sdk) {
  const output = path.join(buildRoot, sdk);
  const install = path.join(output, 'install');
  const sdkPath = run('xcrun', ['--sdk', sdk, '--show-sdk-path']);
  run(cmake, [
    '-S',
    source,
    '-B',
    output,
    '-DCMAKE_SYSTEM_NAME=iOS',
    `-DCMAKE_OSX_SYSROOT=${sdkPath}`,
    `-DCMAKE_OSX_ARCHITECTURES=${sdk === 'iphonesimulator' ? 'arm64;x86_64' : 'arm64'}`,
    `-DCMAKE_OSX_DEPLOYMENT_TARGET=${deploymentTarget}`,
    '-DCMAKE_BUILD_TYPE=Release',
    `-DCMAKE_INSTALL_PREFIX=${install}`,
    '-DBUILD_SHARED_LIBS=OFF',
    '-DBUILD_TESTS=OFF',
    '-DBUILD_CLI=OFF',
    '-DUSE_SSH=OFF',
    '-DUSE_GSSAPI=OFF',
    '-DUSE_HTTPS=SecureTransport',
    '-DREGEX_BACKEND=builtin',
  ]);
  run(cmake, ['--build', output, '--parallel', String(Math.min(os.availableParallelism(), 4))]);
  run(cmake, ['--install', output]);
  await copyFile(
    path.join(moduleRoot, 'ios', 'git.modulemap'),
    path.join(install, 'include', 'module.modulemap'),
  );
  return [
    '-library',
    path.join(install, 'lib', 'libgit2.a'),
    '-headers',
    path.join(install, 'include'),
  ];
}

async function main() {
  if (process.platform !== 'darwin') {
    throw new Error('The on-device iOS Git library must be built on macOS with Xcode and CMake.');
  }
  await mkdir(buildRoot, { recursive: true });
  const source = await prepareSource();
  const llama = path.resolve(moduleRoot, '../../node_modules/llama.rn');
  const notices = [
    ['libgit2 1.9.7 (including bundled dependency notices)', path.join(source, 'COPYING')],
    ['libgit2 contributors', path.join(source, 'AUTHORS')],
    ['llama.rn 0.13.0-rc.8', path.join(llama, 'LICENSE')],
    ['llama.cpp / ggml', path.join(llama, 'vendor/llama.cpp/LICENSE')],
  ];
  const sections = await Promise.all(
    notices.map(async ([name, file]) => `${name}\n\n${await readFile(file, 'utf8')}`),
  );
  await writeFile(
    path.join(buildRoot, 'THIRD_PARTY_NOTICES.txt'),
    sections.join('\n\n--------------------\n\n'),
  );
  if ((await exists(marker)) && (await exists(framework))) {
    if ((await readFile(marker, 'utf8')) === configuration) {
      console.log(`On-device Git ${version} is already built.`);
      return;
    }
  }
  run(cmake, ['--version']);
  const device = await buildSlice(source, 'iphoneos');
  const simulator = await buildSlice(source, 'iphonesimulator');
  const staged = path.join(buildRoot, 'staged.xcframework');
  await rm(staged, { recursive: true, force: true });
  run('xcodebuild', ['-create-xcframework', ...device, ...simulator, '-output', staged]);
  await rm(framework, { recursive: true, force: true });
  await rename(staged, framework);
  await writeFile(marker, configuration);
  console.log(`Built on-device Git ${version} for iOS and arm64/x86_64 simulator (HTTPS, no SSH).`);
}

await main();
