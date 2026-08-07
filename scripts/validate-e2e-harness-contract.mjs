import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import ts from 'typescript';

import { startHarnessBridge } from '../e2e/harness/bridgeServer.ts';

/**
 * Keeps the e2e harness bridge honest against the shared bridge contract.
 *
 * The harness is a third implementation of the wire protocol, alongside the Rust bridge and the
 * mobile client. `validate-rpc-contract-fixtures.mjs` already ties the first two to
 * `contracts/bridge-rpc/v2/manifest.json`; this ties the harness to it as well, so a method added
 * to the real bridge cannot quietly leave the harness behind.
 *
 * Running the harness rather than grepping it means the check sees the real registered inventory.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(
  readFileSync(path.join(root, 'contracts/bridge-rpc/v2/manifest.json'), 'utf8'),
);

/**
 * Methods the mobile client can send that the harness deliberately does not model.
 *
 * Everything here is a conscious decision, not an oversight: the e2e suite drives layout on the web
 * target, where these flows either cannot run or are out of scope. A method may only be added with
 * a reason, which is the point — a new client RPC fails this check until someone either implements
 * it in the harness or records why it is not needed.
 */
const intentionallyUnmodelled = new Map([
  ['bridge/browser/session/close', 'Browser preview is not exercised by the layout suite.'],
  ['bridge/browser/session/create', 'Browser preview is not exercised by the layout suite.'],
  ['bridge/browser/targets/discover', 'Browser preview is not exercised by the layout suite.'],
  ['bridge/fs/list', 'The file browser is not exercised by the layout suite.'],
  ['bridge/git/branches', 'Git surfaces are not exercised by the layout suite.'],
  ['bridge/git/clone', 'Git surfaces are not exercised by the layout suite.'],
  ['bridge/git/commit', 'Git surfaces are not exercised by the layout suite.'],
  ['bridge/git/diff', 'Git surfaces are not exercised by the layout suite.'],
  ['bridge/git/history', 'Git surfaces are not exercised by the layout suite.'],
  ['bridge/git/push', 'Git surfaces are not exercised by the layout suite.'],
  ['bridge/git/stage', 'Git surfaces are not exercised by the layout suite.'],
  ['bridge/git/stageAll', 'Git surfaces are not exercised by the layout suite.'],
  ['bridge/git/status', 'Git surfaces are not exercised by the layout suite.'],
  ['bridge/git/switch', 'Git surfaces are not exercised by the layout suite.'],
  ['bridge/git/unstage', 'Git surfaces are not exercised by the layout suite.'],
  ['bridge/git/unstageAll', 'Git surfaces are not exercised by the layout suite.'],
  ['bridge/push/register', 'Push registration is skipped on web, so the app never sends this.'],
  ['bridge/push/unregister', 'Push registration is skipped on web, so the app never sends this.'],
  ['bridge/thread/fork', 'Thread forking is not exercised by the layout suite.'],
  ['bridge/thread/queue/edit/cancel', 'Queue editing is not exercised by the layout suite.'],
  ['bridge/thread/queue/edit/commit', 'Queue editing is not exercised by the layout suite.'],
  ['bridge/thread/queue/edit/start', 'Queue editing is not exercised by the layout suite.'],
  ['bridge/thread/queue/steer', 'Steering is not exercised by the layout suite.'],
  ['bridge/ui/dismiss', 'Bridge-driven UI surfaces are not exercised by the layout suite.'],
  ['bridge/ui/resolve', 'Bridge-driven UI surfaces are not exercised by the layout suite.'],
  ['thread/start', 'The app resumes seeded threads rather than starting new ones.'],
]);

const fail = (message) => {
  process.stderr.write(`e2e harness contract validation failed: ${message}\n`);
  process.exitCode = 1;
};

const readMobileBridgeFiles = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return readMobileBridgeFiles(entryPath);
    if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts'))
      return [];
    return [entryPath];
  });

/**
 * Collects the RPC methods the mobile client can send.
 *
 * This walks the TypeScript AST rather than pattern-matching the text. A regex over `.request(...)`
 * looked adequate but silently under-reports: it misses calls split across lines by the formatter,
 * calls whose generic argument contains a nested `>`, and any method held in a constant. Every one
 * of those would drop a method from the inventory, and a gate that quietly checks less than it
 * claims is worse than no gate.
 *
 * Non-literal method arguments are reported rather than skipped, for the same reason.
 */
const collectClientMethods = () => {
  const methods = new Set();
  const dynamic = [];

  for (const file of readMobileBridgeFiles(path.join(root, 'apps/mobile/src/bridge'))) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );

    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'request'
      ) {
        const [methodArg] = node.arguments;
        if (methodArg) {
          if (ts.isStringLiteralLike(methodArg)) {
            methods.add(methodArg.text);
          } else {
            const { line } = source.getLineAndCharacterOfPosition(methodArg.getStart(source));
            dynamic.push(`${path.relative(root, file)}:${String(line + 1)}`);
          }
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(source);
  }

  return { methods: [...methods].sort(), dynamic };
};

const { methods: clientMethods, dynamic: dynamicCallSites } = collectClientMethods();

if (clientMethods.length === 0) {
  fail('could not extract any RPC methods from the mobile bridge client');
}

// A computed method name makes the inventory unknowable, so the harness cannot be proven to cover
// it. Keep RPC method names as literals at the call site.
if (dynamicCallSites.length > 0) {
  fail(
    `the mobile client sends RPC methods that are not string literals, so harness coverage cannot ` +
      `be verified: ${dynamicCallSites.join(', ')}`,
  );
}

const bridge = await startHarnessBridge();
const handled = new Set(bridge.handlerMethods);
await bridge.close();

// 1. The harness must not answer anything the contract does not declare. `startHarnessBridge`
//    throws on its own if this is violated, so reaching here means the inventory is declared.
const declared = new Set([...manifest.bridgeMethods, ...manifest.mobileForwardedMethods]);
const undeclared = [...handled].filter((method) => !declared.has(method));
if (undeclared.length > 0) {
  fail(`harness handles undeclared method(s): ${undeclared.join(', ')}`);
}

// 2. Every method the mobile client can send must either be handled or consciously excluded.
const unaccounted = clientMethods.filter(
  (method) => !handled.has(method) && !intentionallyUnmodelled.has(method),
);
if (unaccounted.length > 0) {
  fail(
    `the mobile client can send ${String(unaccounted.length)} method(s) the harness neither ` +
      `handles nor excludes: ${unaccounted.join(', ')}. Implement them in ` +
      `e2e/harness/bridgeServer.ts, or add them to the intentionallyUnmodelled list in this ` +
      `script with a reason.`,
  );
}

// 3. The exclusion list must not rot either: an entry for a method the client no longer sends, or
//    that the harness now handles, is stale and should be removed.
const staleExclusions = [...intentionallyUnmodelled.keys()].filter(
  (method) => !clientMethods.includes(method) || handled.has(method),
);
if (staleExclusions.length > 0) {
  fail(
    `stale intentionallyUnmodelled entries (the client no longer sends these, or the harness now ` +
      `handles them): ${staleExclusions.join(', ')}`,
  );
}

if (process.exitCode !== 1) {
  process.stdout.write(
    `e2e harness bridge matches the contract (${String(handled.size)} methods handled, ` +
      `${String(intentionallyUnmodelled.size)} intentionally unmodelled).\n`,
  );
}
