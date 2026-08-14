[CmdletBinding()]
param(
    [ValidateSet("Test", "Production")]
    [string]$SigningMode = $(if ($env:DAPPERCODE_WINDOWS_SIGNING_MODE) {
        $env:DAPPERCODE_WINDOWS_SIGNING_MODE
    } else {
        "Test"
    }),
    [ValidateSet("Package", "Bundle", "Sign")]
    [string]$Operation = "Package",
    [ValidateSet("All", "x64", "arm64")]
    [string]$Architecture = "All",
    [switch]$SkipRust,
    [switch]$SkipBundle,
    [switch]$SkipInspection
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$desktopDirectory = Join-Path $root "apps/desktop"
$windowsDirectory = Join-Path $desktopDirectory "windows"
$distDirectory = Join-Path $desktopDirectory "dist/windows"
$packageDirectory = Join-Path $distDirectory "packages"
$bundleInputDirectory = Join-Path $distDirectory ".bundle-input"
$packageIdentity = if ($env:DAPPERCODE_WINDOWS_PACKAGE_IDENTITY) {
    $env:DAPPERCODE_WINDOWS_PACKAGE_IDENTITY
} else {
    "DapperCode.Desktop"
}
$requiredDotNetSdkVersion = "10.0.302"
$testPublisher = "CN=DapperCode"
$publisher = if ($SigningMode -eq "Production") {
    $env:DAPPERCODE_WINDOWS_PUBLISHER
} else {
    $testPublisher
}
$temporaryProductionCertificate = $null

if (
    $Operation -ne "Sign" -and
    (
        $env:DAPPERCODE_WINDOWS_CERTIFICATE_PATH -or
        $env:DAPPERCODE_WINDOWS_CERTIFICATE_BASE64 -or
        $env:DAPPERCODE_WINDOWS_CERTIFICATE_PASSWORD
    )
) {
    throw ("Production certificate inputs may only be provided to the dedicated Sign " +
        "operation, after packaging and tests have completed.")
}
if ($Operation -eq "Sign" -and $SigningMode -ne "Production") {
    throw "The Sign operation is only available with SigningMode Production."
}
if ($SkipBundle -and ($Operation -ne "Package" -or $Architecture -eq "All")) {
    throw "-SkipBundle requires Package operation with one explicit architecture."
}

function Invoke-Native {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$ArgumentList
    )

    & $FilePath @ArgumentList
    if ($LASTEXITCODE -ne 0) {
        throw "$FilePath exited with code $LASTEXITCODE"
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
        throw "Windows SDK tool '$Name' was not found under $kitsRoot."
    }
    return $tool.FullName
}

function Resolve-PinnedDotNet {
    $command = Get-Command "dotnet.exe" -ErrorAction SilentlyContinue
    if (-not $command) {
        throw ".NET SDK $requiredDotNetSdkVersion is required, but dotnet.exe was not found."
    }

    $sdkVersionOutput = @(& $command.Source "--version" 2>&1)
    if ($LASTEXITCODE -ne 0) {
        throw "dotnet --version exited with code $LASTEXITCODE."
    }
    $sdkVersion = ($sdkVersionOutput -join "").Trim()
    if ($sdkVersion -ne $requiredDotNetSdkVersion) {
        throw (
            ".NET SDK $requiredDotNetSdkVersion is required; dotnet selected '$sdkVersion'. " +
            "Install the pinned SDK and ensure it is selected before packaging."
        )
    }
    if (-not $sdkVersion.StartsWith("10.", [StringComparison]::Ordinal)) {
        throw ".NET SDK major version 10 is required; dotnet selected '$sdkVersion'."
    }

    $msbuildVersionOutput = @(& $command.Source "msbuild" "-version" "-nologo" 2>&1)
    if ($LASTEXITCODE -ne 0) {
        throw "dotnet msbuild -version exited with code $LASTEXITCODE."
    }
    $msbuildVersionText = $msbuildVersionOutput -join [Environment]::NewLine
    $msbuildVersion = [regex]::Match(
        $msbuildVersionText,
        '(?im)(?:MSBuild version\s+)?(?<version>\d+\.\d+(?:\.\d+)*)'
    )
    if (-not $msbuildVersion.Success -or
        -not $msbuildVersion.Groups["version"].Value.StartsWith(
            "18.",
            [StringComparison]::Ordinal
        )) {
        throw "The pinned .NET SDK must provide MSBuild 18; received '$msbuildVersionText'."
    }

    Write-Host (
        "Using .NET SDK $sdkVersion with MSBuild " +
        "$($msbuildVersion.Groups["version"].Value)."
    )
    return $command.Source
}

