# Privacy Policy

Last updated: October 26, 2026

## Overview

DapperCode is a companion app for connecting to a bridge service that you run on your own machine. The app is designed for trusted private networking, such as LAN, VPN, or Tailscale. It is not a public multi-tenant shell service.

On iOS, **On this iPhone** is an optional, separate mode for local model inference and app-private
file/Git tools. It does not require a desktop bridge or send local prompts to a cloud model.

## Information Processed

DapperCode can process:

- Chat prompts and assistant responses
- Bridge connection details you enter in the app
- Terminal command text and command output returned by your bridge
- Git repository status, diffs, commit messages, and related metadata
- File or image attachments you choose to send
- Downloaded model artifacts, app-private workspace files, local conversation/tool journals, and drafts
- GitHub device-authorization responses and a repository-access credential if you choose GitHub sign-in
- If notifications are enabled, an Expo push token, notification-routing identifiers, the bridge
  project folder name in generic notification text, and an optional assistant reply preview of at
  most 140 characters

## How Information Is Used

The app uses this information to:

- connect your device to your self-hosted bridge
- display and continue assistant threads
- execute approved terminal and Git workflows on infrastructure you control
- upload user-selected files and images to your own workflow
- deliver user-enabled turn-completion and approval notifications

## Storage and Retention

DapperCode does not define a separate cloud retention layer for your project data. Data is generally stored by services and infrastructure you control, including your local bridge, repository, logs, caches, and any model providers or integrations that you configure.

On-device workspaces, conversations, and drafts live in the app's private iOS storage. Downloaded
weights are excluded from device backups; other app data may be included according to iOS backup
settings. GitHub tokens use a separate device-only Keychain service, are not supplied to model
tools, and are removed locally on sign-out. Uninstalling the app is not a substitute for revoking
its GitHub OAuth authorization in your account settings.

## Sharing

DapperCode does not include advertising SDKs. Data may be transmitted to third-party model or infrastructure providers only when you configure and use those services as part of your own setup.

Model downloads contact the selected catalog artifact host (currently Hugging Face). Optional
GitHub sign-in contacts GitHub. HTTPS clone/push contacts the repository origin and push transmits
the selected Git history and committed content. Local tools have no per-tool approval dialogs and
can push when authorized; review the workspace and its permissions. Offline inference and local
file/Git actions have no automatic bridge or cloud fallback.

When notifications are enabled, the self-hosted bridge sends the device push token, notification
title/body, and routing/deep-link identifiers through the Expo Push Notification Service and then
APNs or FCM. A completion notification can include the last non-empty line of an assistant reply,
collapsed and capped at 140 characters. Generic completion and approval text can include the bridge
project folder name. Prompts, code, diffs, tool output, and full conversations are not included in
push payloads. Notifications can be disabled in Settings.

## Security

Security depends on how you configure your bridge and network. The app is intended for private LAN,
VPN, or private-overlay use and the bridge must not be exposed directly to the public internet.
Bridge authentication remains required on private networks. You are responsible for protecting
bridge tokens, provider credentials, repository access, and device access.

## Your Responsibility

You are responsible for:

- operating the bridge only on systems you own or are authorized to control
- securing your network path and credentials
- reviewing commands, approvals, and repository actions before execution
- choosing appropriate on-device workspaces and reviewing locally generated changes before sharing them

## Contact

For support, use the project support channel:

https://github.com/DavidParks8/DapperCode/issues
