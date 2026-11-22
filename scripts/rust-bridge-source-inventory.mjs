import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const walkAllRustFiles = (directory) =>
  readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return walkAllRustFiles(entryPath);
      return entry.name.endsWith('.rs') ? [entryPath] : [];
    });

const isIdentByte = (ch) => ch !== undefined && /[A-Za-z0-9_]/.test(ch);

const matchRawStringOpen = (input, index) => {
  if (index > 0 && isIdentByte(input[index - 1])) return null;
  let rPos = -1;
  if (input[index] === 'r') rPos = index;
  else if ((input[index] === 'b' || input[index] === 'c') && input[index + 1] === 'r') {
    rPos = index + 1;
  } else {
    return null;
  }
  let hashes = 0;
  while (input[rPos + 1 + hashes] === '#') hashes += 1;
  if (input[rPos + 1 + hashes] === '"') {
    return { afterOpenQuote: rPos + 1 + hashes + 1, hashes };
  }
  return null;
};

const stripRustComments = (input) => {
  let out = '';
  let index = 0;
  let blockDepth = 0;
  let inString = false;
  let rawHashes = null;

  while (index < input.length) {
    if (blockDepth > 0) {
      if (input[index] === '/' && input[index + 1] === '*') {
        blockDepth += 1;
        index += 2;
      } else if (input[index] === '*' && input[index + 1] === '/') {
        blockDepth -= 1;
        out += ' ';
        index += 2;
      } else {
        if (input[index] === '\n') out += '\n';
        index += 1;
      }
      continue;
    }
    if (rawHashes !== null) {
      const ch = input[index];
      out += ch;
      index += 1;
      if (ch === '"') {
        let matched = 0;
        while (matched < rawHashes && input[index + matched] === '#') matched += 1;
        if (matched === rawHashes) {
          out += '#'.repeat(matched);
          index += matched;
          rawHashes = null;
        }
      }
      continue;
    }
    if (inString) {
      if (input[index] === '\\' && index + 1 < input.length) {
        out += input[index] + input[index + 1];
        index += 2;
        continue;
      }
      const ch = input[index];
      out += ch;
      if (ch === '"') inString = false;
      index += 1;
      continue;
    }
    if (input[index] === '/' && input[index + 1] === '/') {
      while (index < input.length && input[index] !== '\n') index += 1;
      continue;
    }
    if (input[index] === '/' && input[index + 1] === '*') {
      blockDepth = 1;
      index += 2;
      continue;
    }
    const rawOpen = matchRawStringOpen(input, index);
    if (rawOpen !== null) {
      out += input.slice(index, rawOpen.afterOpenQuote);
      index = rawOpen.afterOpenQuote;
      rawHashes = rawOpen.hashes;
      continue;
    }
    if (input[index] === "'") {
      if (input[index + 1] === '\\') {
        let cursor = index + 2;
        if (cursor < input.length && input[cursor] !== '\n') cursor += 1;
        while (cursor < input.length && input[cursor] !== "'" && input[cursor] !== '\n') {
          cursor += 1;
        }
        if (input[cursor] === "'") {
          out += input.slice(index, cursor + 1);
          index = cursor + 1;
          continue;
        }
      } else if (index + 2 < input.length && input[index + 2] === "'") {
        out += input.slice(index, index + 3);
        index += 3;
        continue;
      }
    }
    const ch = input[index];
    out += ch;
    if (ch === '"') inString = true;
    index += 1;
  }
  return out;
};