function Get-DesktopVersion {
    $manifest = Get-Content (Join-Path $desktopDirectory "Cargo.toml") -Raw
    $match = [regex]::Match($manifest, '(?m)^version\s*=\s*"([^"]+)"')
    if (-not $match.Success) {
        throw "Could not read the desktop version."
    }
    return $match.Groups[1].Value
}

function ConvertTo-MsixVersion {
    param([Parameter(Mandatory = $true)][string]$Version)

    $numeric = $Version.Split("-", 2)[0].Split(".")
    if ($numeric.Count -gt 4 -or $numeric.Count -lt 1) {
        throw "Desktop version '$Version' cannot be converted to an MSIX version."
    }
    $parts = @($numeric)
    while ($parts.Count -lt 4) {
        $parts += "0"
    }
    foreach ($part in $parts) {
        $value = 0
        if (-not [int]::TryParse($part, [ref]$value) -or $value -lt 0 -or $value -gt 65535) {
            throw "Desktop version '$Version' contains an invalid MSIX version component."
        }
    }
    return $parts -join "."
}

function Get-TestSigningCertificate {
    $certificate = Get-ChildItem "Cert:\CurrentUser\My" |
        Where-Object {
            $_.Subject -eq $testPublisher -and
            $_.HasPrivateKey -and
            $_.NotAfter -gt (Get-Date).AddDays(30)
        } |
        Sort-Object NotAfter -Descending |
        Select-Object -First 1
    if (-not $certificate) {
        Write-Host "Creating a user-scoped DapperCode test signing certificate."
        $certificate = New-SelfSignedCertificate `
            -Type Custom `
            -Subject $testPublisher `
            -FriendlyName "DapperCode local MSIX test signing" `
            -CertStoreLocation "Cert:\CurrentUser\My" `
            -KeyAlgorithm RSA `
            -KeyLength 3072 `
            -HashAlgorithm SHA256 `
            -KeyUsage DigitalSignature `
            -NotAfter (Get-Date).AddYears(2) `
            -TextExtension @(
                "2.5.29.19={text}",
                "2.5.29.37={text}1.3.6.1.5.5.7.3.3"
            )
    }
    return $certificate
}

