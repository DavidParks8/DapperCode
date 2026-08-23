# Realtime Streaming Limitations And Mitigations

Last reviewed: July 19, 2026

## Current Architecture

1. The mobile app connects to the Rust bridge WebSocket at `/rpc`.
2. The Rust bridge starts installed agents from the validated local `ACP_AGENT_MANIFEST`.
3. `AgentManager` owns agent transports and session routing.
4. ACP session notifications become typed `CanonicalEvent` values.
5. The bridge projects canonical events into AG-UI envelopes and replayable control notifications.

The bridge does not discover or install remote agents. Desktop setup validates an already-installed
ACP executable and writes the local manifest consumed by Rust.

## Live Delivery And Replay

- Canonical ACP events are the internal authority for queue coordination, push delivery, and AG-UI
  projection.
- Editing the next queued message pauses bridge auto-dispatch until the client commits the revised
  text or resumes the original item; queue order and non-text turn input remain intact.
- Outward WebSocket notifications receive monotonically increasing `eventId` values and are stored
  in a bounded replay buffer.
- `protocolVersion` and the per-process `streamId` let mobile distinguish a reconnect from a bridge
  restart.
- Mobile requests `bridge/events/replay` after reconnect, buffers concurrent live notifications,
  and emits numbered events in contiguous order.
- A stream change, replay eviction, or detected gap triggers ACP session snapshot convergence.
- Snapshot convergence is stream-wide: mobile freezes post-watermark delivery, expands its recovery
   set with `thread/loaded/list`, and refreshes every bridge-loaded or locally tracked thread plus
   queues, pending approvals, pending user inputs, and negotiated agent descriptors before it
   acknowledges the watermark. A failed refresh keeps the barrier in place and retries without a
   partial acknowledgement.

Historical threads that are neither loaded by the bridge nor tracked by mobile are not loaded only
because replay history was evicted. They have no live state in the current event stream and remain
available through the normal thread list and open-thread flow.

Replay is process-local. A full bridge restart creates a new stream and discards the old replay
buffer and in-memory message queues. Installed agent manifests and agent-owned durable sessions are
not deleted by that restart.

## Sub-Agent Streaming

An agent only forwards updates for sessions the client has asked for, so a sub-agent's work is
invisible until the bridge reads its session. A foreground `task` tool names the child session it
spawned only once that child has finished, which is far too late to watch it work.

Where an agent can be asked which sessions it has spawned, the bridge attaches during the run
instead:

1. A task tool starting is recognised from the first update that names it, and its classification is
   remembered so a later rename cannot hide it.
2. The agent is polled for sessions whose parent is the running thread. Several sub-agents at once
   are told apart by the description the agent puts on both the child session and the tool call.
   A task tool is called "task" until it finishes, so usually there is no description to match on;
   the children the parent already had when polling started are recorded instead, which makes a
   child that appears afterwards the one this tool call spawned. Without that, a parent that already
   owned an unclaimed child could never resolve its sub-agent while it ran.
3. The discovered child is indexed and linked to the tool call that spawned it, immediately making
   the parent card openable.
4. The child is resumed and announced with `thread/subagent/adopted`. Resuming starts its updates
   flowing only after the link exists, so replayed progress reaches the card and mobile transcript.

While a sub-agent runs, its card reports the last tool it actually ran rather than the response it
is narrating, and an update that would not change the card is dropped. A card that repaints on every
streamed token resizes the transcript under the reader's finger, which cancels the tap that opens
the sub-agent.

This is supported for OpenCode, which serves the session tree over an HTTP port the bridge assigns
when it starts the agent. The port is allocated per agent process rather than fixed, so parallel
worktrees keep working. OpenCode exits if it is handed a port that is already taken, so a failed
start is retried without one — losing sub-agent streaming rather than the agent.

## Agent-to-Agent Messaging

Eligible managed sessions receive two bridge-owned MCP tools:

- `list_agent_relations` lists the caller's direct parent and direct children.
- `send_agent_message` sends a bounded, one-way message to one of those direct relations. A reply is
  another explicit `send_agent_message` call; the bridge does not synthesize conversations.

