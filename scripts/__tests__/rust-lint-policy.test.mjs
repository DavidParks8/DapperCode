import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  collectVerifiedTestOnlyRustFiles,
  parseExternalModDeclarations,
  parseIncludeTargets,
} from '../rust-bridge-source-inventory.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const workspaces = ['apps/desktop', 'services/rust-bridge'];
const requiredRustLints = [
  'boxed_slice_into_iter',
  'dependency_on_unit_never_type_fallback',
  'deprecated_safe_2024',
  'edition_2024_expr_fragment_specifier',
  'if_let_rescope',
  'impl_trait_overcaptures',
  'keyword_idents_2024',
  'missing_unsafe_on_extern',
  'never_type_fallback_flowing_into_unsafe',
  'rust_2024_guarded_string_incompatible_syntax',
  'rust_2024_incompatible_pat',
  'rust_2024_prelude_collisions',
  'static_mut_refs',
  'trivial_numeric_casts',
  'unsafe_attr_outside_unsafe',
  'unsafe_op_in_unsafe_fn',
  'unused_lifetimes',
  'unused_macro_rules',
  'unused_must_use',
  'warnings',
];
const requiredClippyLints = [
  'allow_attributes',
  'allow_attributes_without_reason',
  'as_ptr_cast_mut',
  'borrow_as_ptr',
  'cast_lossless',
  'cast_possible_truncation',
  'cast_possible_wrap',
  'cast_precision_loss',
  'cast_ptr_alignment',
  'cast_sign_loss',
  'checked_conversions',
  'coerce_container_to_any',
  'collection_is_never_read',
  'dbg_macro',
  'debug_assert_with_mut_call',
  'default_union_representation',
  'empty_drop',
  'exit',
  'fallible_impl_from',
  'float_arithmetic',
  'float_cmp',
  'float_cmp_const',
  'fn_to_numeric_cast_any',
  'ignore_without_reason',
  'imprecise_flops',
  'invalid_upcast_comparisons',
  'large_futures',
  'large_stack_arrays',
  'large_stack_frames',
  'lossy_float_literal',
  'manual_midpoint',
  'mem_forget',
  'missing_fields_in_debug',
  'mixed_read_write_in_expression',
  'multiple_unsafe_ops_per_block',
  'negative_feature_names',
  'no_mangle_with_rust_abi',
  'non_send_fields_in_send_ty',
  'panic',
  'panic_in_result_fn',
  'path_buf_push_overwrite',
  'ptr_as_ptr',
  'ptr_cast_constness',
  'rc_mutex',
  'read_zero_byte_vec',
  'ref_as_ptr',
  'same_functions_in_if_condition',
  'should_panic_without_expect',
  'significant_drop_in_scrutinee',
  'suspicious_operation_groupings',
  'suspicious_xor_used_as_pow',
  'todo',
  'trailing_empty_array',
  'transmute_ptr_to_ptr',
  'transmute_undefined_repr',
  'unchecked_time_subtraction',
  'undocumented_unsafe_blocks',
  'unimplemented',
  'uninhabited_references',
  'unnecessary_safety_comment',
  'unnecessary_safety_doc',
  'unsafe_derive_deserialize',
  'unused_peekable',
  'unused_result_ok',
  'unused_rounding',
  'unwrap_used',
  'volatile_composites',
  'while_float',
  'wildcard_dependencies',
];

function read(relativePath) {
  return readFileSync(path.join(root, relativePath), 'utf8');
}

function table(manifest, name) {
  const lines = manifest.split(/\r?\n/);
  const start = lines.indexOf(`[${name}]`);
  assert.notEqual(start, -1, `missing [${name}]`);
  const entries = {};
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('[')) break;
    const match = line.match(/^\s*([\w-]+)\s*=\s*(.+?)\s*$/);
    if (match) entries[match[1]] = match[2];
  }
  return entries;
}