function Resolve-ProductionCertificate {
    if (-not $publisher) {
        throw "Production signing requested, but DAPPERCODE_WINDOWS_PUBLISHER is missing."
    }
    if (-not $env:DAPPERCODE_WINDOWS_CERTIFICATE_PASSWORD) {
        throw ("Production signing requested, but " +
            "DAPPERCODE_WINDOWS_CERTIFICATE_PASSWORD is missing.")
    }

    if ($env:DAPPERCODE_WINDOWS_CERTIFICATE_PATH) {
        $path = [IO.Path]::GetFullPath($env:DAPPERCODE_WINDOWS_CERTIFICATE_PATH)
        if (-not (Test-Path $path -PathType Leaf)) {
            throw "Production signing certificate does not exist: $path"
        }
        $repositoryPrefix = [IO.Path]::GetFullPath($root).TrimEnd(
            [IO.Path]::DirectorySeparatorChar,
            [IO.Path]::AltDirectorySeparatorChar
        ) + [IO.Path]::DirectorySeparatorChar
        if ($path.StartsWith(
            $repositoryPrefix,
            [StringComparison]::OrdinalIgnoreCase
        )) {
            throw "The production signing certificate must be stored outside the repository."
        }
        return $path
    }

    if (-not $env:DAPPERCODE_WINDOWS_CERTIFICATE_BASE64) {
        throw ("Production signing requested, but neither " +
            "DAPPERCODE_WINDOWS_CERTIFICATE_PATH nor " +
            "DAPPERCODE_WINDOWS_CERTIFICATE_BASE64 was provided.")
    }
    if (-not $env:LOCALAPPDATA) {
        throw "LOCALAPPDATA is required to stage the production signing certificate outside the repository."
    }

    $signingDirectory = Join-Path $env:LOCALAPPDATA "DapperCode/Signing"
    New-Item $signingDirectory -ItemType Directory -Force | Out-Null
    $script:temporaryProductionCertificate = Join-Path $signingDirectory `
        "production-signing-$PID.pfx"
    try {
        [IO.File]::WriteAllBytes(
            $script:temporaryProductionCertificate,
            [Convert]::FromBase64String($env:DAPPERCODE_WINDOWS_CERTIFICATE_BASE64)
        )
    } catch {
        throw "DAPPERCODE_WINDOWS_CERTIFICATE_BASE64 is not a valid base64-encoded certificate."
    }
    return $script:temporaryProductionCertificate
}

function Get-ProductionTimestampUrl {
    if (-not $env:DAPPERCODE_WINDOWS_TIMESTAMP_URL) {
        throw "Production signing requested, but DAPPERCODE_WINDOWS_TIMESTAMP_URL is missing."
    }

    $uri = $null
    if (-not [Uri]::TryCreate(
        $env:DAPPERCODE_WINDOWS_TIMESTAMP_URL,
        [UriKind]::Absolute,
        [ref]$uri
    ) -or $uri.Scheme -notin @("http", "https")) {
        throw ("DAPPERCODE_WINDOWS_TIMESTAMP_URL must be an absolute HTTP(S) RFC 3161 " +
            "timestamp URL.")
    }
    return $uri.AbsoluteUri
}

function Write-InstallGuidance {
    param([Parameter(Mandatory = $true)][string]$Bundle)

    $guidance = @"
DapperCode Windows installation

The MSIX bundle is signed. Only this public certificate is distributed; the private key remains
in the current user's certificate store (test builds) or in the configured production signer.

For a local test-signed build, trust the public certificate from an elevated terminal:
  certutil -addstore TrustedPeople ".\DapperCode-Signing.cer"

Then install the bundle:
  Add-AppxPackage ".\$(Split-Path $Bundle -Leaf)"

Production releases should be signed by a certificate already trusted by the target device and do
not normally require the certificate-import step.
"@
    Set-Content (Join-Path $distDirectory "INSTALL-WINDOWS.txt") `
        -Value $guidance -Encoding utf8
}

function Find-GeneratedPackage {
    param([Parameter(Mandatory = $true)][string]$Directory)

    $packages = @(Get-ChildItem $Directory -Recurse -File |
        Where-Object {
            $_.Extension -in @(".msix", ".appx") -and
            $_.FullName -notmatch '[\\/]Dependencies[\\/]'
        })
    if ($packages.Count -ne 1) {
        $paths = $packages.FullName -join [Environment]::NewLine
        throw "Expected one generated MSIX package in $Directory; found $($packages.Count).`n$paths"
    }
    return $packages[0].FullName
}

if ($env:OS -ne "Windows_NT") {
    throw "The Windows desktop package must be built on Windows."
}
if (-not $publisher) {
    throw "Production signing requested, but DAPPERCODE_WINDOWS_PUBLISHER is missing."
}