const advanceBraceState = (line, state) => {
  for (let index = 0; index < line.length; index += 1) {
    const ch = line[index];
    if (state.rawHashes !== null) {
      if (ch === '"') {
        let matched = 0;
        while (matched < state.rawHashes && line[index + 1 + matched] === '#') matched += 1;
        if (matched === state.rawHashes) {
          index += matched;
          state.rawHashes = null;
        }
      }
      continue;
    }
    if (state.inString) {
      if (state.escaped) state.escaped = false;
      else if (ch === '\\') state.escaped = true;
      else if (ch === '"') state.inString = false;
      continue;
    }
    if (state.inChar) {
      if (state.escaped) state.escaped = false;
      else if (ch === '\\') state.escaped = true;
      else if (ch === "'") state.inChar = false;
      continue;
    }
    const rawOpen = matchRawStringOpen(line, index);
    if (rawOpen !== null) {
      state.rawHashes = rawOpen.hashes;
      index = rawOpen.afterOpenQuote - 1;
      continue;
    }
    if (ch === '"') state.inString = true;
    else if (ch === "'" && (line[index + 1] === '\\' || line[index + 2] === "'")) {
      state.inChar = true;
    } else if (ch === '{') state.braceDepth += 1;
    else if (ch === '}') state.braceDepth = Math.max(0, state.braceDepth - 1);
  }
};

const splitTopLevelArgs = (input) => {
  const parts = [];
  let depth = 0;
  let start = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < input.length; index += 1) {
    const ch = input[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '(') depth += 1;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) {
      parts.push(input.slice(start, index).trim());
      start = index + 1;
    }
  }
  const tail = input.slice(start).trim();
  if (tail.length > 0) parts.push(tail);
  return parts;
};

const cfgExprImpliesTest = (expr) => {
  const trimmed = expr.trim();
  if (trimmed === 'test') return true;
  if (trimmed.startsWith('all(') && trimmed.endsWith(')')) {
    return splitTopLevelArgs(trimmed.slice(4, -1)).some(cfgExprImpliesTest);
  }
  if (trimmed.startsWith('any(') && trimmed.endsWith(')')) {
    const args = splitTopLevelArgs(trimmed.slice(4, -1));
    return args.length > 0 && args.every(cfgExprImpliesTest);
  }
  return false;
};

const cfgAttrImpliesTest = (attr) => {
  const trimmed = stripRustComments(attr).trim();
  if (!trimmed.startsWith('#[cfg(') || !trimmed.endsWith(')]')) return false;
  return cfgExprImpliesTest(trimmed.slice(6, -2));
};

const parsePathAttr = (attr) => {
  const match = /^#\[path\s*=\s*"([^"]+)"\]$/.exec(attr.trim());
  return match ? match[1] : null;
};

const resolveModTarget = (sourcePath, modName, explicitPath) => {
  const parent = path.dirname(sourcePath);
  const stem = path.basename(sourcePath, '.rs');
  const isModRoot = stem === 'lib' || stem === 'main' || stem === 'mod';
  if (explicitPath) {
    if (isModRoot) return path.resolve(parent, explicitPath);
    const sibling = path.resolve(parent, explicitPath);
    if (existsSync(sibling)) return sibling;
    return path.resolve(parent, stem, explicitPath);
  }
  const searchDir = isModRoot ? parent : path.join(parent, stem);
  const direct = path.join(searchDir, `${modName}.rs`);
  return existsSync(direct) ? direct : path.join(searchDir, modName, 'mod.rs');
};

const stripTomlComment = (line) => {
  let inDouble = false;
  let inSingle = false;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const ch = line[index];
    if (inDouble) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inDouble = false;
      continue;
    }
    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (ch === '"') inDouble = true;
    else if (ch === "'") inSingle = true;
    else if (ch === '#') return line.slice(0, index);
  }
  return line;
};

