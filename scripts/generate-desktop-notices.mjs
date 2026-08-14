#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export function parseArgs(argv) {
  const outputIndex = argv.indexOf('--output');
  if (outputIndex < 0 || !argv[outputIndex + 1]) {
    throw new Error(
      'Usage: generate-desktop-notices.mjs --output <path> [--platform macos|windows] [--cargo-target <triple>] [--nuget-assets <path>]',
    );
  }
  const platformIndex = argv.indexOf('--platform');
  const platform = platformIndex < 0 ? 'macos' : argv[platformIndex + 1];
  if (!['macos', 'windows'].includes(platform)) {
    throw new Error('--platform must be macos or windows');
  }
  const cargoTargetIndex = argv.indexOf('--cargo-target');
  const cargoTargetValue = cargoTargetIndex < 0 ? undefined : argv[cargoTargetIndex + 1];
  const cargoTarget =
    !cargoTargetValue || cargoTargetValue.startsWith('--') ? undefined : cargoTargetValue;
  const nugetAssetsIndex = argv.indexOf('--nuget-assets');
  const nugetAssets =
    nugetAssetsIndex < 0 || !argv[nugetAssetsIndex + 1]
      ? undefined
      : path.resolve(argv[nugetAssetsIndex + 1]);
  if (platform === 'windows' && !cargoTarget) {
    throw new Error('--cargo-target is required for Windows notices');
  }
  if (platform === 'windows' && !nugetAssets) {
    throw new Error('--nuget-assets is required for Windows notices');
  }
  return {
    cargoTarget,
    nugetAssets,
    output: path.resolve(argv[outputIndex + 1]),
    platform,
  };
}

function licenseFiles(packageRoot) {
  const files = [];
  for (const name of readdirSync(packageRoot)) {
    const fullPath = path.join(packageRoot, name);
    if (
      statSync(fullPath).isFile() &&
      /^(license|licence|copying|notice|copyright)([-_. ]|$)|^third[-_. ]party[-_. ]notices?([-_. ]|$)/i.test(
        name,
      )
    ) {
      files.push(fullPath);
    }
  }
  const licenses = path.join(packageRoot, 'LICENSES');
  if (existsSync(licenses)) {
    for (const name of readdirSync(licenses)) {
      const fullPath = path.join(licenses, name);
      if (statSync(fullPath).isFile()) files.push(fullPath);
    }
  }
  return files.sort();
}

function isLicenseFile(packageRoot, file) {
  const relative = path.relative(packageRoot, file);
  return (
    /^(license|licence|copying)([-_. ]|$)/i.test(path.basename(file)) ||
    relative.split(path.sep)[0]?.toLowerCase() === 'licenses'
  );
}

export function collectCargoPackages(rootDir, manifestPath, cargoTarget, execute = execFileSync) {
  const filterPlatform =
    cargoTarget ?? execute('rustc', ['-vV'], { encoding: 'utf8' }).match(/^host: (.+)$/m)?.[1];
  if (!filterPlatform) throw new Error('Could not determine Rust host target');
  const metadata = JSON.parse(
    execute(
      'cargo',
      [
        'metadata',
        '--locked',
        '--format-version',
        '1',
        '--filter-platform',
        filterPlatform,
        '--manifest-path',
        path.join(rootDir, manifestPath),
      ],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    ),
  );
  const packageById = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
  const nodeById = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const pending = [metadata.resolve.root];
  const visited = new Set();
  while (pending.length > 0) {
    const id = pending.pop();
    if (!id || visited.has(id)) continue;
    visited.add(id);
    for (const dependency of nodeById.get(id)?.deps ?? []) pending.push(dependency.pkg);
  }
  return [...visited]
    .map((id) => packageById.get(id))
    .filter((pkg) => pkg?.source)
    .map((pkg) => ({
      ecosystem: 'Cargo',
      name: pkg.name,
      version: pkg.version,
      license: pkg.license || 'See included license text',
      root: path.dirname(pkg.manifest_path),
    }));
}

