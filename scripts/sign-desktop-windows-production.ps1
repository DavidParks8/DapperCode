[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ArtifactRoot
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Invoke-Native {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$ArgumentList
    )

    & $FilePath @ArgumentList
    if ($LASTEXITCODE -ne 0) {
        throw "$FilePath exited with code $LASTEXITCODE."
    }
}

function Find-WindowsSdkTool {
    param([Parameter(Mandatory = $true)][string]$Name)

    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }

    $kitsRoot = (Get-ItemProperty `
        "Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows Kits\Installed Roots" `
        -ErrorAction SilentlyContinue).KitsRoot10
    if (-not $kitsRoot) {
        throw "Windows SDK is required, but KitsRoot10 is not registered."
    }

    $tool = Get-ChildItem (Join-Path $kitsRoot "bin") -Filter $Name -Recurse -File |
        Where-Object { $_.Directory.Name -in @("x64", "x86") } |
        Sort-Object FullName -Descending |
        Select-Object -First 1
    if (-not $tool) {
        throw "Windows SDK tool '$Name' was not found."
    }
    return $tool.FullName
}

$ArtifactRoot = [IO.Path]::GetFullPath($ArtifactRoot)
$pfxPath = Join-Path $env:RUNNER_TEMP (
    "dappercode-production-signing-$env:GITHUB_RUN_ID-$env:GITHUB_RUN_ATTEMPT.pfx"
)
$certificate = $null