export const parseExternalModDeclarations = (sourcePath, source) => {
  const results = [];
  let pendingAttrs = [];
  let currentAttr = null;
  const braceState = {
    braceDepth: 0,
    inString: false,
    inChar: false,
    escaped: false,
    rawHashes: null,
  };

  for (const rawLine of stripRustComments(source).split(/\r?\n/)) {
    const lineWithNewline = `${rawLine}\n`;
    const trimmed = rawLine.trim();
    const insideLiteral = braceState.inString || braceState.rawHashes !== null;
    if (insideLiteral) {
      advanceBraceState(lineWithNewline, braceState);
      continue;
    }
    if (currentAttr !== null) {
      currentAttr += ` ${trimmed}`;
      if (trimmed.endsWith(']')) {
        pendingAttrs.push(currentAttr);
        currentAttr = null;
      }
      advanceBraceState(lineWithNewline, braceState);
      continue;
    }
    if (trimmed === '') continue;
    if (trimmed.startsWith('#[') && !trimmed.startsWith('#![')) {
      if (trimmed.endsWith(']')) pendingAttrs.push(trimmed);
      else currentAttr = trimmed;
      advanceBraceState(lineWithNewline, braceState);
      continue;
    }
    const modMatch = /^(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_][A-Za-z0-9_]*)\s*;$/.exec(trimmed);
    if (modMatch) {
      const modName = modMatch[1];
      const isCfgTest = pendingAttrs.some(cfgAttrImpliesTest);
      const explicitPath = pendingAttrs.map(parsePathAttr).find(Boolean) ?? null;
      results.push({
        modName,
        explicitPath,
        isCfgTest,
        topLevel: braceState.braceDepth === 0,
        target: resolveModTarget(sourcePath, modName, explicitPath),
      });
    }
    pendingAttrs = [];
    advanceBraceState(lineWithNewline, braceState);
  }
  return results;
};