$version = Get-DesktopVersion
if ($Operation -eq "Sign") {
    $signTool = Find-WindowsSdkTool "signtool.exe"
    $bundle = Join-Path $distDirectory "DapperCode-$version-x64_arm64.msixbundle"
    $packages = @(
        (Join-Path $packageDirectory "DapperCode-$version-x64.msix"),
        (Join-Path $packageDirectory "DapperCode-$version-arm64.msix")
    )
    $artifactsToSign = @($packages) + @($bundle)
    foreach ($artifact in $artifactsToSign) {
        if (-not (Test-Path $artifact -PathType Leaf)) {
            throw "Production signing artifact does not exist: $artifact"
        }
    }

    try {
        $productionCertificatePath = Resolve-ProductionCertificate
        $timestampUrl = Get-ProductionTimestampUrl
        try {
            $certificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new(
                $productionCertificatePath,
                $env:DAPPERCODE_WINDOWS_CERTIFICATE_PASSWORD,
                [Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet
            )
            try {
                if ($certificate.Subject -ne $publisher) {
                    throw ("The production certificate subject '$($certificate.Subject)' does not " +
                        "match DAPPERCODE_WINDOWS_PUBLISHER '$publisher'.")
                }
                $productionPublicCertificateBytes = $certificate.Export(
                    [Security.Cryptography.X509Certificates.X509ContentType]::Cert
                )
            } finally {
                $certificate.Dispose()
            }
        } catch {
            throw "Production signing certificate validation failed: $($_.Exception.Message)"
        }

        foreach ($artifact in $artifactsToSign) {
            Invoke-Native $signTool @(
                "sign", "/fd", "SHA256", "/tr", $timestampUrl, "/td", "SHA256",
                "/f", $productionCertificatePath,
                "/p", $env:DAPPERCODE_WINDOWS_CERTIFICATE_PASSWORD,
                $artifact
            )
        }

        $publicCertificate = Join-Path $distDirectory "DapperCode-Signing.cer"
        [IO.File]::WriteAllBytes($publicCertificate, $productionPublicCertificateBytes)
        Write-InstallGuidance -Bundle $bundle
        Write-Host "Production-signed Windows bundle: $bundle"
        Write-Host "Public signing certificate: $publicCertificate"
    } finally {
        if ($temporaryProductionCertificate -and
            (Test-Path $temporaryProductionCertificate -PathType Leaf)) {
            Remove-Item $temporaryProductionCertificate -Force
        }
        $env:DAPPERCODE_WINDOWS_CERTIFICATE_PATH = $null
        $env:DAPPERCODE_WINDOWS_CERTIFICATE_BASE64 = $null
        $env:DAPPERCODE_WINDOWS_CERTIFICATE_PASSWORD = $null
    }
    return
}

$msixVersion = ConvertTo-MsixVersion $version
if ($Operation -eq "Bundle") {
    $makeAppx = Find-WindowsSdkTool "makeappx.exe"
    $signTool = if ($SigningMode -eq "Test") {
        Find-WindowsSdkTool "signtool.exe"
    } else {
        $null
    }
    $architecturePackages = @(
        (Join-Path $packageDirectory "DapperCode-$version-x64.msix"),
        (Join-Path $packageDirectory "DapperCode-$version-arm64.msix")
    )
    foreach ($package in $architecturePackages) {
        if (-not (Test-Path $package -PathType Leaf)) {
            throw "Architecture package does not exist: $package"
        }
    }

    Remove-Item $bundleInputDirectory -Recurse -Force -ErrorAction SilentlyContinue
    New-Item $bundleInputDirectory -ItemType Directory -Force | Out-Null
    Copy-Item $architecturePackages[0] (Join-Path $bundleInputDirectory "DapperCode-x64.msix")
    Copy-Item $architecturePackages[1] (Join-Path $bundleInputDirectory "DapperCode-arm64.msix")
    $bundle = Join-Path $distDirectory "DapperCode-$version-x64_arm64.msixbundle"
    Invoke-Native $makeAppx @(
        "bundle", "/d", $bundleInputDirectory, "/p", $bundle, "/bv", $msixVersion, "/o"
    )

    if ($SigningMode -eq "Test") {
        $testCertificate = Get-TestSigningCertificate
        foreach ($artifact in @($architecturePackages) + @($bundle)) {
            Invoke-Native $signTool @(
                "sign", "/fd", "SHA256", "/s", "My",
                "/sha1", $testCertificate.Thumbprint, $artifact
            )
        }
        $publicCertificate = Join-Path $distDirectory "DapperCode-Signing.cer"
        Export-Certificate -Cert $testCertificate -FilePath $publicCertificate -Force |
            Out-Null
        Write-InstallGuidance -Bundle $bundle
    }

    if (-not $SkipInspection) {
        $inspectionParameters = @{
            BundlePath = $bundle
            SigningMode = $SigningMode
            ExpectedIdentity = $packageIdentity
            ExpectedPublisher = $publisher
        }
        if ($SigningMode -eq "Production") {
            $inspectionParameters["SkipSignature"] = $true
        }
        & (Join-Path $PSScriptRoot "test-desktop-windows.ps1") @inspectionParameters
        if ($LASTEXITCODE -ne 0) {
            throw "Windows desktop package inspection failed with code $LASTEXITCODE."
        }
    }

    Remove-Item $bundleInputDirectory -Recurse -Force
    Write-Host "Windows bundle: $bundle"
    return
}

$preferredProject = Join-Path $windowsDirectory `
    "src/DapperCode.Windows/DapperCode.Windows.csproj"
if (Test-Path $preferredProject -PathType Leaf) {
    $sourceProject = $preferredProject
} else {
    $projects = @(Get-ChildItem $windowsDirectory -Filter "*.csproj" -File -Recurse |
        Where-Object { $_.Name -match "Windows" })
    if ($projects.Count -ne 1) {
        throw "Expected one WinUI .csproj under $windowsDirectory; found $($projects.Count)."
    }
    $sourceProject = $projects[0].FullName
}
$dotnet = Resolve-PinnedDotNet
$makeAppx = if (-not $SkipBundle) {
    Find-WindowsSdkTool "makeappx.exe"
} else {
    $null
}
$signTool = if ($SigningMode -eq "Test" -and -not $SkipBundle) {
    Find-WindowsSdkTool "signtool.exe"
} else {
    $null
}

Remove-Item $distDirectory -Recurse -Force -ErrorAction SilentlyContinue
New-Item $packageDirectory -ItemType Directory -Force | Out-Null
New-Item $bundleInputDirectory -ItemType Directory -Force | Out-Null

try {
    # Build from a disposable source copy so generated notices never rewrite source.
    $stagedWindowsDirectory = Join-Path $distDirectory "build/windows-source"
    New-Item $stagedWindowsDirectory -ItemType Directory -Force | Out-Null
    Copy-Item (Join-Path $windowsDirectory "*") $stagedWindowsDirectory -Recurse
    @(Get-ChildItem $stagedWindowsDirectory -Directory -Recurse |
        Where-Object { $_.Name -in @("bin", "obj") }) |
        Sort-Object FullName -Descending |
        Remove-Item -Recurse -Force
    $projectRelativePath = $sourceProject.Substring($windowsDirectory.Length).TrimStart(
        [IO.Path]::DirectorySeparatorChar,
        [IO.Path]::AltDirectorySeparatorChar
    )
    $project = Join-Path $stagedWindowsDirectory $projectRelativePath

    $testCertificate = $null
    if ($SigningMode -eq "Test" -and -not $SkipBundle) {
        $testCertificate = Get-TestSigningCertificate
    }

    $architectures = @(
        @{
            Platform = "x64"
            Runtime = "win-x64"
            RustTarget = "x86_64-pc-windows-msvc"
            Machine = "x64"
        },
        @{
            Platform = "ARM64"
            Runtime = "win-arm64"
            RustTarget = "aarch64-pc-windows-msvc"
            Machine = "arm64"
        }
    )
    if ($Architecture -ne "All") {
        $architectures = @($architectures | Where-Object { $_.Machine -eq $Architecture })
    }

    $architecturePackages = @()
    foreach ($targetArchitecture in $architectures) {
        $rustTarget = $targetArchitecture.RustTarget
        if (-not $SkipRust) {
            Invoke-Native "cargo" @(
                "build", "--locked", "--release", "--target", $rustTarget,
                "--manifest-path", "apps/desktop/Cargo.toml"
            )
            Invoke-Native "cargo" @(
                "build", "--locked", "--release", "--target", $rustTarget,
                "--manifest-path", "services/rust-bridge/Cargo.toml"
            )
        }

        $operator = Join-Path $desktopDirectory `
            "target/$rustTarget/release/dappercode.exe"
        $bridge = Join-Path $root `
            "services/rust-bridge/target/$rustTarget/release/dappercode-bridge.exe"
        foreach ($binary in @($operator, $bridge)) {
            if (-not (Test-Path $binary -PathType Leaf)) {
                throw "Missing architecture-matched Rust executable: $binary"
            }
        }

        $stage = Join-Path $distDirectory "build/$($targetArchitecture.Machine)"
        New-Item $stage -ItemType Directory -Force | Out-Null
        Invoke-Native $dotnet @(
            "msbuild",
            $project,
            "/m",
            "/t:Restore",
            "/p:Configuration=Release",
            "/p:Platform=$($targetArchitecture.Platform)",
            "/p:RuntimeIdentifier=$($targetArchitecture.Runtime)",
            "/p:RepositoryRoot=$root\"
        )

        $nugetAssets = Join-Path (Split-Path -Parent $project) "obj/project.assets.json"
        if (-not (Test-Path $nugetAssets -PathType Leaf)) {
            throw "NuGet restore did not produce an assets file: $nugetAssets"
        }
        $notices = Join-Path (Split-Path -Parent $project) `
            "Licenses/THIRD_PARTY_NOTICES.txt"
        Invoke-Native "node" @(
            "scripts/generate-desktop-notices.mjs",
            "--platform", "windows",
            "--cargo-target", $rustTarget,
            "--nuget-assets", $nugetAssets,
            "--output", $notices
        )

        Invoke-Native $dotnet @(
            "msbuild",
            $project,
            "/m",
            "/t:Build",
            "/p:Configuration=Release",
            "/p:Platform=$($targetArchitecture.Platform)",
            "/p:RuntimeIdentifier=$($targetArchitecture.Runtime)",
            "/p:PublishTrimmed=true",
            "/p:PublishSingleFile=false",
            "/p:AppxBundle=Never",
            "/p:AppxPackageSigningEnabled=false",
            "/p:GenerateAppxPackageOnBuild=true",
            "/p:AppxPackageDir=$stage\",
            "/p:PackageOutputPath=$stage\",
            "/p:PackageIdentityName=$packageIdentity",
            "/p:PackagePublisher=$publisher",
            "/p:PackageVersion=$msixVersion",
            "/p:RepositoryRoot=$root\",
            "/p:RustOperatorPath=$operator",
            "/p:RustBridgePath=$bridge",
            "/p:SkipRustPayloadBuild=true"
        )

        $generatedPackage = Find-GeneratedPackage $stage
        $outputPackage = Join-Path $packageDirectory `
            "DapperCode-$version-$($targetArchitecture.Machine).msix"
        Copy-Item $generatedPackage $outputPackage
        $bundleInput = Join-Path $bundleInputDirectory `
            "DapperCode-$($targetArchitecture.Machine).msix"
        Copy-Item $generatedPackage $bundleInput
        $architecturePackages += $outputPackage
    }

    if ($SkipBundle) {
        Remove-Item (Join-Path $distDirectory "build") -Recurse -Force
        Remove-Item $bundleInputDirectory -Recurse -Force
        Write-Host "Unsigned Windows architecture package: $($architecturePackages[0])"
        return
    }

    $bundle = Join-Path $distDirectory "DapperCode-$version-x64_arm64.msixbundle"
    Invoke-Native $makeAppx @(
        "bundle", "/d", $bundleInputDirectory, "/p", $bundle, "/bv", $msixVersion, "/o"
    )

    if ($SigningMode -eq "Test") {
        $artifactsToSign = @($architecturePackages) + @($bundle)
        foreach ($artifact in $artifactsToSign) {
            Invoke-Native $signTool @(
                "sign", "/fd", "SHA256", "/s", "My",
                "/sha1", $testCertificate.Thumbprint, $artifact
            )
        }

        $publicCertificate = Join-Path $distDirectory "DapperCode-Signing.cer"
        Export-Certificate -Cert $testCertificate -FilePath $publicCertificate -Force |
            Out-Null
        Write-Warning (
            "The test certificate is not installed automatically. Installing this test-signed " +
            "bundle requires a one-time elevated import into LocalMachine\TrustedPeople."
        )
        Write-InstallGuidance -Bundle $bundle
    }

    if (-not $SkipInspection) {
        $inspectionParameters = @{
            BundlePath = $bundle
            SigningMode = $SigningMode
            ExpectedIdentity = $packageIdentity
            ExpectedPublisher = $publisher
        }
        if ($SigningMode -eq "Production") {
            $inspectionParameters["SkipSignature"] = $true
        }
        & (Join-Path $PSScriptRoot "test-desktop-windows.ps1") @inspectionParameters
        if ($LASTEXITCODE -ne 0) {
            throw "Windows desktop package inspection failed with code $LASTEXITCODE."
        }
    }

    Remove-Item (Join-Path $distDirectory "build") -Recurse -Force
    Remove-Item $bundleInputDirectory -Recurse -Force
    if ($SigningMode -eq "Production") {
        Write-Host "Unsigned production Windows bundle: $bundle"
        Write-Host "Run the dedicated Production Sign operation only after tests pass."
    } else {
        Write-Host "Test-signed Windows bundle: $bundle"
        Write-Host "Public signing certificate: $publicCertificate"
    }
} finally {
    if ($temporaryProductionCertificate -and
        (Test-Path $temporaryProductionCertificate -PathType Leaf)) {
        Remove-Item $temporaryProductionCertificate -Force
    }
}
