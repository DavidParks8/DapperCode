# Troubleshooting

## macOS App Does Not Open

Verify the bundle and launch it directly:

```bash
codesign --verify --deep --strict apps/desktop/dist/DapperCode.app
open apps/desktop/dist/DapperCode.app
```

Local builds are ad-hoc signed. Downloaded public builds additionally require Apple notarization.

## Windows Package Does Not Install or Open

Windows 11 local builds are test-signed. From an elevated terminal, install the emitted certificate
in Local Machine **Trusted People**, then open the x64/ARM64 MSIX bundle in App Installer. Do not
trust a test certificate from a checkout you do not control. A production package must pass through
the protected, main-only signing job and use a distribution-trusted certificate; its intermediate
unsigned artifact is not installable release output.

From `apps/desktop/dist/windows`, the equivalent PowerShell commands are:

```powershell
certutil -addstore TrustedPeople .\DapperCode-Signing.cer
Add-AppxPackage .\DapperCode-<version>-x64_arm64.msixbundle
```

The one-time elevated certificate import is needed only for local test-signed builds. Production
packages signed by an already trusted publisher install and run without administrator rights.

If DapperCode appears to close immediately, check the notification area: closing its window keeps
the tray-first app running. Use the tray icon to show the window or choose **Quit** to stop the broker
and app.

## Operator Is Unavailable

The macOS shell expects:

```text
DapperCode.app/Contents/Resources/bin/dappercode
DapperCode.app/Contents/Resources/bin/dappercode-bridge
```

Rebuild or reinstall the app if either file is missing. The app does not fall back to Node.js,
package managers, or shell scripts.

The Windows package likewise carries `dappercode.exe` and `dappercode-bridge.exe` in its private
runtime payload. Repair or reinstall the MSIX bundle if the app reports that either runtime
executable is unavailable.

## Agent Is Not Found

Use the native file picker or inspect discovery directly:

```bash
pnpm run operator discover-agent --agent-id opencode
```

Install the ACP-capable agent independently, then select its executable. DapperCode setup registers
and hashes an existing executable; it does not install packages.

## Tailscale Has No Address

Open Tailscale and confirm it is connected:

```bash
tailscale ip -4
```

Alternatively choose **Local network** and enter the desktop computer's LAN IPv4 address.

## Bridge Will Not Start

Inspect status and logs:

```bash
pnpm run operator status --workspace /path/to/repository --human
open "$HOME/Library/Application Support/dev.dappercode.desktop/broker.log"
```

Common causes:

- the registered agent executable moved or changed after setup
- the configured host/port is already in use
- the workspace has no profile yet, or its stored agent manifest is missing or invalid
- Tailscale/LAN connectivity changed

Rerun setup after moving or upgrading an agent so its canonical path and SHA-256 digest are refreshed.

On Windows, logs and non-secret state are under `%APPDATA%\DapperCode`; bearer tokens are held in
Windows Credential Manager rather than `config.json`.

## Stop or Restart After Config Damage

The Rust operator verifies its private ownership record independently of current config. It can stop
a live owned broker even when the stored configuration needs repair:

```bash
pnpm run operator stop --workspace /path/to/repository
```

Repair setup before starting again.

## Device Cannot Connect

- Use the bridge URL shown by the desktop app.
- Keep the desktop computer and device on the same LAN/VPN or Tailscale network.
- Do not use `localhost` on a physical device.
- Confirm the bearer token or scan the current pairing QR.
- Keep the bridge private; do not expose it on the public internet.

## Expo Cannot Find Secure Configuration

Configure the bridge through the desktop app or Rust operator first, then run:

```bash
pnpm run mobile
```

The Expo script reads the bridge host from the central `config.json`, falling back to a repo-root
`.env.secure` for the `pnpm run bridge` development flow.

## macOS Asks for Keychain Access After a Rebuild

The app is ad-hoc code-signed, so `pnpm run desktop:build:macos` produces a new code signature and
macOS treats it as a different application. Approve the single shared-vault prompt, or set
`DAPPERCODE_SECRETS_BACKEND=file` to keep the credential vault in a `0600` file under `secrets/` in
the data directory instead. The desktop app shows which backend is in use.

## Windows Launch at Login Does Not Run

The packaged `DapperCodeStartup` task is disabled on install and changes only after the user opts in
through **Launch at login**. Also check **Settings > Apps > Startup**: Windows or an administrator
policy can disable DapperCode there. Re-enable it in Windows Settings or toggle the in-app setting
again. Startup intentionally opens only the tray icon; use that icon to show the main window.

## Windows Credential Manager Is Unavailable

DapperCode normally stores one bounded Generic Credential per workspace in Windows Credential
Manager under service `dev.dappercode.desktop`, account
`bridge-auth-token:v2:<sha256-profile-id>`. The fixed `bridge-auth-vault:v2` marker records that
layout; older shared vaults are migrated automatically. The app reports the active backend. If
initial Credential Manager persistence is unavailable, set `DAPPERCODE_SECRETS_BACKEND=file` only if
you accept the private-file fallback under `%APPDATA%\DapperCode\secrets`. A later failure to update
existing Credential Manager entries fails closed rather than silently moving credentials to a file.

## A Port Is Already Taken

The first workspace allocates the public broker port; later workspaces share it and receive distinct
preview ports. If the broker cannot bind after a migration, stop any legacy DapperCode process
and retry. A compatibility alias that cannot bind is logged in `broker.log`; re-scan that
workspace's current pairing QR to replace the old URL with the canonical broker URL.

## Removing a Workspace's Configuration

Stop the broker, then:

```bash
pnpm run operator forget --workspace /path/to/repository
```

That removes the profile from `config.json`, deletes its token, and removes its profile directory.
On macOS and file-backed installations, deleting the whole data directory resets every workspace.
On Windows Credential Manager installations, use the complete reset sequence below so credentials
are removed before their profile inventory is lost.

## Repairing or Uninstalling on Windows

First choose **Quit** from the tray menu. Use **Settings → Apps → Installed apps** to repair, reset,
or uninstall DapperCode. Reinstalling repairs missing packaged files.

For a complete manual reset, remove credentials **before** deleting `%APPDATA%\DapperCode`; the
configuration file is the inventory that identifies which per-workspace credentials exist. In
**Credential Manager → Windows Credentials**, remove every Generic Credential for service
`dev.dappercode.desktop` whose account is:

- `bridge-auth-token:v2:<sha256-profile-id>` for every workspace;
- `bridge-auth-vault:v2`, the current layout marker;
- `bridge-auth-vault:v1`, the legacy shared vault, if present; or
- `bridge-auth-token:<profile-id>`, any legacy per-workspace entry.

Only after those entries are gone, delete `%APPDATA%\DapperCode`. This permanently removes workspace
configuration, tokens, logs, attachments, and session state, so every mobile device must pair again.