export const parseIncludeTargets = (sourcePath, source) => {
  const parent = path.dirname(sourcePath);
  const cleaned = stripRustComments(source);
  return [...cleaned.matchAll(/\binclude\s*!\s*[(\[{]\s*"([^"]+)"\s*[)\]}]/g)].map((match) =>
    path.resolve(parent, match[1]),
  );
};

export const collectCargoEntryPoints = (sourceRoot) => {
  const roots = new Set();
  for (const file of ['lib.rs', 'main.rs']) {
    const candidate = path.resolve(sourceRoot, file);
    if (existsSync(candidate)) roots.add(candidate);
  }
  const binDir = path.join(sourceRoot, 'bin');
  if (existsSync(binDir)) {
    for (const entry of readdirSync(binDir, { withFileTypes: true })) {
      const entryPath = path.resolve(binDir, entry.name);
      if (entry.isFile() && entry.name.endsWith('.rs')) {
        roots.add(entryPath);
      } else if (entry.isDirectory()) {
        const main = path.resolve(entryPath, 'main.rs');
        if (existsSync(main)) roots.add(main);
      }
    }
  }
  const crateRoot = path.dirname(sourceRoot);
  const manifestPath = path.join(crateRoot, 'Cargo.toml');
  if (existsSync(manifestPath)) {
    let inBinOrLib = false;
    for (const rawLine of readFileSync(manifestPath, 'utf8').split(/\r?\n/)) {
      const trimmed = stripTomlComment(rawLine).trim();
      if (trimmed === '') continue;
      if (trimmed.startsWith('[')) {
        inBinOrLib = trimmed === '[[bin]]' || trimmed === '[lib]';
        continue;
      }
      if (inBinOrLib) {
        const match = /^path\s*=\s*(?:"([^"]+)"|'([^']+)')$/.exec(trimmed);
        if (match) {
          const rel = match[1] ?? match[2];
          const candidate = path.resolve(crateRoot, rel);
          if (existsSync(candidate)) roots.add(candidate);
        }
      }
    }
  }
  return roots;
};

export const collectVerifiedTestOnlyRustFiles = (files, sourceRoot = null) => {
  const known = new Set(files.map((file) => path.resolve(file)));
  const entryPoints = sourceRoot ? collectCargoEntryPoints(sourceRoot) : new Set();
  const prodModEdges = new Map();
  const testModEdges = new Map();
  const includeEdges = new Map();
  const referencedByAnyEdge = new Set();

  for (const file of files) {
    const resolved = path.resolve(file);
    const source = readFileSync(resolved, 'utf8');
    const prodMods = [];
    const testMods = [];
    for (const decl of parseExternalModDeclarations(resolved, source)) {
      if (!known.has(decl.target)) continue;
      referencedByAnyEdge.add(decl.target);
      if (decl.isCfgTest) testMods.push(decl.target);
      else prodMods.push(decl.target);
    }
    if (prodMods.length > 0) prodModEdges.set(resolved, prodMods);
    if (testMods.length > 0) testModEdges.set(resolved, testMods);

    const includes = parseIncludeTargets(resolved, source).filter((target) => known.has(target));
    for (const target of includes) referencedByAnyEdge.add(target);
    if (includes.length > 0) includeEdges.set(resolved, includes);
  }

  const prodReachable = new Set(
    files
      .map((file) => path.resolve(file))
      .filter((resolved) => entryPoints.has(resolved) || !referencedByAnyEdge.has(resolved)),
  );
  const prodQueue = [...prodReachable];
  while (prodQueue.length > 0) {
    const current = prodQueue.pop();
    const nextTargets = [
      ...(prodModEdges.get(current) ?? []),
      ...(includeEdges.get(current) ?? []),
    ];
    for (const target of nextTargets) {
      if (!prodReachable.has(target)) {
        prodReachable.add(target);
        prodQueue.push(target);
      }
    }
  }

  const testReachable = new Set();
  for (const targets of testModEdges.values()) {
    for (const target of targets) {
      if (!prodReachable.has(target)) testReachable.add(target);
    }
  }
  const testQueue = [...testReachable];
  while (testQueue.length > 0) {
    const current = testQueue.pop();
    const nextTargets = [
      ...(prodModEdges.get(current) ?? []),
      ...(testModEdges.get(current) ?? []),
      ...(includeEdges.get(current) ?? []),
    ];
    for (const target of nextTargets) {
      if (!prodReachable.has(target) && !testReachable.has(target)) {
        testReachable.add(target);
        testQueue.push(target);
      }
    }
  }
  return testReachable;
};

const walkRustSources = (directory) => {
  const allFiles = walkAllRustFiles(directory);
  const testOnly = collectVerifiedTestOnlyRustFiles(allFiles, directory);
  return allFiles.filter((file) => !testOnly.has(path.resolve(file)));
};

export const readRustBridgeProductionSources = (root) => {
  const bridgeRoot = path.join(root, 'services/rust-bridge');
  const cratesRoot = path.join(bridgeRoot, 'crates');
  const crateSourceRoots = existsSync(cratesRoot)
    ? readdirSync(cratesRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(cratesRoot, entry.name, 'src'))
        .filter(existsSync)
        .sort()
    : [];
  const sourceRoots = [path.join(bridgeRoot, 'src'), ...crateSourceRoots];
  return new Map(
    sourceRoots
      .flatMap(walkRustSources)
      .map((file) => [path.relative(root, file), readFileSync(file, 'utf8')]),
  );
};

export const findRustFunctionSource = (sources, functionName) => {
  const signature = new RegExp(`(?:pub\\(super\\)\\s+)?(?:async\\s+)?fn\\s+${functionName}\\s*\\(`);
  for (const [file, source] of sources) {
    const match = signature.exec(source);
    if (!match) continue;
    const remainder = source.slice(match.index + match[0].length);
    const nextFunction = /\n\s*(?:pub\(super\)\s+)?(?:async\s+)?fn\s+[A-Za-z0-9_]+\s*\(/.exec(
      remainder,
    );
    return {
      file,
      source: nextFunction ? remainder.slice(0, nextFunction.index) : remainder,
    };
  }
  throw new Error(`Rust function not found: ${functionName}`);
};

export const extractNativeBridgeMethods = (sources) => {
  const handler = findRustFunctionSource(sources, 'handle_bridge_method');
  return [...handler.source.matchAll(/"(bridge\/[^"]+)"(?=\s*(?:\||=>))/g)].map(
    (match) => match[1],
  );
};

export const extractBridgeHttpRoutes = (sources) => {
  const router = findRustFunctionSource(sources, 'build_bridge_router');
  return [...router.source.matchAll(/\.route\(\s*"([^"]+)"/g)].map((match) => match[1]);
};