function decodeXml(value) {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function nugetLicense(packageRoot) {
  const nuspec = readdirSync(packageRoot).find((name) => name.toLowerCase().endsWith('.nuspec'));
  if (!nuspec) return {};
  const metadata = readFileSync(path.join(packageRoot, nuspec), 'utf8');
  const match = metadata.match(/<license\b([^>]*)>([^<]+)<\/license>/i);
  if (!match) return {};
  const value = decodeXml(match[2].trim());
  const type = match[1].match(/\btype\s*=\s*["']([^"']+)["']/i)?.[1].toLowerCase();
  if (type === 'expression') return { expression: value };
  if (type !== 'file') return {};
  const licenseFile = path.resolve(packageRoot, value.replaceAll('\\', path.sep));
  const withinPackage = licenseFile.startsWith(`${path.resolve(packageRoot)}${path.sep}`);
  if (!withinPackage || !existsSync(licenseFile) || !statSync(licenseFile).isFile()) {
    throw new Error(`NuGet package references a missing or invalid license file: ${value}`);
  }
  return {
    expression: 'See included license text',
    licenseFile,
  };
}

function splitPackageIdentity(identity) {
  const separator = identity.lastIndexOf('/');
  if (separator <= 0 || separator === identity.length - 1) {
    throw new Error(`Invalid NuGet package identity: ${identity}`);
  }
  return {
    name: identity.slice(0, separator),
    version: identity.slice(separator + 1),
  };
}

function normalizedPackageIdentity(name, version) {
  return `${name.toLowerCase()}/${version.toLowerCase()}`;
}

function exactDownloadVersion(dependency) {
  const requested = String(dependency.version ?? '').trim();
  const singleVersion = requested.match(/^\[\s*([^,\]]+)\s*\]$/);
  if (singleVersion) return singleVersion[1].trim();
  const range = requested.match(/^\[\s*([^,\]]+)\s*,\s*([^\]]+)\s*\]$/);
  if (range && range[1].trim() === range[2].trim()) return range[1].trim();
  if (requested && !/[\[\]()*,]/.test(requested)) return requested;
  throw new Error(
    `NuGet download dependency ${dependency.name} does not have an exact resolved version: ${requested}`,
  );
}

function packageRoot(packageFolders, name, version, libraryPath) {
  const relativeRoots = [
    ...(libraryPath ? [libraryPath] : []),
    path.join(name.toLowerCase(), version.toLowerCase()),
  ];
  for (const folder of packageFolders) {
    for (const relativeRoot of relativeRoots) {
      const candidate = path.resolve(folder, relativeRoot);
      if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate;
    }
  }
  throw new Error(`Could not locate restored NuGet package ${name}/${version}`);
}

function hasFilesBelow(directory) {
  if (!existsSync(directory) || !statSync(directory).isDirectory()) return false;
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (entry.isFile() && entry.name !== '_._') {
        return true;
      }
    }
  }
  return false;
}

function hasDownloadedRuntimePayload(root) {
  return ['runtimes', 'runtime', 'native'].some((directory) =>
    hasFilesBelow(path.join(root, directory)),
  );
}

const shippedAssetKinds = ['runtime', 'native', 'runtimeTargets', 'resource'];
const buildFilePattern = /^(?:build|buildTransitive)\/.+\.(?:props|targets)$/i;
const msbuildThisFileDirectory = /\$\(MSBuildThisFileDirectory\)/gi;
const msbuildValue = /\$\([^)]+\)|%\([^)]+\)/g;
const pathWildcard = '__DAPPERCODE_PATH_WILDCARD__';
const recursivePathWildcard = '__DAPPERCODE_RECURSIVE_PATH_WILDCARD__';

function hasShippedTargetAssets(targetPackage) {
  return shippedAssetKinds.some((kind) =>
    Object.keys(targetPackage[kind] ?? {}).some(
      (asset) => path.posix.basename(asset.replaceAll('\\', '/')) !== '_._',
    ),
  );
}

function packageContentPaths(root) {
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (entry.isFile()) {
        files.push(path.relative(root, entryPath).replaceAll(path.sep, '/'));
      }
    }
  }
  return files;
}

function isDeployablePackageContent(contentPath) {
  const normalized = contentPath.replaceAll('\\', '/');
  const segments = normalized.split('/');
  const root = segments[0]?.toLowerCase();
  const isPayloadRoot =
    /^(?:runtime|runtimes(?:-[^/]+)?|native|content|contentfiles)$/.test(root) ||
    (root === 'tools' && segments[1]?.toLowerCase() === 'msix');
  return (
    isPayloadRoot && /\.(?:appx|dll|exe|json|msix|mui|png|pri|winmd|xaml|xbf)$/i.test(normalized)
  );
}

