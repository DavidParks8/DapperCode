import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  extractBridgeHttpRoutes,
  extractNativeBridgeMethods,
  findRustFunctionSource,
  readRustBridgeProductionSources,
} from '../rust-bridge-source-inventory.mjs';

test('reads root and crate sources deterministically while skipping non-source crates', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dappercode-rust-inventory-'));
  try {
    const bridge = path.join(root, 'services/rust-bridge');
    mkdirSync(path.join(bridge, 'src'), { recursive: true });
    mkdirSync(path.join(bridge, 'src', 'bin'), { recursive: true });
    mkdirSync(path.join(bridge, 'crates', 'zeta', 'src'), { recursive: true });
    mkdirSync(path.join(bridge, 'crates', 'alpha', 'src'), { recursive: true });
    mkdirSync(path.join(bridge, 'crates', 'without-source'), { recursive: true });
    writeFileSync(
      path.join(bridge, 'Cargo.toml'),
      '[package]\nname = "fixture"\nversion = "0.1.0"\n[[bin]]\nname = "custom"\npath = "src/custom.rs" # comment\n',
    );
    writeFileSync(
      path.join(bridge, 'src', 'main.rs'),
      [
        'mod prod_tests; // production',
        '#[cfg(all(any(unix, test, windows)))]',
        'mod nested_prod;',
        '#[cfg(all(unix /* supported: linux, test, macOS */))]',
        'mod commented_prod;',
        '#[cfg(test)]',
        '#[path = "bin/tool.rs"]',
        'mod tool_under_test;',
        '#[cfg(test)]',
        '#[path = "custom.rs"]',
        'mod custom_under_test;',
        '#[cfg(test)]',
        'mod shared;',
        'const RAW: &str = r#"quote " then /* not a comment "#;',
        "const CHARS: [char; 2] = ['\\'','\"'];",
        'include /* note */ ! { "shared.rs" }',
        '#[cfg(test)]',
        '#[path = "main_tests.rs"]',
        'mod tests;',
        '#[cfg(test)]',
        'mod source_policy;',
        'fn root() {}',
      ].join('\n'),
    );
    writeFileSync(path.join(bridge, 'src', 'main_tests.rs'), '#[test] fn t() {}\n');
    writeFileSync(path.join(bridge, 'src', 'prod_tests.rs'), 'pub fn live() {}\n');
    writeFileSync(path.join(bridge, 'src', 'nested_prod.rs'), 'pub fn nested() {}\n');
    writeFileSync(path.join(bridge, 'src', 'commented_prod.rs'), 'pub fn commented() {}\n');
    writeFileSync(path.join(bridge, 'src', 'bin', 'tool.rs'), 'fn main() {}\n');
    writeFileSync(path.join(bridge, 'src', 'custom.rs'), 'fn main() {}\n');
    writeFileSync(path.join(bridge, 'src', 'shared.rs'), 'include!("leaf.rs");\n');
    writeFileSync(path.join(bridge, 'src', 'leaf.rs'), 'pub fn leaf() {}\n');
    writeFileSync(path.join(bridge, 'src', 'source_policy.rs'), '#![cfg(test)]\n');
    writeFileSync(path.join(bridge, 'crates', 'zeta', 'src', 'lib.rs'), 'fn zeta() {}');
    writeFileSync(path.join(bridge, 'crates', 'alpha', 'src', 'lib.rs'), 'fn alpha() {}');

    assert.deepEqual(
      [...readRustBridgeProductionSources(root).keys()],
      [
        'services/rust-bridge/src/bin/tool.rs',
        'services/rust-bridge/src/commented_prod.rs',
        'services/rust-bridge/src/custom.rs',
        'services/rust-bridge/src/leaf.rs',
        'services/rust-bridge/src/main.rs',
        'services/rust-bridge/src/nested_prod.rs',
        'services/rust-bridge/src/prod_tests.rs',
        'services/rust-bridge/src/shared.rs',
        'services/rust-bridge/crates/alpha/src/lib.rs',
        'services/rust-bridge/crates/zeta/src/lib.rs',
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('extracts grouped native bridge match arms without notification strings', () => {
  const sources = new Map([
    [
      'transport.rs',
      `
    async fn handle_bridge_method(method: &str) {
      match method {
        "bridge/one" => notify("bridge/notification"),
        "bridge/two" | "bridge/three" => {},
        _ => {},
      }
    }

    async fn next_function() {}
  `,
    ],
  ]);

  assert.deepEqual(extractNativeBridgeMethods(sources), [
    'bridge/one',
    'bridge/two',
    'bridge/three',
  ]);
});

test('extracts only routes owned by the bridge router', () => {
  const sources = new Map([
    [
      'routes.rs',
      `
    fn build_bridge_router() {
      Router::new()
        .route("/rpc", get(ws))
        .route(
          "/attachments",
          post(upload),
        );
    }

    fn build_preview_router() {
      Router::new().route("/", get(preview));
    }
  `,
    ],
  ]);

  assert.deepEqual(extractBridgeHttpRoutes(sources), ['/rpc', '/attachments']);
  assert.equal(findRustFunctionSource(sources, 'build_bridge_router').file, 'routes.rs');
  assert.throws(
    () => findRustFunctionSource(sources, 'missing'),
    /Rust function not found: missing/,
  );
});
