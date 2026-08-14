[CmdletBinding()]
param(
    [string]$BundlePath,
    [ValidateSet("Test", "Production")]
    [string]$SigningMode = $(if ($env:DAPPERCODE_WINDOWS_SIGNING_MODE) {
        $env:DAPPERCODE_WINDOWS_SIGNING_MODE
    } else {
        "Test"
    }),
    [string]$ExpectedIdentity = $(if ($env:DAPPERCODE_WINDOWS_PACKAGE_IDENTITY) {
        $env:DAPPERCODE_WINDOWS_PACKAGE_IDENTITY
    } else {
        "DapperCode.Desktop"
    }),
    [string]$ExpectedPublisher,
    [switch]$SourceOnly,
    [switch]$SkipSignature
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$root = Split-Path -Parent $PSScriptRoot
$windowsDirectory = Join-Path $root "apps/desktop/windows"
$distDirectory = Join-Path $root "apps/desktop/dist/windows"

if ($SkipSignature -and $SigningMode -ne "Production") {
    throw "-SkipSignature is only valid when inspecting an unsigned Production package."
}

if (-not $ExpectedPublisher) {
    if ($SigningMode -eq "Production") {
        if (-not $env:DAPPERCODE_WINDOWS_PUBLISHER) {
            throw "Production inspection requires DAPPERCODE_WINDOWS_PUBLISHER."
        }
        $ExpectedPublisher = $env:DAPPERCODE_WINDOWS_PUBLISHER
    } else {
        $ExpectedPublisher = "CN=DapperCode"
    }
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
        throw "Windows SDK tool '$Name' was not found."
    }
    return $tool.FullName
}

function Get-PeMachine {
    param([Parameter(Mandatory = $true)][string]$Path)

    $stream = [IO.File]::OpenRead($Path)
    $reader = [IO.BinaryReader]::new($stream)
    try {
        if ($reader.ReadUInt16() -ne 0x5A4D) {
            throw "$Path is not a PE executable."
        }
        $stream.Position = 0x3C
        $peOffset = $reader.ReadUInt32()
        $stream.Position = $peOffset
        if ($reader.ReadUInt32() -ne 0x00004550) {
            throw "$Path has an invalid PE signature."
        }
        return $reader.ReadUInt16()
    } finally {
        $reader.Dispose()
        $stream.Dispose()
    }
}

