# DapperCode Desktop

## Register

product

## Users

Developers who control ACP-compatible coding agents from a phone while their repositories and agent
processes remain on a trusted computer and private network.

## Product Purpose

Provide a native control surface for secure bridge setup, pairing, status, and lifecycle management.
The desktop app should make the local host dependable and unobtrusive while the developer works from
mobile.

## Brand Personality

Native, trustworthy, and focused. DapperCode should feel like a well-behaved part of the installed
desktop operating system rather than a themed cross-platform utility.

## Anti-references

- Custom-themed tray apps that fight system appearance or invent unfamiliar controls.
- Decorative motion or blocking lifecycle feedback that interrupts developer flow.
- Browser-shell, JavaScript, or Slint desktop surfaces.
- Cloud-dashboard conventions that imply the private bridge is safe for public internet exposure.

## Design Principles

- Prefer native platform behavior over novelty.
- Keep lifecycle actions immediate, predictable, and recoverable.
- Make security and ownership boundaries legible without adding friction.
- Preserve developer context across workspaces and parallel worktrees.
- Show actionable operational state with familiar system controls.
- Keep setup, pairing, workspace, status, logs, and lifecycle capabilities at full parity while each
  shell follows its own platform conventions.

## Accessibility & Inclusion

Use each platform's standard native semantics—AppKit/SwiftUI on macOS and WinUI on Windows—so
keyboard navigation, screen readers, system contrast, text scaling, and reduced-motion preferences
remain available. Add explicit accessibility labels when an icon or generated image does not
communicate its meaning to assistive technology.
