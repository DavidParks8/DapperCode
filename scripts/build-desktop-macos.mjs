#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const rootDir = path.resolve(import.meta.dirname, '..');
const desktopDir = path.join(rootDir, 'apps/desktop');
const distDir = path.join(desktopDir, 'dist');
const appDir = path.join(distDir, 'DapperCode.app');
const contentsDir = path.join(appDir, 'Contents');
const macosDir = path.join(contentsDir, 'MacOS');
const resourcesDir = path.join(contentsDir, 'Resources');
const binDir = path.join(resourcesDir, 'bin');

function run(command, args, options = {}) {
  execFileSync(command, args, { cwd: rootDir, stdio: 'inherit', ...options });
}

function copyExecutable(source, destination) {
  if (!existsSync(source)) throw new Error(`Missing executable: ${source}`);
  copyFileSync(source, destination);
  chmodSync(destination, 0o755);
}

function packageVersion() {
  const manifest = readFileSync(path.join(desktopDir, 'Cargo.toml'), 'utf8');
  const version = manifest.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  if (!version) throw new Error('Could not read desktop version');
  return version;
}

function escapePlist(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function makeIcon() {
  const source = path.join(rootDir, 'apps/mobile/assets/brand/app-icon.png');
  const iconset = path.join(distDir, 'DapperCode.iconset');
  rmSync(iconset, { recursive: true, force: true });
  mkdirSync(iconset, { recursive: true });
  for (const [name, pixels] of [
    ['icon_16x16.png', 16],
    ['icon_16x16@2x.png', 32],
    ['icon_32x32.png', 32],
    ['icon_32x32@2x.png', 64],
    ['icon_128x128.png', 128],
    ['icon_128x128@2x.png', 256],
    ['icon_256x256.png', 256],
    ['icon_256x256@2x.png', 512],
    ['icon_512x512.png', 512],
    ['icon_512x512@2x.png', 1024],
  ]) {
    run('sips', ['-z', String(pixels), String(pixels), source, '--out', path.join(iconset, name)], {
      stdio: 'ignore',
    });
  }
  run('iconutil', ['-c', 'icns', iconset, '-o', path.join(resourcesDir, 'DapperCode.icns')]);
  rmSync(iconset, { recursive: true, force: true });
}

function makeMenuBarIcon() {
  const source = path.join(rootDir, 'apps/mobile/assets/brand/mark.png');
  const cropped = path.join(distDir, 'menu-bar-mark.png');
  run('sips', ['-c', '168', '168', source, '--out', cropped], { stdio: 'ignore' });
  for (const [name, pixels] of [
    ['MenuBarIcon.png', 18],
    ['MenuBarIcon@2x.png', 36],
  ]) {
    run(
      'sips',
      ['-z', String(pixels), String(pixels), cropped, '--out', path.join(resourcesDir, name)],
      {
        stdio: 'ignore',
      },
    );
  }
  rmSync(cropped, { force: true });
}

function walk(directory) {
  const paths = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...walk(fullPath));
    else paths.push(fullPath);
  }
  return paths;
}

function assertRustNativeBundle() {
  const forbidden = walk(appDir).filter((file) => {
    const relative = path.relative(appDir, file).toLowerCase();
    return (
      relative.endsWith('.js') ||
      relative.endsWith('package.json') ||
      relative.endsWith('package-lock.json') ||
      relative.includes('node_modules') ||
      path.basename(relative) === 'node' ||
      path.basename(relative) === 'npm' ||
      path.basename(relative) === 'npx' ||
      relative.includes('slint')
    );
  });
  if (forbidden.length > 0) {
    throw new Error(
      `macOS bundle contains forbidden npm/Slint runtime files:\n${forbidden.join('\n')}`,
    );
  }
  const required = [
    path.join(macosDir, 'DapperCode'),
    path.join(binDir, 'dappercode'),
    path.join(binDir, 'dappercode-bridge'),
    path.join(resourcesDir, 'MenuBarIcon.png'),
    path.join(resourcesDir, 'MenuBarIcon@2x.png'),
  ];
  for (const file of required) {
    if (!existsSync(file) || !statSync(file).isFile())
      throw new Error(`Missing bundled executable: ${file}`);
  }
}

if (process.platform !== 'darwin') throw new Error('The macOS app must be built on macOS');
if (!['arm64', 'x64'].includes(process.arch))
  throw new Error(`Unsupported architecture: ${process.arch}`);

run('cargo', [
  'build',
  '--locked',
  '--release',
  '--manifest-path',
  'services/rust-bridge/Cargo.toml',
]);
run('cargo', ['build', '--locked', '--release', '--manifest-path', 'apps/desktop/Cargo.toml']);

rmSync(distDir, { recursive: true, force: true });
mkdirSync(macosDir, { recursive: true });
mkdirSync(binDir, { recursive: true });

const rustOperator = path.join(desktopDir, 'target/release/dappercode');
const rustBridge = path.join(rootDir, 'services/rust-bridge/target/release/dappercode-bridge');
const nativeExecutable = path.join(macosDir, 'DapperCode');
run('xcrun', [
  'swiftc',
  '-parse-as-library',
  '-target',
  `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos13.0`,
  'apps/desktop/macos/AppTermination.swift',
  'apps/desktop/macos/BridgeStatusObserver.swift',
  'apps/desktop/macos/DapperCodeApp.swift',
  '-o',
  nativeExecutable,
  '-framework',
  'SwiftUI',
  '-framework',
  'AppKit',
  '-framework',
  'CoreImage',
  '-framework',
  'ServiceManagement',
]);
copyExecutable(rustOperator, path.join(binDir, 'dappercode'));
copyExecutable(rustBridge, path.join(binDir, 'dappercode-bridge'));
copyFileSync(path.join(rootDir, 'LICENSE'), path.join(resourcesDir, 'LICENSE'));

const noticesPath = path.join(resourcesDir, 'THIRD_PARTY_NOTICES.txt');
run('node', ['scripts/generate-desktop-notices.mjs', '--output', noticesPath]);

makeIcon();
makeMenuBarIcon();
const version = packageVersion();
const bundleVersion = version.split('-', 1)[0];
writeFileSync(
  path.join(contentsDir, 'Info.plist'),
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleDisplayName</key><string>DapperCode</string>
  <key>CFBundleExecutable</key><string>DapperCode</string>
  <key>CFBundleIconFile</key><string>DapperCode</string>
  <key>CFBundleIdentifier</key><string>dev.dappercode.desktop</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>DapperCode</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${escapePlist(version)}</string>
  <key>CFBundleVersion</key><string>${escapePlist(bundleVersion)}</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSMultipleInstancesProhibited</key><true/>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>\n`,
);
writeFileSync(path.join(contentsDir, 'PkgInfo'), 'APPL????');
assertRustNativeBundle();
run('plutil', ['-lint', path.join(contentsDir, 'Info.plist')]);
run('codesign', ['--force', '--deep', '--sign', '-', appDir]);
run('codesign', ['--verify', '--deep', '--strict', appDir]);

const zipPath = path.join(distDir, `DapperCode-${version}-${os.arch()}.zip`);
run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appDir, zipPath]);
console.log(`macOS app: ${appDir}`);
console.log(`archive: ${zipPath}`);
