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

## Known Limits

1. Only events emitted by the ACP agent session owned by this bridge can be delivered live.
2. Work started through an unrelated agent process or client is not tailed from backend-specific
   files and is not synthesized into the canonical channel.
3. Slow or disconnected clients can miss live delivery after the bounded replay window is evicted;
   snapshot convergence restores durable session state, but transient deltas may no longer exist.
4. Queue state is intentionally in memory and does not survive a full bridge process restart.
5. Agent capabilities vary. Steering, session resume/load, permissions, and elicitations are exposed
   only when negotiated or supported by the selected agent.
6. Sub-agent streaming needs an agent that reports its session tree. Agents that only reveal a
   sub-agent through the task tool's own result still show it when the tool completes.

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
