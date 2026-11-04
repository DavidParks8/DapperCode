import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

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
