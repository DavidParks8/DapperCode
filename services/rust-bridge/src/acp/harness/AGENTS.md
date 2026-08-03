# Harness adapters

This folder is the complete boundary for harness-specific behavior layered under generic ACP.

## Structure

- `mod.rs` owns only generic harness types, the `HarnessAdapter` trait, and
  `harness_for_manifest`.
- Each supported harness has exactly one adapter file, such as `opencode.rs`.
- Adapter files own their verified identity matching, launch configuration, vendor request and
  response types, URL construction, protocol translation, limits, and focused tests.

## Boundary rules

- Never expose a harness name, identity predicate, vendor schema, vendor method name, or
  vendor-specific DTO outside this folder.
- Code outside this folder may call only generic APIs exported by `mod.rs`.
- Keep wire contracts harness-agnostic. They expose effective capabilities and generic operations,
  never which adapter supplied them.
- Select adapters only in `harness_for_manifest`, using built-in matching against an already
  verified `ResolvedAgentManifest`. Manifest metadata must not choose an adapter or claim support.
- Capability reporting and operation dispatch must use the same adapter instance.
- Report a capability as false unless the adapter implements it and all required runtime/session
  state is available. Do not infer support from display names, models, or client-side heuristics.
- Generic ACP support always takes precedence. An adapter supplies only behavior missing from ACP.
- Keep failures explicit and bounded. Vendor HTTP, parsing, initialization, and lifecycle failures
  must not become success-shaped fallbacks.

## Adding a harness

1. Add one private adapter file in this folder.
2. Implement `HarnessAdapter` with generic request/result types from `mod.rs`.
3. Keep identity verification and any launch arguments inside that adapter file.
4. Register its private resolver in `harness_for_manifest`; return `None` when no built-in identity
   matches.
5. Add tests for exact verified selection, spoofed identities, missing prerequisites, capability
   gating, translation, bounded responses, and operation failures.
6. Update generic Rust/mobile contracts only when the operation itself is new. Do not add the
   harness name or adapter provenance to those contracts.

## Validation

```bash
cargo fmt --check --manifest-path services/rust-bridge/Cargo.toml
cargo clippy --locked --all-targets --all-features --manifest-path services/rust-bridge/Cargo.toml -- -D warnings
cargo test --locked --all-targets --all-features --manifest-path services/rust-bridge/Cargo.toml -- --test-threads=1
```