function normalizedBuildReference(buildFile, reference) {
  const buildDirectory = path.posix.dirname(buildFile);
  let replaced = reference.replaceAll('\\', '/');
  let replacedDirectory = false;
  replaced = replaced.replace(msbuildThisFileDirectory, () => {
    replacedDirectory = true;
    return `${buildDirectory}/`;
  });
  if (!replacedDirectory) return undefined;
  replaced = replaced
    .replaceAll('**', recursivePathWildcard)
    .replaceAll('*', pathWildcard)
    .replace(msbuildValue, pathWildcard);
  const normalizedPath = path.posix.normalize(replaced);
  const normalized = normalizedPath === './' ? '.' : normalizedPath.replace(/\/$/, '') || '.';
  if (path.posix.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../')) {
    return undefined;
  }
  return normalized;
}

function buildReferencePattern(buildFile, reference) {
  const normalized = normalizedBuildReference(buildFile, reference);
  if (!normalized) return undefined;
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `^${escaped.replaceAll(recursivePathWildcard, '.*').replaceAll(pathWildcard, '[^/]+')}$`,
    'i',
  );
}

export function hasBuildInjectedPayload(root, targetPackage, libraryFiles = []) {
  const declaredBuildAssets = [
    ...Object.keys(targetPackage.build ?? {}),
    ...Object.keys(targetPackage.buildTransitive ?? {}),
  ].filter((asset) => path.posix.basename(asset.replaceAll('\\', '/')) !== '_._');
  if (declaredBuildAssets.length === 0) return false;

  for (const asset of declaredBuildAssets) {
    const assetPath = path.join(root, ...asset.replaceAll('\\', '/').split('/'));
    if (!existsSync(assetPath) || !statSync(assetPath).isFile()) {
      throw new Error(`NuGet package build asset is missing: ${asset}`);
    }
  }

  const contentPaths = (libraryFiles.length > 0 ? libraryFiles : packageContentPaths(root)).map(
    (file) => file.replaceAll('\\', '/'),
  );
  const deployableContent = contentPaths.filter(isDeployablePackageContent);
  if (deployableContent.length === 0) return false;

  const buildFiles = contentPaths.filter((file) => buildFilePattern.test(file));
  for (const buildFile of buildFiles) {
    const buildFilePath = path.join(root, ...buildFile.split('/'));
    if (!existsSync(buildFilePath) || !statSync(buildFilePath).isFile()) {
      throw new Error(`NuGet package build file is missing: ${buildFile}`);
    }
    const contents = readFileSync(buildFilePath, 'utf8');
    const includes = contents.matchAll(
      /<([A-Za-z_][\w:.-]*)\b([^<>]*\bInclude\s*=\s*["']([^"']+)["'][^<>]*)>/gi,
    );
    for (const [, itemName, attributes, include] of includes) {
      const references = include.split(';').map((reference) => reference.trim());
      if (/ComponentPackages/i.test(itemName)) {
        const registersPackageRoot = references.some(
          (reference) => normalizedBuildReference(buildFile, reference) === '.',
        );
        if (registersPackageRoot) return true;
      }
      if (
        !/(?:appx|content|copylocal|deployment|native|runtime)/i.test(`${itemName} ${attributes}`)
      ) {
        continue;
      }
      for (const reference of references) {
        const referencePattern = buildReferencePattern(buildFile, reference);
        if (
          referencePattern &&
          deployableContent.some((contentPath) => referencePattern.test(contentPath))
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

function synthesizedMitLicense(name, version) {
  return `Package metadata attribution: ${name} ${version} declares the MIT license in its NuGet package metadata. The package does not bundle a license file, so the standard MIT license text is reproduced below.

MIT License

Copyright (c) the authors and contributors of ${name}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;
}

function packageWithLicense({ name, root, version }) {
  const metadata = nugetLicense(root);
  const includedFiles = [
    ...licenseFiles(root),
    ...(metadata.licenseFile ? [metadata.licenseFile] : []),
  ];
  const hasIncludedLicense = includedFiles.some(
    (file) =>
      (file === metadata.licenseFile || isLicenseFile(root, file)) &&
      readFileSync(file, 'utf8').trim().length > 0,
  );
  const isMit = metadata.expression?.trim().toUpperCase() === 'MIT';
  if (!hasIncludedLicense && !isMit) {
    throw new Error(
      `Shipped NuGet package ${name} ${version} has neither a bundled license file nor a supported license expression`,
    );
  }
  return {
    ecosystem: 'NuGet',
    name,
    version,
    license: metadata.expression || 'See included license text',
    licenseFile: metadata.licenseFile,
    licenseText: hasIncludedLicense ? undefined : synthesizedMitLicense(name, version),
    root,
  };
}

export function collectNuGetPackages(assetsPath) {
  const assets = JSON.parse(readFileSync(assetsPath, 'utf8'));
  const packageFolders = Object.keys(assets.packageFolders ?? {}).map((folder) =>
    path.isAbsolute(folder) ? folder : path.resolve(path.dirname(assetsPath), folder),
  );
  if (packageFolders.length === 0) {
    throw new Error(`NuGet assets file has no package folders: ${assetsPath}`);
  }
  const libraries = new Map(
    Object.entries(assets.libraries ?? {}).map(([identity, library]) => [
      identity.toLowerCase(),
      { identity, library },
    ]),
  );
  const targets = Object.entries(assets.targets ?? {});
  const ridTargets = targets.filter(([target]) => target.includes('/'));
  const shippedPackages = new Map();

  for (const [, target] of ridTargets.length > 0 ? ridTargets : targets) {
    for (const [identity, targetPackage] of Object.entries(target)) {
      const libraryEntry = libraries.get(identity.toLowerCase());
      if ((libraryEntry?.library.type ?? targetPackage.type) !== 'package') continue;
      const { name, version } = splitPackageIdentity(identity);
      const shippedTargetAssets = hasShippedTargetAssets(targetPackage);
      let root;
      if (!shippedTargetAssets) {
        const hasBuildAssets =
          Object.keys(targetPackage.build ?? {}).length > 0 ||
          Object.keys(targetPackage.buildTransitive ?? {}).length > 0;
        if (!hasBuildAssets) continue;
        root = packageRoot(packageFolders, name, version, libraryEntry?.library.path);
        if (!hasBuildInjectedPayload(root, targetPackage, libraryEntry?.library.files)) {
          continue;
        }
      }
      shippedPackages.set(normalizedPackageIdentity(name, version), {
        libraryPath: libraryEntry?.library.path,
        name,
        root,
        version,
      });
    }
  }

  for (const framework of Object.values(assets.project?.frameworks ?? {})) {
    for (const dependency of framework.downloadDependencies ?? []) {
      const name = dependency.name;
      const version = exactDownloadVersion(dependency);
      const root = packageRoot(packageFolders, name, version);
      if (!hasDownloadedRuntimePayload(root)) continue;
      shippedPackages.set(normalizedPackageIdentity(name, version), { name, root, version });
    }
  }

  return [...shippedPackages.values()]
    .map(({ libraryPath, name, root, version }) =>
      packageWithLicense({
        name,
        root: root ?? packageRoot(packageFolders, name, version, libraryPath),
        version,
      }),
    )
    .sort(
      (left, right) =>
        left.name.localeCompare(right.name) || left.version.localeCompare(right.version),
    );
}

function collectLicenseGroups(packages) {
  const groups = new Map();
  const normalizeLicenseText = (text) =>
    text
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .join('\n')
      .trim();
  const standardLicenseTexts = new Map();
  for (const pkg of packages) {
    for (const file of licenseFiles(pkg.root)) {
      const name = path.basename(file).toLowerCase();
      const text = normalizeLicenseText(readFileSync(file, 'utf8'));
      if (!text) continue;
      if (/license[-_. ]?mit/.test(name)) standardLicenseTexts.set('MIT', text);
      if (/license[-_. ]?apache/.test(name)) standardLicenseTexts.set('Apache-2.0', text);
      if (pkg.license === 'MIT' && isLicenseFile(pkg.root, file)) {
        standardLicenseTexts.set('MIT', text);
      }
      if (pkg.license === 'Apache-2.0' && isLicenseFile(pkg.root, file)) {
        standardLicenseTexts.set('Apache-2.0', text);
      }
    }
  }
  for (const pkg of packages) {
    const label = `${pkg.name} ${pkg.version}`;
    let suppliedTerms = false;
    const files = [...licenseFiles(pkg.root), ...(pkg.licenseFile ? [pkg.licenseFile] : [])];
    for (const file of [...new Set(files)].sort()) {
      const text = normalizeLicenseText(readFileSync(file, 'utf8'));
      if (!text) continue;
      suppliedTerms = true;
      const digest = createHash('sha256').update(text).digest('hex');
      const group = groups.get(digest) ?? { packages: [], text };
      group.packages.push(label);
      groups.set(digest, group);
    }
    if (pkg.licenseText) {
      const text = normalizeLicenseText(pkg.licenseText);
      suppliedTerms = true;
      const digest = createHash('sha256').update(text).digest('hex');
      const group = groups.get(digest) ?? { packages: [], text };
      group.packages.push(label);
      groups.set(digest, group);
    }
    if (!suppliedTerms) {
      const expression = pkg.license
        ?.split(/\s+OR\s+/i)
        .map((value) => value.replace(/[()]/g, '').trim())
        .find((value) => standardLicenseTexts.has(value));
      const standardText = expression && standardLicenseTexts.get(expression);
      if (!standardText) {
        throw new Error(`${label} does not provide distributable license terms`);
      }
      const text =
        `Package metadata attribution: ${label} declares ${pkg.license}. ` +
        `The package does not bundle a license file, so the ${expression} text from another ` +
        `shipped dependency is reproduced below.\n\n${standardText}`;
      const digest = createHash('sha256').update(text).digest('hex');
      const group = groups.get(digest) ?? { packages: [], text };
      group.packages.push(label);
      groups.set(digest, group);
    }
  }
  return groups;
}

function uniquePackages(packages) {
  return packages
    .filter(
      (pkg, index, all) =>
        all.findIndex((candidate) => {
          const normalize = (value) => (pkg.ecosystem === 'NuGet' ? value.toLowerCase() : value);
          return (
            candidate.ecosystem === pkg.ecosystem &&
            normalize(candidate.name) === normalize(pkg.name) &&
            normalize(candidate.version) === normalize(pkg.version)
          );
        }) === index,
    )
    .sort(
      (left, right) =>
        left.name.localeCompare(right.name) || left.version.localeCompare(right.version),
    );
}

export function renderNotices({ cargoPackages, nugetPackages = [], platform }) {
  const packages = uniquePackages(
    platform === 'macos' ? cargoPackages : [...cargoPackages, ...nugetPackages],
  );
  const groups = collectLicenseGroups(packages);
  const lines = ['DapperCode Desktop Third-Party Notices', ''];

  if (platform === 'macos') {
    lines.push(
      'The macOS application uses operating-system SwiftUI/AppKit frameworks and bundles only Rust executables.',
      '',
      'Bundled Rust packages:',
      '',
      ...packages.map((pkg) => `- ${pkg.name} ${pkg.version} (${pkg.license})`),
    );
  } else {
    lines.push(
      'The Windows application uses native WinUI 3 and the Windows App SDK, and packages a managed .NET shell with native Rust executables.',
      'Managed dependency attribution is derived from the shipped per-RID NuGet assets, imported build targets, and self-contained runtime packs used by the Windows package.',
      '',
      'Bundled Rust packages:',
      '',
      ...packages
        .filter((pkg) => pkg.ecosystem === 'Cargo')
        .map((pkg) => `- ${pkg.name} ${pkg.version} (${pkg.license})`),
      '',
      'Bundled NuGet packages:',
      '',
      ...packages
        .filter((pkg) => pkg.ecosystem === 'NuGet')
        .map((pkg) => `- ${pkg.name} ${pkg.version} (${pkg.license})`),
    );
  }

  lines.push('', 'License Texts', '=============');
  for (const group of [...groups.values()].sort((left, right) =>
    left.packages[0].localeCompare(right.packages[0]),
  )) {
    lines.push('', '------------------------------------------------------------');
    lines.push(`Applies to: ${[...new Set(group.packages)].sort().join(', ')}`);
    lines.push('------------------------------------------------------------', '', group.text);
  }
  return `${lines.join('\n')}\n`;
}

function generate(rootDir, { cargoTarget, nugetAssets, platform }) {
  const cargoPackages = [
    ...collectCargoPackages(rootDir, 'apps/desktop/Cargo.toml', cargoTarget),
    ...collectCargoPackages(rootDir, 'services/rust-bridge/Cargo.toml', cargoTarget),
  ];
  const nugetPackages = nugetAssets ? collectNuGetPackages(nugetAssets) : [];
  return renderNotices({ cargoPackages, nugetPackages, platform });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { cargoTarget, nugetAssets, output, platform } = parseArgs(process.argv.slice(2));
  const rootDir = path.resolve(import.meta.dirname, '..');
  writeFileSync(output, generate(rootDir, { cargoTarget, nugetAssets, platform }));
  console.log(output);
}
