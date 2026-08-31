[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ExpectedSdkVersion
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$root = Split-Path -Parent $PSScriptRoot
$solution = Join-Path $root "apps/desktop/windows/DapperCode.Windows.slnx"
$sdkVersion = (dotnet --version).Trim()
if ($sdkVersion -ne $ExpectedSdkVersion) {
    throw "Expected .NET SDK $ExpectedSdkVersion, but dotnet selected $sdkVersion."
}

dotnet msbuild $solution /t:Restore
if ($LASTEXITCODE -ne 0) {
    throw "dotnet restore exited with code $LASTEXITCODE."
}
