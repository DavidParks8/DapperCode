# Product

<!-- impeccable:product-schema 1 -->

## Platform

adaptive

_Inferred from repository evidence: the Expo client ships iOS, Android, and web, with native iOS and
Android projects and platform-specific interaction requirements._

## Users

Software developers and maintainers who need to monitor and control ACP-compatible coding agents
from a phone while their repositories and agent processes remain on a trusted desktop or private
network.

## Product Purpose

DapperCode gives developers a dependable mobile control surface for starting, guiding, and
reviewing coding-agent work through an authenticated local bridge. Success means users can move
between workspaces and sessions, compose requests, review progress, and respond to agent prompts
without losing context or weakening the bridge's private-network security model.

## Positioning

_Inferred from repository evidence:_ unlike a public multi-tenant agent service, DapperCode keeps
repositories, installed ACP agents, process control, and bridge state on infrastructure the
developer controls. The mobile client is an authenticated remote control for that private host
environment, not the execution environment itself.

## Operating Context

_Inferred from repository evidence:_

- A developer first configures a desktop workspace, registers an already-installed ACP executable,
  starts its authenticated Rust bridge, and pairs the mobile client by QR code or credentials.
- The mobile client connects over a trusted LAN, VPN, or Tailscale network; `localhost` on a physical
  phone is not the desktop bridge.
- Core work moves between bridge profiles, workspaces, sessions, transcripts, agent prompts,
  approvals, Git operations, local browser previews, and connection recovery.
- Push notifications return developers to relevant work when a turn finishes or an approval needs
  attention while the app is backgrounded.

## Capabilities and Constraints

_Inferred from repository evidence:_

- The mobile client supports iOS, Android, and web through Expo and React Native.
- Expo Router URLs identify bridge profiles, chats, and nested agent threads; navigation state does
  not belong in the product-state store.
- The desktop operator owns bridge setup and lifecycle. The bridge registers and hashes an
  installed ACP executable; it does not install agents or package-manager distributions.
- The bridge is authenticated private-network software and must not be presented as internet-safe
  by default.
- App-owned configuration, secrets, logs, caches, and runtime state stay in central app data
  locations, never in a user's repository. Bridge tokens must not appear in route URLs or repository
  files.
- Parallel workspaces use separate profiles and allocated ports rather than a shared hard-coded
  bridge endpoint.

## Brand Commitments

- The product name is **DapperCode**.
- The established personality is focused, native, and trustworthy: a precise operational tool that
  stays out of the developer's task.
- Avoid decorative SaaS-dashboard styling, ornamental AI visuals, novelty interactions, and
  consumer-chat conventions that obscure session state or make consequential actions feel casual.
- Preserve the existing brand assets under `apps/mobile/assets/brand`.

## Evidence on Hand

_Repository evidence available to future work:_

- Product and architecture overview: `README.md`
- Setup, security boundaries, pairing, and operations: `docs/setup-and-operations.md`
- Mobile state and navigation contract: `docs/mobile-state.md`
- Push behavior and notification lifecycle: `docs/push-notifications.md`
- Browser-preview scope and limitations: `docs/browser-preview-limitations.md`
- Privacy and terms: `docs/privacy-policy.md`, `docs/terms-of-service.md`
- App icons, marks, splash art, and favicon: `apps/mobile/assets/brand`

No customer testimonials, usage benchmarks, press claims, pricing claims, or market-leadership
evidence are present in the repository; future work must not fabricate them.

## Product Principles

- Preserve task continuity: drafts and in-progress work survive navigation and state transitions.
- Make state changes explicit: move users between sessions only after a clear action or confirmed
  system event.
- Prefer platform-native familiarity: preserve each operating system's expected navigation,
  controls, feedback, and accessibility behavior.
- Keep operational context legible: workspace, session, agent, and connection state remain easy to
  understand.
- Earn trust through restraint: prioritize reliable behavior, clear hierarchy, and secure defaults
  over decoration.

## Accessibility & Inclusion

Target WCAG 2.2 AA. Support VoiceOver and equivalent platform assistive technologies with meaningful
labels, hints, roles, and state; preserve readability under text scaling; avoid color-only
communication; maintain adequate contrast and touch targets; and respect reduced-motion
preferences.
