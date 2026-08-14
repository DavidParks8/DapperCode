# Open Source License Requirements

This project includes third-party open source software through npm, Cargo, and NuGet dependencies.

## Distribution Requirements

When distributing this project (internal, TestFlight, enterprise, or public):

1. Include a project license file at the repository root (`LICENSE`).
2. Preserve copyright and license notices from all third-party dependencies.
3. Provide a third-party notices document with shipped builds.
4. Keep dependency license metadata available for audit.

## Third-Party Notices

At minimum, generate and keep a `THIRD_PARTY_NOTICES` file for each release build that includes:

- package/crate name
- version
- license identifier
- attribution text when required by license

The mobile runtime directly depends on `@ag-ui/core` version `0.0.57` under the MIT License.
Include its distributed `LICENSE` text in generated mobile notices.

The mobile runtime directly depends on `expo-glass-effect` version `~57.0.1` under the MIT License.
Include its distributed `LICENSE` text in generated mobile notices.

The Rust bridge directly depends on `agent-client-protocol` version `1.2.0`
with the `unstable_elicitation` feature. Include its Apache-2.0 license text
and any transitive notices required by the resolved Cargo lockfile in bridge
distribution notices.

The macOS desktop shell uses operating-system SwiftUI/AppKit frameworks and bundles only the Rust
operator and Rust bridge. Include generated `THIRD_PARTY_NOTICES.txt` for both Cargo dependency
closures and the DapperCode license in every distributed `.app` or archive.

The Windows desktop package uses a C# WinUI 3 shell and packages managed .NET/NuGet components
alongside the Rust operator and bridge. Windows notice generation must consume the restored NuGet
assets and Rust target triple for the exact architecture-specific package build; it must not
describe that payload as Rust-only or attribute restore-only build/reference packages. NuGet
attribution also includes packages whose imported `build` or `buildTransitive` targets inject
package-local runtime payloads, such as framework MSIX files or self-contained native DLLs, even
when `project.assets.json` does not list those files in its runtime dictionaries. Include
`THIRD_PARTY_NOTICES.txt`, covering both target-filtered Cargo closures and the shipped per-RID
NuGet runtime, native, resource, build-injected, and self-contained .NET pack closure, plus the
DapperCode license in every architecture-specific MSIX and the x64/ARM64 MSIX bundle. Preserve
license files referenced from NuGet package metadata. A shipped package with only an MIT expression
must receive the complete MIT text; notice generation must fail if no supported expression or
license file supplies license terms. The packaged paths are
`Licenses\THIRD_PARTY_NOTICES.txt` and `Licenses\DapperCode-LICENSE.txt`.

## Practical Policy

- Do not remove existing license headers from source files.
- Do not copy code/assets from external projects unless the license allows redistribution.
- If a dependency license is copyleft or has notice obligations, ensure notices are included before shipping.
- Re-run license checks whenever dependencies change.

## App Distribution Note

For mobile and desktop distributions, ensure the same third-party notices used for
repository/release artifacts are also available for app review and legal compliance workflows.
