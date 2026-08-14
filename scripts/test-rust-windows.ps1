[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$root = Split-Path -Parent $PSScriptRoot

function Invoke-Cargo {
    param([Parameter(Mandatory = $true)][string[]]$ArgumentList)

    & cargo @ArgumentList
    if ($LASTEXITCODE -ne 0) {
        throw "cargo exited with code $LASTEXITCODE."
    }
}

# The desktop suite is Windows-portable and exercises its native process/ACL strategy.
Invoke-Cargo @(
    "test", "--locked",
    "--manifest-path", (Join-Path $root "apps/desktop/Cargo.toml"),
    "--", "--test-threads=1"
)

# The full bridge suite runs in the Rust Bridge job on Ubuntu. Compile every test on Windows, then
# execute the Windows strategy tests without running Unix-only fixtures such as /bin/echo.
Invoke-Cargo @(
    "test", "--locked", "--all-targets", "--all-features",
    "--manifest-path", (Join-Path $root "services/rust-bridge/Cargo.toml"),
    "--no-run"
)
Invoke-Cargo @(
    "test", "--locked", "--all-targets", "--all-features",
    "--manifest-path", (Join-Path $root "services/rust-bridge/Cargo.toml"),
    "platform::", "--", "--test-threads=1"
)