function Test-ForbiddenRuntimeContent {
    param([Parameter(Mandatory = $true)][string]$Path)

    $stream = [IO.File]::OpenRead($Path)
    $buffer = [byte[]]::new(1MB)
    $overlap = ""
    try {
        while (($read = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
            $content = $overlap + [Text.Encoding]::ASCII.GetString($buffer, 0, $read)
            if ($content -match '(?i)slint|node_modules|npm-shrinkwrap\.json|package-lock\.json') {
                return $true
            }
            $overlap = if ($content.Length -gt 64) {
                $content.Substring($content.Length - 64)
            } else {
                $content
            }
        }
        return $false
    } finally {
        $stream.Dispose()
    }
}

function Assert-PackagePayload {
    param(
        [Parameter(Mandatory = $true)][string]$Directory,
        [Parameter(Mandatory = $true)][string]$Architecture
    )

    [xml]$manifest = Get-Content (Join-Path $Directory "AppxManifest.xml") -Raw
    $identity = $manifest.Package.Identity
    if ($identity.Name -ne $ExpectedIdentity) {
        throw "Unexpected package identity '$($identity.Name)' for $Architecture."
    }
    if ($identity.Publisher -ne $ExpectedPublisher) {
        throw "Unexpected package publisher '$($identity.Publisher)' for $Architecture."
    }
    if ($identity.ProcessorArchitecture.ToLowerInvariant() -ne $Architecture) {
        throw "Package architecture is '$($identity.ProcessorArchitecture)', expected '$Architecture'."
    }

    $required = @(
        "DapperCode.exe",
        "bin/dappercode.exe",
        "bin/dappercode-bridge.exe",
        "Licenses/DapperCode-LICENSE.txt",
        "Licenses/QRCoder-LICENSE.txt",
        "Licenses/THIRD_PARTY_NOTICES.txt",
        "Assets/AppIcon.ico",
        "Assets/StoreLogo.png",
        "Assets/Square44x44Logo.png",
        "Assets/Square150x150Logo.png",
        "Assets/Wide310x150Logo.png",
        "Assets/SplashScreen.png",
        "Assets/TrayActive.ico",
        "Assets/TrayIdle.ico"
    )
    foreach ($relative in $required) {
        $path = Join-Path $Directory $relative
        if (-not (Test-Path $path -PathType Leaf)) {
            throw "MSIX payload is missing $relative for $Architecture."
        }
    }

    $expectedMachine = if ($Architecture -eq "x64") { 0x8664 } else { 0xAA64 }
    foreach ($relative in @(
        "DapperCode.exe",
        "bin/dappercode.exe",
        "bin/dappercode-bridge.exe"
    )) {
        $machine = Get-PeMachine (Join-Path $Directory $relative)
        if ($machine -ne $expectedMachine) {
            throw ("$relative has PE machine 0x{0:X4}, expected 0x{1:X4} for $Architecture." `
                -f $machine, $expectedMachine)
        }
    }

    $forbiddenNames = @(
        "node", "node.exe", "npm", "npm.cmd", "npm.exe", "npx", "npx.cmd", "npx.exe",
        "package.json", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock",
        "pnpm-lock.yaml"
    )
    $forbidden = @(Get-ChildItem $Directory -Recurse -Force |
        Where-Object {
            $_.Name.ToLowerInvariant() -in $forbiddenNames -or
            $_.FullName -match '[\\/]node_modules[\\/]' -or
            $_.Extension -in @(".js", ".cjs", ".mjs") -or
            $_.Name -match '(?i)slint'
        })
    if ($forbidden.Count -gt 0) {
        throw "MSIX payload contains forbidden Node/npm/JavaScript/Slint files:`n$($forbidden.FullName -join "`n")"
    }

    $inspectableExtensions = @(
        ".config", ".dll", ".exe", ".json", ".manifest", ".txt", ".winmd", ".xml"
    )
    $forbiddenContent = @()
    foreach ($file in Get-ChildItem $Directory -Recurse -File |
        Where-Object { $_.Extension.ToLowerInvariant() -in $inspectableExtensions }) {
        if (Test-ForbiddenRuntimeContent $file.FullName) {
            $forbiddenContent += $file.FullName
        }
    }
    if ($forbiddenContent.Count -gt 0) {
        throw "MSIX payload contains forbidden runtime references:`n$($forbiddenContent -join "`n")"
    }
}

$sourceFiles = @(Get-ChildItem $windowsDirectory -Recurse -File |
    Where-Object { $_.FullName -notmatch '[\\/](bin|obj)[\\/]' })
if ($sourceFiles.Count -eq 0) {
    throw "The WinUI desktop source is missing from $windowsDirectory."
}
$forbiddenSource = @($sourceFiles |
    Where-Object {
        $_.FullName -match '[\\/]node_modules[\\/]' -or
        $_.Extension -in @(".js", ".cjs", ".mjs") -or
        $_.Name -match '(?i)slint'
    })
if ($forbiddenSource.Count -gt 0) {
    throw "WinUI source contains a forbidden runtime dependency:`n$($forbiddenSource.FullName -join "`n")"
}
if ($SourceOnly) {
    Write-Host "Windows desktop source policy passed."
    exit 0
}
if ($env:OS -ne "Windows_NT") {
    throw "MSIX inspection must run on Windows."
}

if (-not $BundlePath) {
    $bundles = @(Get-ChildItem $distDirectory -Filter "*.msixbundle" -File)
    if ($bundles.Count -ne 1) {
        throw "Expected one MSIX bundle under $distDirectory; found $($bundles.Count)."
    }
    $BundlePath = $bundles[0].FullName
}
$BundlePath = [IO.Path]::GetFullPath($BundlePath)
if (-not (Test-Path $BundlePath -PathType Leaf)) {
    throw "MSIX bundle does not exist: $BundlePath"
}

$makeAppx = Find-WindowsSdkTool "makeappx.exe"
$signTool = if ($SkipSignature) {
    $null
} else {
    Find-WindowsSdkTool "signtool.exe"
}
$certificateUtility = if ($SigningMode -eq "Test") {
    (Get-Command "certutil.exe" -ErrorAction Stop).Source
} else {
    $null
}
$inspectionRoot = Join-Path $distDirectory ".inspection"
$temporaryTrustedRootThumbprint = $null
Remove-Item $inspectionRoot -Recurse -Force -ErrorAction SilentlyContinue
New-Item $inspectionRoot -ItemType Directory -Force | Out-Null

try {
    Write-Host "Inspecting Windows package signatures and bundle contents."
    if ($SigningMode -eq "Test") {
        $certificatePath = Join-Path $distDirectory "DapperCode-Signing.cer"
        if (-not (Test-Path $certificatePath -PathType Leaf)) {
            throw "Test signing certificate does not exist: $certificatePath"
        }
        $certificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new(
            $certificatePath
        )
        try {
            $trustedRootPath = "Cert:\CurrentUser\Root\$($certificate.Thumbprint)"
            if (-not (Test-Path $trustedRootPath)) {
                Write-Host "Temporarily trusting the test signer for package verification."
                Invoke-Native $certificateUtility @(
                    "-user", "-f", "-addstore", "Root", $certificatePath
                )
                $temporaryTrustedRootThumbprint = $certificate.Thumbprint
            }
        } finally {
            $certificate.Dispose()
        }
    }

    if (-not $SkipSignature) {
        Write-Host "Verifying bundle signature."
        Invoke-Native $signTool @("verify", "/pa", "/all", $BundlePath)
    }
    $architecturePackages = @(Get-ChildItem (Join-Path $distDirectory "packages") `
        -Filter "*.msix" -File)
    if ($architecturePackages.Count -ne 2) {
        throw "Expected two architecture MSIX packages; found $($architecturePackages.Count)."
    }
    if (-not $SkipSignature) {
        foreach ($package in $architecturePackages) {
            Write-Host "Verifying signature $($package.Name)."
            Invoke-Native $signTool @("verify", "/pa", "/all", $package.FullName)
        }
    }

    $bundleContents = Join-Path $inspectionRoot "bundle"
    Invoke-Native $makeAppx @(
        "unbundle", "/p", $BundlePath, "/d", $bundleContents, "/o"
    )
    [xml]$bundleManifest = Get-Content `
        (Join-Path $bundleContents "AppxMetadata/AppxBundleManifest.xml") -Raw
    $bundleIdentity = $bundleManifest.Bundle.Identity
    if ($bundleIdentity.Name -ne $ExpectedIdentity) {
        throw "Unexpected bundle identity '$($bundleIdentity.Name)'."
    }
    if ($bundleIdentity.Publisher -ne $ExpectedPublisher) {
        throw "Unexpected bundle publisher '$($bundleIdentity.Publisher)'."
    }
    $packageVersions = @($bundleManifest.Bundle.Packages.Package |
        ForEach-Object { $_.Version } |
        Sort-Object -Unique)
    if ($packageVersions.Count -ne 1 -or $bundleIdentity.Version -ne $packageVersions[0]) {
        throw ("Bundle version '$($bundleIdentity.Version)' does not match its package version " +
            "'$($packageVersions -join ",")'.")
    }
    $bundleArchitectures = @($bundleManifest.Bundle.Packages.Package |
        ForEach-Object { $_.Architecture.ToLowerInvariant() } |
        Sort-Object -Unique)
    if (($bundleArchitectures -join ",") -ne "arm64,x64") {
        throw "Bundle architectures are '$($bundleArchitectures -join ",")', expected 'arm64,x64'."
    }

    $bundlePackages = @(Get-ChildItem $bundleContents -File |
        Where-Object { $_.Extension -in @(".msix", ".appx") })
    if ($bundlePackages.Count -ne 2) {
        throw "Expected two packages in the bundle; found $($bundlePackages.Count)."
    }
    $inspectedArchitectures = @()
    $bundlePackageHashes = @{}
    foreach ($package in $bundlePackages) {
        Write-Host "Inspecting payload $($package.Name)."
        $packageDirectory = Join-Path $inspectionRoot $package.BaseName
        Invoke-Native $makeAppx @(
            "unpack", "/p", $package.FullName, "/d", $packageDirectory, "/o"
        )
        [xml]$manifest = Get-Content (Join-Path $packageDirectory "AppxManifest.xml") -Raw
        $architecture = $manifest.Package.Identity.ProcessorArchitecture.ToLowerInvariant()
        Assert-PackagePayload $packageDirectory $architecture
        $inspectedArchitectures += $architecture
        $bundlePackageHashes[$architecture] = (
            Get-FileHash $package.FullName -Algorithm SHA256
        ).Hash
    }
    if ((@($inspectedArchitectures | Sort-Object -Unique) -join ",") -ne "arm64,x64") {
        throw "Did not inspect both x64 and ARM64 installed payloads."
    }

    if ($SkipSignature) {
        $standaloneArchitectures = @()
        foreach ($package in $architecturePackages) {
            $packageDirectory = Join-Path $inspectionRoot "standalone-$($package.BaseName)"
            Invoke-Native $makeAppx @(
                "unpack", "/p", $package.FullName, "/d", $packageDirectory, "/o"
            )
            [xml]$manifest = Get-Content (Join-Path $packageDirectory "AppxManifest.xml") -Raw
            $architecture = $manifest.Package.Identity.ProcessorArchitecture.ToLowerInvariant()
            Assert-PackagePayload $packageDirectory $architecture
            $standaloneArchitectures += $architecture

            $standaloneHash = (Get-FileHash $package.FullName -Algorithm SHA256).Hash
            if (-not $bundlePackageHashes.ContainsKey($architecture) -or
                $standaloneHash -ne $bundlePackageHashes[$architecture]) {
                throw (
                    "Standalone $architecture package does not match the inspected package " +
                    "embedded in the unsigned bundle."
                )
            }
        }
        if ((@($standaloneArchitectures | Sort-Object -Unique) -join ",") -ne "arm64,x64") {
            throw "Did not inspect both unsigned standalone architecture packages."
        }
        Write-Host (
            "Unsigned Windows bundle identity, architectures, payload policy, and standalone " +
            "package equivalence passed."
        )
    } else {
        Write-Host "Windows bundle identity, signatures, architectures, and payload policy passed."
    }
} finally {
    Remove-Item $inspectionRoot -Recurse -Force -ErrorAction SilentlyContinue
    if ($temporaryTrustedRootThumbprint) {
        Invoke-Native $certificateUtility @(
            "-user", "-delstore", "Root", $temporaryTrustedRootThumbprint
        )
    }
}
