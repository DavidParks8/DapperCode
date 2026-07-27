# Changelog

All notable DapperCode changes are documented here.

## 0.1.0 - Unreleased

### Fixed

- A sub-agent now streams while it works instead of appearing only once it has finished. The bridge
	asks OpenCode which sessions a running thread has spawned, resumes the sub-agent's session as soon
	as it exists, and links it to the tool call that spawned it, so both the sub-agent's own thread and
	the card on the parent update live.
- A sub-agent now shows a sub-agent card while it works instead of an ordinary tool call. The
	bridge remembers that a tool call spawns a sub-agent from the update that names it, so agents
	that relabel the tool with the task description — OpenCode does — no longer hide the sub-agent
	until it finishes.
- The composer status no longer settles on "Ready" while an agent is still working. A thread with
	a live ACP run is reported as running, so a turn that goes quiet — which is what a parent thread
	does for the whole of a sub-agent run — keeps the header, run watchdog, and stop button honest.

### Changed

- Rebranded the mobile app, CLI, bridge, protocol extensions, persistence paths, and package
	identities as DapperCode.
- Reset native and hosted-service ownership so new Expo, Apple, Google, Firebase, npm, and store
	accounts can be connected explicitly.
- Removed the inherited payment SDK, tip purchase flow, payment environment variables, and
	offering configuration.
- Replaced the inherited automation with stack-specific build, test, coverage, artifact, npm, and
	mobile-release workflows.

### Removed

- Removed the predecessor static site, screenshots, store-submission material, historical plans,
	release notes, and hosted-service identifiers.
