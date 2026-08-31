[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$root = Split-Path -Parent $PSScriptRoot
$testsRoot = Join-Path $root "apps/desktop/windows/tests"
$testProjects = @(Get-ChildItem $testsRoot -Recurse -Filter "*.Tests.csproj" -File)
if ($testProjects.Count -eq 0) {
    throw "No Windows test projects were found."
}

foreach ($testProject in $testProjects) {
    dotnet test $testProject.FullName --no-restore --configuration Release
    if ($LASTEXITCODE -ne 0) {
        throw "dotnet test exited with code $LASTEXITCODE for $($testProject.FullName)."
    }
}