test('Rust workspaces share a strict, inherited lint policy', () => {
  let baseline;
  for (const workspace of workspaces) {
    const manifest = read(`${workspace}/Cargo.toml`);
    assert.equal(
      table(manifest, 'workspace.package').edition,
      '"2021"',
      `${workspace}: audit tail-expression drop order before changing editions`,
    );
    const rust = table(manifest, 'workspace.lints.rust');
    const clippy = table(manifest, 'workspace.lints.clippy');
    for (const lint of requiredRustLints) {
      assert.equal(rust[lint], '"deny"', `${workspace}: ${lint}`);
    }
    for (const lint of ['invalid_reference_casting', 'invalid_value', 'non_ascii_idents']) {
      assert.equal(rust[lint], '"forbid"', `${workspace}: ${lint}`);
    }
    assert.match(clippy.all, /level\s*=\s*"deny"/);
    assert.match(clippy.all, /priority\s*=\s*-1/);
    for (const lint of requiredClippyLints) {
      assert.equal(clippy[lint], '"deny"', `${workspace}: ${lint}`);
    }
    for (const lint of [
      'mut_from_ref',
      'uninit_assumed_init',
      'uninit_vec',
      'unsound_collection_transmute',
    ]) {
      assert.equal(clippy[lint], '"forbid"', `${workspace}: ${lint}`);
    }
    if (baseline) assert.deepEqual({ rust, clippy }, baseline);
    baseline = { rust, clippy };

    assert.match(manifest, /^members\s*=\s*\["crates\/\*"\]/m);
    const crates = readdirSync(path.join(root, workspace, 'crates'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${workspace}/crates/${entry.name}/Cargo.toml`);
    for (const crate of [`${workspace}/Cargo.toml`, ...crates]) {
      assert.equal(table(read(crate), 'lints').workspace, 'true', `${crate} must inherit lints`);
    }
  }
});

test('Rust tests retain assertion failures without exempting production code', () => {
  const config = read('clippy.toml');
  assert.match(config, /^allow-panic-in-tests = true$/m);
  assert.match(config, /^allow-unwrap-in-tests = true$/m);
  assert.match(config, /^array-size-threshold = 16384$/m);
  assert.match(config, /^future-size-threshold = 16384$/m);
  assert.match(config, /^stack-size-threshold = 512000$/m);
});

test('local and CI Rust lint gates cover all targets and features', () => {
  const lint = JSON.parse(read('package.json')).scripts.lint;
  for (const workspace of workspaces) {
    assert.ok(
      lint.includes(
        `cargo clippy --locked --workspace --all-targets --all-features --manifest-path ${workspace}/Cargo.toml -- -D warnings`,
      ),
      `local lint must cover ${workspace}`,
    );
  }
  const releaseLint =
    'cargo clippy --locked --release --workspace --all-features --lib --bins --manifest-path apps/desktop/Cargo.toml -- -D warnings';
  assert.ok(lint.includes(releaseLint), 'local lint must cover release-only desktop code');

  const workflow = read('.github/workflows/build-and-test.yml');
  assert.ok(
    (workflow.match(/cargo clippy --locked --workspace --all-targets --all-features /g) ?? [])
      .length >= 6,
    'Linux, macOS and Windows jobs must lint all targets and features',
  );
  assert.ok(
    workflow.split(releaseLint).length - 1 >= 3,
    'Linux, macOS and Windows jobs must lint release-only desktop code',
  );
  const macosJob = workflow.split('\n  desktop-macos:')[1].split('\n  desktop-windows:')[0];
  assert.match(
    macosJob,
    /cargo clippy --locked --workspace --all-targets --all-features --manifest-path services\/rust-bridge\/Cargo\.toml -- -D warnings/,
    'macOS must lint its bridge-specific code',
  );
  const linuxJob = workflow.split('\n  rust-bridge:')[1].split('\n  desktop-macos:')[0];
  assert.match(
    linuxJob,
    /cargo clippy --locked --workspace --all-targets --all-features --manifest-path apps\/desktop\/Cargo\.toml -- -D warnings/,
    'Linux must lint its desktop-specific code',
  );
});

test('unsafe-free Rust crates prevent introducing unsafe code', () => {
  for (const source of [
    'apps/desktop/src/main.rs',
    'apps/desktop/crates/broker/src/lib.rs',
    'services/rust-bridge/crates/core/src/lib.rs',
    'services/rust-bridge/crates/path-policy/src/lib.rs',
    'services/rust-bridge/src/e2e_agent.rs',
    'services/rust-bridge/src/main.rs',
  ]) {
    assert.match(read(source), /^#!\[forbid\(unsafe_code\)\]/m, source);
  }
});

test('generated bridge types remain subject to Clippy correctness checks', () => {
  const bridge = read('services/rust-bridge/src/main.rs');
  assert.doesNotMatch(bridge, /#\[allow\(clippy::all(?:,|\))/);
});

test('Rust workspaces share pinned Dylint perfectionist configuration and tool registration', () => {
  let baseline;
  for (const workspace of workspaces) {
    const dylintConfig = read(`${workspace}/dylint.toml`);
    assert.match(
      dylintConfig,
      /git\s*=\s*"https:\/\/github\.com\/KSXGitHub\/perfectionist",\s*rev\s*=\s*"[0-9a-f]{40}"/,
      `${workspace}/dylint.toml must pin KSXGitHub/perfectionist by commit SHA`,
    );
    assert.match(
      dylintConfig,
      /\["perfectionist::excessive_inline_tests"\]\r?\ninline_style\s*=\s*"external_only"/,
      `${workspace}/dylint.toml must enforce external-only Rust unit tests`,
    );
    if (baseline) assert.equal(dylintConfig, baseline);
    baseline = dylintConfig;

    const manifest = read(`${workspace}/Cargo.toml`);
    assert.match(
      manifest,
      /cfg\(dylint_lib,\s*values\("perfectionist"\)\)/,
      `${workspace}/Cargo.toml must declare dylint_lib in unexpected_cfgs`,
    );
  }

  for (const crateRoot of [
    'apps/desktop/src/main.rs',
    'apps/desktop/crates/core/src/lib.rs',
    'apps/desktop/crates/broker/src/lib.rs',
    'services/rust-bridge/src/main.rs',
    'services/rust-bridge/src/e2e_agent.rs',
    'services/rust-bridge/crates/core/src/lib.rs',
    'services/rust-bridge/crates/path-policy/src/lib.rs',
    'services/rust-bridge/crates/platform/src/lib.rs',
  ]) {
    const source = read(crateRoot);
    assert.match(
      source,
      /^#!\[cfg_attr\(dylint_lib = "perfectionist", feature\(register_tool\)\)\]/m,
      `${crateRoot} must gate register_tool feature on dylint_lib`,
    );
    assert.match(
      source,
      /^#!\[cfg_attr\(dylint_lib = "perfectionist", register_tool\(perfectionist\)\)\]/m,
      `${crateRoot} must register the perfectionist tool namespace`,
    );
  }

  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts.dylint, 'node ./scripts/run-dylint.mjs');
  assert.ok(pkg.scripts.lint.includes('pnpm run dylint'), 'local lint must run dylint');

  const dylintRunner = read('scripts/run-dylint.mjs');
  assert.match(
    dylintRunner,
    /'--lib',\s*'perfectionist'/,
    'run-dylint.mjs must pass --lib perfectionist so missing libraries fail closed',
  );
  assert.doesNotMatch(
    dylintRunner,
    /'--all'/,
    'run-dylint.mjs must not use --all, which exits 0 when no libraries are discovered',
  );

  const workflow = read('.github/workflows/build-and-test.yml');
  assert.match(workflow, /^\s+rust-dylint:/m, 'CI must include a rust-dylint job');
  assert.match(workflow, /node \.\/scripts\/run-dylint\.mjs/, 'CI must invoke run-dylint.mjs');
});

const ALLOWED_NON_SIBLING_TEST_DECLARATIONS = new Set([
  'services/rust-bridge/src/main.rs::source_policy',
  'apps/desktop/crates/core/src/lib.rs::test_env',
  'apps/desktop/crates/broker/src/lib.rs::http_client_tests',
]);

function walkWorkspaceRustFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'target' || entry.name === 'tests') return [];
      return walkWorkspaceRustFiles(entryPath);
    }
    return entry.name.endsWith('.rs') ? [entryPath] : [];
  });
}

function findExternalTestLayoutViolations(sourceRoot, displayRoot) {
  const allFiles = walkWorkspaceRustFiles(sourceRoot);
  const testOnly = collectVerifiedTestOnlyRustFiles(allFiles, sourceRoot);
  const violations = [];

  for (const file of allFiles) {
    const resolved = path.resolve(file);
    if (testOnly.has(resolved)) continue;
    const relative = path.relative(displayRoot, resolved).split(path.sep).join('/');
    const source = readFileSync(resolved, 'utf8');
    const stem = path.basename(resolved, '.rs');
    const expectedSibling = `${stem}_tests.rs`;

    if (/^\s*#\[(?:tokio::)?test\]/m.test(source)) {
      violations.push(`${relative} must not contain inline #[test] functions`);
    }
    if (
      /^\s*#\[cfg\([^\]]*test[^\]]*\)\](?:\r?\n\s*#\[[^\]]*\])*\r?\n\s*mod\s+\w+\s*\{/m.test(source)
    ) {
      violations.push(`${relative} must move inline #[cfg(test)] modules into ${expectedSibling}`);
    }

    for (const decl of parseExternalModDeclarations(resolved, source)) {
      if (!decl.isCfgTest) {
        if (path.basename(decl.target).endsWith('_tests.rs')) {
          violations.push(`${relative} links ${path.basename(decl.target)} without #[cfg(test)]`);
        }
        continue;
      }
      const scopedKey = `${relative}::${decl.modName}`;
      if (
        decl.topLevel &&
        decl.explicitPath === null &&
        ALLOWED_NON_SIBLING_TEST_DECLARATIONS.has(scopedKey)
      ) {
        continue;
      }
      if (decl.explicitPath !== expectedSibling) {
        violations.push(
          `${relative} external test module "${decl.modName}" must use #[path = "${expectedSibling}"]`,
        );
      }
    }

    for (const included of parseIncludeTargets(resolved, source)) {
      if (path.basename(included).endsWith('_tests.rs')) {
        violations.push(`${relative} includes ${path.basename(included)} from production code`);
      }
    }
  }
  return violations;
}

test('production Rust files keep unit tests in verified sibling *_tests.rs modules', () => {
  const violations = [];
  for (const workspace of workspaces) {
    const workspaceRoot = path.join(root, workspace);
    violations.push(...findExternalTestLayoutViolations(path.join(workspaceRoot, 'src'), root));
    const cratesDir = path.join(workspaceRoot, 'crates');
    for (const entry of readdirSync(cratesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const crateSrc = path.join(cratesDir, entry.name, 'src');
      violations.push(...findExternalTestLayoutViolations(crateSrc, root));
    }
  }
  assert.deepEqual(violations, []);
});

test('external test layout checker rejects production-linked *_tests.rs, include! links, and misnamed test modules', () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'dappercode-test-layout-'));
  try {
    const coreSrc = path.join(tempRoot, 'apps/desktop/crates/core/src');
    mkdirSync(coreSrc, { recursive: true });
    writeFileSync(
      path.join(coreSrc, 'lib.rs'),
      [
        'mod prod_tests;',
        'mod helper;',
        'include /* note */ ! { "included_tests.rs" }',
        'mod nested {',
        '  const TEXT: &str = "line 1\\',
        '  } still inside continued string";',
        '  const CONTINUED: &str = "ends with continuation\\',
        '";',
        '  #[cfg(test)]',
        '  mod test_env;',
        '}',
        '#[cfg(test)]',
        '#[path = "wrong_name.rs"]',
        'mod tests;',
      ].join('\n'),
    );
    writeFileSync(
      path.join(coreSrc, 'helper.rs'),
      '#[cfg(test)]\n#[path = "wrong_helper.rs"]\nmod test_env;\n',
    );
    writeFileSync(path.join(coreSrc, 'prod_tests.rs'), '#[test]\nfn leaked() {}\n');
    writeFileSync(path.join(coreSrc, 'included_tests.rs'), 'pub fn included() {}\n');
    writeFileSync(path.join(coreSrc, 'wrong_name.rs'), '#[test]\nfn misnamed() {}\n');
    writeFileSync(path.join(coreSrc, 'wrong_helper.rs'), '#[test]\nfn misnamed_helper() {}\n');

    const violations = findExternalTestLayoutViolations(coreSrc, tempRoot);
    assert.ok(
      violations.some(
        (item) => item.includes('prod_tests.rs') && item.includes('without #[cfg(test)]'),
      ),
      `expected production-linked *_tests.rs violation, got: ${violations.join('; ')}`,
    );
    assert.ok(
      violations.some((item) => item.includes('prod_tests.rs') && item.includes('inline #[test]')),
      `expected production-linked *_tests.rs to still be scanned as production, got: ${violations.join('; ')}`,
    );
    assert.ok(
      violations.some((item) => item.includes('included_tests.rs') && item.includes('includes')),
      `expected brace-form production include! of *_tests.rs violation, got: ${violations.join('; ')}`,
    );
    assert.ok(
      violations.some(
        (item) => item.includes('external test module "test_env"') && item.includes('lib.rs'),
      ),
      `expected nested mod test_env inside allowlisted lib.rs to be rejected, got: ${violations.join('; ')}`,
    );
    assert.ok(
      violations.some((item) => item.includes('must use #[path = "lib_tests.rs"]')),
      `expected misnamed external test module violation, got: ${violations.join('; ')}`,
    );
    assert.ok(
      violations.some(
        (item) =>
          item.includes('helper.rs') && item.includes('must use #[path = "helper_tests.rs"]'),
      ),
      `expected non-root mod test_env pointing at wrong_helper.rs to be rejected, got: ${violations.join('; ')}`,
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