try {
    if (-not $env:DAPPERCODE_WINDOWS_PUBLISHER) {
        throw "WINDOWS_SIGNING_PUBLISHER is required."
    }
    if (-not $env:DAPPERCODE_WINDOWS_CERTIFICATE_BASE64) {
        throw "WINDOWS_SIGNING_CERTIFICATE_BASE64 is required."
    }
    if (-not $env:DAPPERCODE_WINDOWS_CERTIFICATE_PASSWORD) {
        throw "WINDOWS_SIGNING_CERTIFICATE_PASSWORD is required."
    }
    if (-not $env:DAPPERCODE_WINDOWS_TIMESTAMP_URL) {
        throw "WINDOWS_SIGNING_TIMESTAMP_URL is required."
    }

    $timestampUri = $null
    if (-not [Uri]::TryCreate(
        $env:DAPPERCODE_WINDOWS_TIMESTAMP_URL,
        [UriKind]::Absolute,
        [ref]$timestampUri
    ) -or
        $timestampUri.Scheme -ne [Uri]::UriSchemeHttps -or
        $timestampUri.UserInfo -or
        $timestampUri.Fragment) {
        throw (
            "WINDOWS_SIGNING_TIMESTAMP_URL must be an absolute HTTPS RFC 3161 endpoint " +
            "without credentials or a fragment."
        )
    }
    $timestampUrl = $timestampUri.AbsoluteUri

    $reparsePoints = @(Get-ChildItem $ArtifactRoot -Recurse -Force |
        Where-Object {
            ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
        })
    if ($reparsePoints.Count -ne 0) {
        throw "The unsigned artifact must not contain links or reparse points."
    }

    $files = @(Get-ChildItem $ArtifactRoot -Recurse -File)
    $bundleFiles = @($files | Where-Object { $_.Extension -eq ".msixbundle" })
    if ($bundleFiles.Count -ne 1) {
        throw "Expected exactly one unsigned MSIX bundle; found $($bundleFiles.Count)."
    }
    $bundle = $bundleFiles[0]
    $bundleName = [regex]::Match(
        $bundle.Name,
        '^DapperCode-(?<version>\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)-x64_arm64\.msixbundle$'
    )
    if (-not $bundleName.Success) {
        throw "Unexpected unsigned bundle name '$($bundle.Name)'."
    }
    $version = $bundleName.Groups["version"].Value

    $expectedRelativeFiles = @(
        $bundle.Name,
        "packages\DapperCode-$version-x64.msix",
        "packages\DapperCode-$version-arm64.msix"
    ) | Sort-Object
    $actualRelativeFiles = @($files | ForEach-Object {
        [IO.Path]::GetRelativePath($ArtifactRoot, $_.FullName).Replace("/", "\")
    }) | Sort-Object
    if (($expectedRelativeFiles -join "`n") -ne ($actualRelativeFiles -join "`n")) {
        throw (
            "Unsigned production artifact contents were not the expected bundle and two " +
            "architecture packages.`nActual:`n$($actualRelativeFiles -join "`n")"
        )
    }

    $packages = @(
        (Get-Item (Join-Path $ArtifactRoot "packages\DapperCode-$version-x64.msix")),
        (Get-Item (Join-Path $ArtifactRoot "packages\DapperCode-$version-arm64.msix"))
    )

    try {
        $pfxBytes = [Convert]::FromBase64String(
            $env:DAPPERCODE_WINDOWS_CERTIFICATE_BASE64
        )
    } catch {
        throw "WINDOWS_SIGNING_CERTIFICATE_BASE64 is not valid base64."
    }
    [IO.File]::WriteAllBytes($pfxPath, $pfxBytes)

    try {
        $certificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new(
            $pfxPath,
            $env:DAPPERCODE_WINDOWS_CERTIFICATE_PASSWORD,
            [Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet
        )
    } catch {
        throw "The production signing certificate could not be opened."
    }
    if (-not $certificate.HasPrivateKey) {
        throw "The production signing certificate does not contain a private key."
    }
    if ($certificate.Subject -ne $env:DAPPERCODE_WINDOWS_PUBLISHER) {
        throw (
            "Production certificate subject '$($certificate.Subject)' does not match " +
            "WINDOWS_SIGNING_PUBLISHER '$env:DAPPERCODE_WINDOWS_PUBLISHER'."
        )
    }
    $now = Get-Date
    if ($certificate.NotBefore -gt $now -or $certificate.NotAfter -le $now) {
        throw "The production signing certificate is not currently valid."
    }
    $codeSigningEku = "1.3.6.1.5.5.7.3.3"
    $eku = $certificate.Extensions |
        Where-Object { $_.Oid.Value -eq "2.5.29.37" } |
        Select-Object -First 1
    if (-not $eku -or
        $codeSigningEku -notin @($eku.EnhancedKeyUsages | ForEach-Object { $_.Value })) {
        throw "The production certificate is not valid for code signing."
    }

    $signTool = Find-WindowsSdkTool "signtool.exe"
    $artifactsToSign = @($packages) + @($bundle)
    foreach ($artifact in $artifactsToSign) {
        Invoke-Native $signTool @(
            "sign", "/fd", "SHA256",
            "/tr", $timestampUrl, "/td", "SHA256",
            "/f", $pfxPath,
            "/p", $env:DAPPERCODE_WINDOWS_CERTIFICATE_PASSWORD,
            $artifact.FullName
        )
    }
    foreach ($artifact in $artifactsToSign) {
        Invoke-Native $signTool @("verify", "/pa", "/all", "/v", $artifact.FullName)
    }

    $publicCertificate = Join-Path $ArtifactRoot "DapperCode-Signing.cer"
    [IO.File]::WriteAllBytes(
        $publicCertificate,
        $certificate.Export(
            [Security.Cryptography.X509Certificates.X509ContentType]::Cert
        )
    )
    $sha256Thumbprint = [Convert]::ToHexString(
        $certificate.GetCertHash(
            [Security.Cryptography.HashAlgorithmName]::SHA256
        )
    )
    $installGuidance = @"
DapperCode Windows production installation

Publisher: $($certificate.Subject)
Signing certificate SHA-256: $sha256Thumbprint

The production signing certificate should already be trusted by the target Windows device.
The public certificate is included for identity verification; do not import it merely because
it accompanied a download.

Install the bundle:
  Add-AppxPackage ".\$($bundle.Name)"
"@
    Set-Content (Join-Path $ArtifactRoot "INSTALL-WINDOWS.txt") `
        -Value $installGuidance -Encoding utf8
} finally {
    if ($certificate) {
        $certificate.Dispose()
    }
    Remove-Item $pfxPath -Force -ErrorAction SilentlyContinue
    Remove-Item Env:DAPPERCODE_WINDOWS_CERTIFICATE_BASE64 `
        -ErrorAction SilentlyContinue
    Remove-Item Env:DAPPERCODE_WINDOWS_CERTIFICATE_PASSWORD `
        -ErrorAction SilentlyContinue
}
