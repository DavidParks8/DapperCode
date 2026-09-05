# Bridge UI Surfaces

Bridge UI surfaces are the stable way for the bridge to show new provider or harness details in the mobile app without adding provider-specific React Native screens.

Use this contract when an ACP agent adds a workflow concept, status object, or action prompt that can be represented with existing primitives. Examples include quota warnings, compaction notices, model-switch suggestions, background task status, and agent-specific warnings.

Do not send arbitrary HTML, JavaScript, React component names, or provider-native payloads to mobile. The bridge owns provider-specific translation. Mobile owns rendering these safe primitives.

## Notifications

The bridge broadcasts surfaces over the existing JSON-RPC notification stream:

- `bridge/ui.present`: show a new surface.
- `bridge/ui.update`: replace an existing surface with the same `id`.
- `bridge/ui.dismiss`: remove a surface.
- `bridge/ui.resolved`: emitted after mobile resolves an action.

Notifications are replayable through `bridge/events/replay` like other bridge notifications.

## Bridge RPC Methods

The bridge also exposes RPC helpers. These are useful for bridge-internal adapters, tests, and future provider integrations:

- `bridge/ui/present`
- `bridge/ui/update`
- `bridge/ui/dismiss`
- `bridge/ui/resolve`

`bridge/ui/present` and `bridge/ui/update` accept a full `BridgeUiSurface`. `bridge/ui/dismiss` accepts `{ "id": "...", "threadId": "..." }`. `bridge/ui/resolve` accepts `{ "id": "...", "threadId": "...", "turnId": "...", "actionId": "..." }`.

## Surface Schema

```ts
type BridgeUiSurface = {
  id: string;
  threadId: string;
  turnId?: string | null;
  kind?: string | null;
  presentation: 'workflowCard' | 'modal' | 'banner';
  tone?: 'neutral' | 'info' | 'success' | 'warning' | 'error';
  title: string;
  subtitle?: string | null;
  bodyMarkdown?: string | null;
  blocks?: BridgeUiBlock[];
  actions?: BridgeUiAction[];
  dismissible?: boolean;
  createdAt?: string | null;
  updatedAt?: string | null;
};
```

Supported block primitives:

```ts
type BridgeUiBlock =
  | { type: 'text'; text: string }
  | { type: 'markdown'; markdown: string }
  | {
      type: 'checklist';
      items: Array<{
        label: string;
        status?: 'pending' | 'inProgress' | 'completed';
        detail?: string;
      }>;
    }
  | {
      type: 'keyValue';
      items: Array<{ label: string; value: string }>;
    }
  | { type: 'code'; text: string; language?: string | null }
  | {
      type: 'progress';
      label: string;
      value: number;
      max: number;
      detail?: string | null;
    };
```

Supported actions:

```ts
type BridgeUiAction = {
  id: string;
  label: string;
  style?: 'primary' | 'secondary' | 'destructive';
  dismissesSurface?: boolean;
};
```

## Presentation Guidance

- Use `workflowCard` for turn-scoped details that should sit near the existing plan card.
- Use `modal` for blocking or user-decision details.
- Use `banner` for compact warnings or status updates near the composer.
- Keep `title` short and user-facing.
- Put provider-specific raw data in `code` only when it helps the user act.
- Keep `kind` stable for semantic grouping, for example `goal`, `quota`, `compaction`, or `provider-warning`.

## Implemented ACP Plan Example

The Rust bridge maps an ACP `plan` session update into `CanonicalEvent::Plan`. The AG-UI projector emits that event as a `CUSTOM` event named `dappercode.dev/plan`, preserving the bridge thread and active run correlation when one exists. Mobile renders the entries with its existing plan surface; no agent-specific parser or component is required.

The projected AG-UI event shape is:

```json
{
  "type": "CUSTOM",
  "threadId": "v1.YWNwLWFnZW50.c2Vzc2lvbi0x",
  "runId": "v1.YWNwLWFnZW50.c2Vzc2lvbi0x::turn::7",
  "name": "dappercode.dev/plan",
  "value": {
    "entries": [
      {
        "content": "Implement the session index",
        "priority": "High",
        "status": "InProgress"
      }
    ]
  },
  "timestamp": 1784505600000
}
```

## Implemented Tool Metadata Example

Every ACP tool call carries a `kind` (`read`, `edit`, `execute`, …) and a per-call `status`
(`pending`, `in_progress`, `completed`, `failed`). Neither fits an AG-UI `TOOL_CALL_START`, so the
projector emits them as a `CUSTOM` event named `dappercode.dev/tool-meta` whenever the metadata
revision moves. It cannot ride on `dappercode.dev/tool-content`, which only fires when structured
content changes: a pure `in_progress` → `completed` transition would be lost.

```json
{
  "type": "CUSTOM",
  "threadId": "v1.YWNwLWFnZW50.c2Vzc2lvbi0x",
  "runId": "v1.YWNwLWFnZW50.c2Vzc2lvbi0x::turn::7",
  "name": "dappercode.dev/tool-meta",
  "value": {
    "toolCallId": "call-1",
    "kind": "execute",
    "status": "in_progress",
    "title": "pnpm test",
    "startedAtMs": 1784505600000,
    "completedAtMs": null
  }
}
```

A `MESSAGES_SNAPSHOT` cannot carry a custom event, and the AG-UI `Message` bindings are generated
and must not gain fields, so a snapshot instead carries an activity message with
`activityType: "dappercode.tool"` immediately before the matching `tool-call:` / `tool-result:`
pair, holding the same payload plus the bounded `content`, `locations`, and `truncated` fields.
Mobile folds it into the tool row and never renders it on its own. Sub-agent tools are excluded from
both paths because they already have their own `dappercode.subagent` card.

