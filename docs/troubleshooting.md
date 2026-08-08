# Troubleshooting

## Desktop App Does Not Open

Verify the bundle and launch it directly:

```bash
codesign --verify --deep --strict apps/desktop/dist/DapperCode.app
open apps/desktop/dist/DapperCode.app
```

Local builds are ad-hoc signed. Downloaded public builds additionally require Apple notarization.

## Operator Is Unavailable

The native shell expects:

```text
DapperCode.app/Contents/Resources/bin/dappercode
DapperCode.app/Contents/Resources/bin/dappercode-bridge
```

Rebuild or reinstall the app if either file is missing. The app does not fall back to npm, Node.js,
or shell scripts.

## Agent Is Not Found

Use the native file picker or inspect discovery directly:

```bash
npm run operator -- discover-agent --agent-id opencode
```

Install the ACP-capable agent independently, then select its executable. DapperCode setup registers
and hashes an existing executable; it does not install packages.

## Tailscale Has No Address

Open Tailscale and confirm it is connected:

```bash
tailscale ip -4
```

Alternatively choose **Local network** and enter the Mac's LAN IPv4 address.

## Bridge Will Not Start

Inspect status and logs:

```bash
npm run operator -- status --workspace /path/to/repository --human
open "$HOME/Library/Application Support/dev.dappercode.desktop/broker.log"
```

Common causes:

- the registered agent executable moved or changed after setup
- the configured host/port is already in use
- the workspace has no profile yet, or its stored agent manifest is missing or invalid
- Tailscale/LAN connectivity changed

Rerun setup after moving or upgrading an agent so its canonical path and SHA-256 digest are refreshed.

## Stop or Restart After Config Damage

The Rust operator verifies its private ownership record independently of current config. It can stop
a live owned broker even when the stored configuration needs repair:

```bash
npm run operator -- stop --workspace /path/to/repository
```

Repair setup before starting again.

## Device Cannot Connect

- Use the bridge URL shown by the desktop app.
- Keep the Mac and device on the same LAN/VPN or Tailscale network.
- Do not use `localhost` on a physical device.
- Confirm the bearer token or scan the current pairing QR.
- Keep the bridge private; do not expose it on the public internet.

## Expo Cannot Find Secure Configuration

Configure the bridge through the desktop app or Rust operator first, then run:

```bash
npm run mobile
```

The Expo script reads the bridge host from the central `config.json`, falling back to a repo-root
`.env.secure` for the `npm run bridge` development flow.

## macOS Asks for Keychain Access After a Rebuild

The app is ad-hoc code-signed, so `npm run desktop:build:macos` produces a new code signature and
macOS treats it as a different application. Approve the single shared-vault prompt, or set
`DAPPERCODE_SECRETS_BACKEND=file` to keep the credential vault in a `0600` file under `secrets/` in
the data directory instead. The desktop app shows which backend is in use.

## A Port Is Already Taken

The first workspace allocates the public broker port; later workspaces share it and receive distinct
preview ports. If the broker cannot bind after a migration, stop any legacy DapperCode process
and retry. A compatibility alias that cannot bind is logged in `broker.log`; re-scan that
workspace's current pairing QR to replace the old URL with the canonical broker URL.

## Removing a Workspace's Configuration

Stop the broker, then:

```bash
npm run operator -- forget --workspace /path/to/repository
```

That removes the profile from `config.json`, deletes its token, and removes its profile directory.
Deleting the whole data directory resets every workspace and requires running setup again.