The bridge owns exactly one OS-assigned loopback listener and one MCP server task per bridge process.
Every eligible ACP session shares it. DapperCode injects one Streamable HTTP descriptor when the ACP
host advertises HTTP MCP support, otherwise one legacy SSE descriptor when it advertises SSE. It
does not inject both, start a per-session process, or use stdio as a fallback.

Each descriptor carries a random session-scoped bearer credential in its headers. Credentials are
inactive until the corresponding ACP lifecycle request and durable session-index update succeed,
rotate on load or resume, and revoke their bound HTTP/SSE protocol sessions on replacement,
deletion, or bridge shutdown. Tokens are never placed in URLs, logs, repositories, or central
state. The listener is loopback-only; it is a least-privilege boundary inside private-network bridge
software, not an internet-facing service. Remote MCP reconnects replace the oldest protocol binding
at the per-credential or global cap, and evicted Streamable HTTP sessions return `404` so compliant
clients reinitialize instead of treating recovery as an authorization failure.
If the bounded credential registry is saturated, ACP session creation and restoration still proceed
without the additive messaging descriptor rather than failing the host lifecycle.

Authorization is limited to one indexed parent/child edge. Self, sibling, cross-agent, unknown,
deleted, and more-distant ancestor or descendant targets are rejected. An idle recipient starts a
new turn immediately. A busy recipient enters the existing turn queue, is promoted through the
safe steering lane when the host supports steering, and otherwise remains queued for automatic
dispatch. Agent queue entries are read-only and expose only cancellation on mobile.
Cancellation updates the durable activity to `cancelled`. Because queued and pending-steer payloads
are intentionally in memory, either activity still in flight when the bridge starts is reconciled
to `cancelled` rather than implying that lost work remains pending. If ACP history proves the
recipient accepted the prompt before shutdown, reconstruction corrects that activity to `sent`.

Accepted messages are projected as dedicated `dappercode.agent_message` activities: **Sent to …**
for the sender and **Received from …** for the recipient. A bounded private journal under the
workspace profile's central state restores sender-side activities after a bridge restart; exact
versioned envelopes restore recipient origin without treating arbitrary user text as agent traffic.

## Known Limits

1. Only events emitted by the ACP agent session owned by this bridge can be delivered live.
2. Work started through an unrelated agent process or client is not tailed from backend-specific
   files and is not synthesized into the canonical channel.
3. Slow or disconnected clients can miss live delivery after the bounded replay window is evicted;
   snapshot convergence restores durable session state, but transient deltas may no longer exist.
4. Queue and pending-steer state is intentionally in memory and does not survive a full bridge
   process restart.
5. Agent capabilities vary. Steering, session resume/load, permissions, and elicitations are exposed
   only when negotiated or supported by the selected agent.
6. Sub-agent streaming needs an agent that reports its session tree. Agents that only reveal a
   sub-agent through the task tool's own result still show it when the tool completes.
7. Agent messaging requires the ACP host to advertise HTTP or SSE MCP support. Stdio-only hosts do
   not receive these tools because the one-server invariant forbids per-session stdio servers.
8. A child cannot be addressed until the host exposes enough session identity for the bridge to
   index its direct relationship. The sender receives a clear tool error and can retry after
   relation discovery.

## Operational Guidance

1. Start work through DapperCode when live mobile updates are required.
2. Use `bridge/events/replay` for reconnect gaps and treat `streamId` changes as snapshot boundaries.
3. Check `bridge/health/read` for agent lifecycle, negotiated capability, replay, queue, push, and
   request diagnostics.
4. Repair agent installation or the local manifest when an agent is unavailable; do not add a
   second backend-specific control plane to the Rust bridge.
5. Keep the bridge on a trusted private network with authentication enabled.

## Testing

- `pnpm run test:acp` covers fake ACP transports, session lifecycle, interactions, canonical events,
  steering, cancellation, and manager recovery.
- `pnpm --filter @dappercode/mobile run test` covers WebSocket replay ordering, stream changes, and snapshot
  convergence behavior.
- `pnpm run contract:check` validates the checked mobile/Rust bridge contract fixtures.