`startedAtMs` and `completedAtMs` are Unix epoch milliseconds measured by the bridge. The start is
the first time the bridge observes the call and remains stable across updates. Completion is frozen
on the first completed or failed update; run termination also completes any dangling active call,
never earlier than its start. Mobile uses these fields for the expanded row's local start time and
duration, including a live elapsed value while `completedAtMs` is null.

Raw tool input is deliberately absent. The bridge strips `rawInput`, `rawOutput`, and `_meta` in
`acp/handlers.rs` and `acp/snapshot.rs`; rows are built from the ACP `title` and `locations` instead.
For calls titled `apply_patch` or `functions.apply_patch`, the handler also derives locations from
complete Add/Update/Delete/Move file headers in incoming patch input (a string or a `patch`, `input`,
`patchText`, or `patch_text` field).
It does not wait for `*** End Patch` or tool completion. Unterminated filename headers wait for the
next input update; repeated input-so-far updates do not duplicate files. Only paths enter the existing
bounded location metadata (32 locations), never patch bodies or other raw arguments. Mobile shows
these as inline file chips even while tool details are collapsed, then fills in counts when
structured diffs arrive without reordering the chips. Agents that do not send input or locations
until completion cannot provide earlier file discovery.

For a local smoke test of the generic renderer only, open a chat in the mobile app and run:
```bash
pnpm run bridge:ui:demo
```

That sends a sample workflow card to the latest chat. Use `pnpm run bridge:ui:demo --modal` or `pnpm run bridge:ui:demo --banner` to test the other presentations. Use `pnpm run bridge:ui:demo --thread <thread-id>` when the latest chat is not the one visible on the device.

## Implemented Session Token Totals Example

ACP returns an optional per-turn `usage` object on `PromptResponse`, carrying `inputTokens`,
`outputTokens`, `thoughtTokens`, `cachedReadTokens`, `cachedWriteTokens`, and `totalTokens`. It is
gated behind the `unstable_end_turn_token_usage` cargo feature, which the bridge enables
unconditionally: support is detected at runtime from the data itself, never from a build flag or an
agent name.

Two properties of the upstream data drive the design:

- **The values are per-turn, not cumulative.** The ACP field documentation says "across session", but
  agents populate it from the latest assistant message only, so the bridge accumulates the totals
  itself in the session snapshot.
- **Absent is not zero.** Agents omit `thoughtTokens`, `cachedReadTokens`, and `cachedWriteTokens`
  entirely when they are zero, so those three stay `null` in the totals unless some turn actually
  reported them. Mobile omits a row rather than printing a misleading `0`.

`runtime.rs` emits a `CanonicalEvent::TurnTokenUsage` alongside the existing `RunFinished` whenever a
prompt response carries usage. The projector emits the running totals as a `CUSTOM` event named
`dappercode.dev/tokenTotals`:

```json
{
  "type": "CUSTOM",
  "threadId": "v1.YWNwLWFnZW50.c2Vzc2lvbi0x",
  "runId": "v1.YWNwLWFnZW50.c2Vzc2lvbi0x::turn::7",
  "name": "dappercode.dev/tokenTotals",
  "value": {
    "turns": 14,
    "inputTokens": 48200,
    "outputTokens": 12400,
    "reasoningTokens": 8900,
    "cachedReadTokens": 386000,
    "cachedWriteTokens": 52300,
    "totalTokens": 507800
  }
}
```

The same object is exposed on the thread snapshot as `tokenTotals`, and is `null` until a turn
reports usage. That null is the capability signal: mobile renders the session-meta usage chip and its
ledger sheet only when the field is present, so agents that never report usage show no affordance at
all.

This is distinct from `dappercode.dev/usage`, which carries context-window pressure
(`used`, `size`, `cost`) from the ACP `usage_update` session update. The two are independent, and
neither substitutes for the other.

### Per-Response Usage

The same `TurnTokenUsage` event also attaches the turn's usage to the snapshot message the turn ended
on, as `messages[].usage`:

```json
{
  "id": "message-1",
  "role": "agent",
  "usage": {
    "inputTokens": 4100,
    "outputTokens": 860,
    "reasoningTokens": 240,
    "cachedReadTokens": 31200,
    "cachedWriteTokens": 1900,
    "totalTokens": 38300,
    "model": "Example Model"
  }
}
```

- **It anchors to the last agent message.** A turn that produced no agent response reports nothing,
  and the field stays `null` on every other message including user and reasoning entries.
- **`model` is the session's configured model label**, snapshotted when the usage lands, because ACP
  reports the model as a session config option rather than per turn. It falls back to the raw option
  value when no matching display name exists, and is `null` when the agent exposes no model option.
- **No live event carries it.** Mobile reloads the snapshot when a run terminates, so the value
  arrives with the settled turn. Live projection preserves any usage already persisted.
- Mobile renders it as the collapsible response-details card under the message action row, and the
  card is absent entirely when `usage` is `null`.

## Rules For Future Integrations

- Add provider-specific parsing in the bridge adapter, not in mobile UI.
- Map provider-specific terms into the stable block primitives above.
- Do not add new block types unless the existing primitives cannot represent the workflow.
- Keep action IDs stable because mobile sends them back through `bridge/ui/resolve`.
- Include `threadId`; the mobile app scopes surfaces to the active chat.
- Include `turnId` when the surface belongs to a specific turn.
