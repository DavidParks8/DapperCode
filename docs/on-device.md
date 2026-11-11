# On this iPhone

The iOS app can run a coding model and its file/Git tools locally. **On this iPhone** is a built-in
profile next to your desktop bridge profiles: its chats use the same drawer, chat screen, model sheet,
workspace picker, Git screen, and Settings. It is not a localhost server, and Android and web
continue to use desktop agents.

## First run

1. Choose **On this iPhone** wherever you pick where agents run: the onboarding choices, the
   **Runs on** row in the drawer, the profile capsule under **Let's build** in a new chat, or
   **Settings → Profiles**. Each opens a new chat in the local profile.
2. Until a local chat first has a message, the new chat shows a **Set up On this iPhone**
   checklist: download a model (Settings → Models), clone or create a workspace (the workspace
   picker), add a Git author (Settings → Git & GitHub; recommended, since commits need it), and
   start your first chat. Missing-prerequisite guidance appears once beside its next action,
   rather than repeating below the checklist. Only the model and workspace are required; **Hide setup guide** removes
   it for good. On **Settings → On this
   iPhone → Models**, search across families, sizes, and quants (for example "q8" or "2b");
   **Downloaded only** and **Include models too large for this iPhone** sit together under the
   search field. Choose a family to compare its sizes and quants, then **Download** one and
   **Load** it. Loading also makes it the model new chats use. The page shows storage used and
   free, every queued or running download, and, under **In use**, which model is loaded and which
   one new chats use (they can differ, for example after **Unload**).
   Downloads are pinned by revision, byte count, and SHA-256; unverified weights cannot be loaded.
   See [Model downloads](#model-downloads).
3. Open the chat's workspace picker and choose **Clone repository** with an HTTPS URL (the name is
   taken from the URL; progress shows and **Stop** cancels). Public repositories need no account.
   Sign in under **Settings → On this iPhone → Git & GitHub** before cloning a private GitHub
   repository. **New workspace** creates an empty one; **Initialize Git** on its Git page
   (optionally with an HTTPS origin) to stage, commit, and later push or pull. Its history stays empty
   until the first commit. Touch and hold a
   workspace to rename it or browse its files, and swipe left to delete it; deleting removes its
   files but keeps conversations that used it readable.
   Clone submission is single-admission: repeated taps or Return events cannot unlock an active
   transfer. Stop and failure settle the controls before retry; late results from an old connection
   never change the current profile's form or selected workspace.
   A completed clone releases the navigation lock before returning to chat, including when a
   previous render's active-transfer guard is still registered.
4. Set your commit author name/email on the same **Git & GitHub** page, then start a **New chat**.
   Pick the model with the chat's **Choose a model** sheet and the workspace with the workspace
   picker. The sheet lists downloaded models with whether each is loaded, marks the one new chats
   use as **Default**, and links to **Download more models** in Settings. The picker remains
   available before the first download and refreshes when you return from Settings, including
   after a download or deletion. Choosing a model there
   changes it for that chat and for new chats without loading it; it loads when you send.
   A new-chat choice is confirmed only after the device saves it. Settings and the chat picker
   share that default, independently of the resident model; saved desktop preferences do not
   override it. A failed save keeps the previous choice and offers a visible error.
5. After preparation, inference, file edits, workspace search, diffs, staging, discarding, branch creation and
   switching, history, and commits work without internet. Push, fetch, pull, cloning, sign-in, and
   new downloads require connectivity. The local agent can also read HTTPS web pages and search URLs
   through an approval-gated `web_fetch` tool; see [Web access](#web-access).

Existing desktop profiles and conversations are not migrated or deleted. The last selected profile,
local or desktop, is restored at startup. Builds that stored the old global "On this iPhone" mode
open the local profile instead. Switching to another profile settles local work and unloads its
model.

## Workspace instructions and skills

Local model rounds automatically read the selected workspace's root `AGENTS.md`. When a file
tool enters a directory, its ancestor rules are added in root-to-leaf order; each rule applies only
to its own subtree, and deeper rules override ancestors there, not in sibling directories.
`CLAUDE.md` is a per-directory fallback only when `AGENTS.md` is missing (not empty or unreadable).
Before a tool runs, changed or newly applicable rules return an explicit **Not run** result so the
next model round can review them before retrying. Rename checks both source and destination
parents; directory rename/delete also includes the source directory's own rules. Scopes are
turn-local, including retries; they never cross workspaces.
When registered, `code_diagnostics`, `code_definitions`, `code_references`, `code_symbols`, and
`format_file` use the same path scopes, so formatting cannot bypass previously unseen nested rules.
Parallel read preparations retain the union of entered scopes and enforce the directory limit
against that merged set; source errors and cancellation do not discard previously entered scopes.

Rules are re-read for every model round, including after agent edits. Only expected
`PATH_NOT_FOUND` errors are optional; unreadable, invalid UTF-8, symlink/hard-link, oversized, and
other native failures remain visible. All reads use the native selected-workspace boundary: no
parent traversal, absolute paths, Git metadata, phone-home directories, or remote instruction
imports. Rules do not override runtime safety or user requests. Rule files must fit entirely in
8,192 bytes, and at most 24 rule directories and 12 path components are entered.

### Agent Skills

On this iPhone supports [Agent Skills](https://agentskills.io/specification) as the union of
GitHub Copilot's and OpenCode's behavior. A skill is either a directory containing `SKILL.md`
(every other file there is bundled with it) or, OpenCode-style, a flat `<id>.md` file at a source
root (no bundled files).

**Sources**, highest precedence first. Skills are selected by ID; a lower source's duplicate is
reported as shadowed.

| Source                  | Where                                                         | Notes                                                            |
| ----------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------- |
| Explicit config sources | `skills` in `opencode.json(c)` / `.opencode/opencode.json(c)` | Workspace paths and downloaded HTTPS catalogs; later entries win |
| `.opencode/skills`      | Workspace                                                     |                                                                  |
| `.github/skills`        | Workspace                                                     | Copilot                                                          |
| `.agents/skills`        | Workspace                                                     | Copilot and OpenCode                                             |
| `.claude/skills`        | Workspace                                                     | Copilot and OpenCode                                             |
| Personal catalogs       | App-owned (Settings)                                          | OpenCode's global `skills` URLs                                  |
| Personal skills         | App-owned (imported)                                          | Copilot's `~/.copilot/skills` equivalent                         |

A project source always beats a personal one, as in Copilot. (OpenCode lets global
`~/.config/opencode/skills` beat project `.claude`/`.agents` skills; the iPhone has no home directory,
so personal skills stay last.)

**Layout.** Each source root may hold flat `<id>.md` files at its top level and `SKILL.md`
directories nested in grouping directories up to six levels below it: `skills/teams/release/SKILL.md`
is the skill `release`. A directory containing `SKILL.md` is one skill and is not searched further.
Hidden entries and `node_modules` are skipped, links are never followed, and a source stops after
256 directories, 1,000 entries per directory, or 128 skills.

**IDs and names.** The ID comes from the path (the directory holding `SKILL.md`, or the flat file's
stem). It is exact and case-sensitive, and may use 1-64 letters, digits, `.`, `_`, or `-`. Only
lowercase kebab-case IDs can be slash commands or personal imports. A frontmatter `name` that differs
from the ID is a display name (OpenCode) instead of skipping the skill (Copilot); Settings shows a
portability warning, because Copilot would skip it.

**Frontmatter** is optional. Without a `description` a skill is registered and loadable by the user,
but never advertised to the model (with a warning). Fields: `name`, `description` (longer than 1,024
characters works, with a portability warning), `license`, `compatibility` (up to 500 characters),
`metadata` (text, true/false, or number values), `allowed-tools` (space-separated, or a YAML list),
`argument-hint`, `user-invocable` (default `true`), `disable-model-invocation` (default `false`),
`metadata.opencode/autoinvoke`, and `context: fork`. Unknown fields are ignored. YAML block scalars
and quoted values work; duplicate keys, aliases, and malformed known fields skip the skill. One bad,
oversized, linked, or duplicate skill never fails a turn or hides the others; the runtime's skill list
reports each skipped or shadowed skill (severity `skipped`) and each warning (severity `warning`).

The model first sees only IDs (with any display name) and descriptions of advertised skills, as many
as fit the guidance budget (one quarter of the loaded context window, at most 8,192 UTF-8 bytes,
shared with rules); the prompt says how many were omitted, and `skill` without a name lists them all,
in pages (so does a blank name, or `list`, `all`, or `*` when no skill has that ID, because small
models name the listing instead of omitting `name`). `skill` with a name returns the whole
`SKILL.md` in 8 KiB pages (follow `nextOffset`) plus every bundled file path; `skill` with
`resource` reads one bundled file by path relative to the skill directory, also paged. Skill results
are never offloaded to saved-output artifacts. Bundled files are UTF-8 text only; binary files fail
with an explicit error.

- **Slash commands and mentions.** A message that starts with `/<id>` (optionally followed by
  arguments), and up to three `@<id>` mentions anywhere in it (at a word boundary, exact ID), load
  those skills before the first model round. Only permitted, user-invocable skills activate. The chat
  shows each load as a completed `skill` call, and the message is kept verbatim. Retry and recovery
  never repeat them. Unknown `/name` and `@name` stay plain text. A mentioned `context: fork` skill
  gets the whole message as its request. The chat's slash menu lists permitted user-invocable skills
  with slash-compatible IDs, with `argument-hint` as the hint.
- **Hidden skills.** `disable-model-invocation: true`, `metadata.opencode/autoinvoke: false`, or a
  missing description keeps a skill out of the model's list and refuses model loads, unless the user
  named it with `/id` or `@id` in the current turn (then its pages and files can be read). When both
  flags are set, `opencode/autoinvoke` wins, so `autoinvoke: true` advertises the skill again.
- **`user-invocable: false`** removes the skill from slash commands and mentions; the model can still
  load it.
- **`context: fork`** runs the skill in a fresh `general` child given `SKILL.md` and your arguments
  (or the model's `prompt`). Only the child's final result returns. Children count against the
  usual child limits and stop with **Stop**. Inside a child, a fork skill loads inline. Because the
  `general` agent runs it, its rules apply too: when `general` denies the skill or has
  `tools.skill: false`, the load is refused with an explicit result (it never falls back to loading
  inline), and when `general` asks, a model load waits for approval (a `/id` or `@id` load counts
  as consent). The request a skill call carries is at most 32,768 characters; a longer `/id`
  message is truncated there with a note, while the full message stays in the conversation.
- **`allowed-tools`** pre-approves tools once the skill is loaded, for the rest of that run (or that
  fork child) only; the next run asks again. Entries match local tool names, plus common aliases
  such as `fetch`/`webfetch` → `web_fetch` and `websearch` → `web_search`. `shell`, `bash`,
  `skill` (skill loads follow skill permissions), argument-scoped entries such as
  `web_fetch(domain:x)`, and unknown tools are ignored and reported in the skill result next to the
  pre-approved tools. A skill never grants a tool its agent lacks (an `explore` child stays
  read-only) and never bypasses workspace or revision checks.

> **Only use skills you have reviewed.** A skill's instructions steer the model, and its
> `allowed-tools` remove confirmations: pre-approving `web_fetch` lets it send requests without
> asking, and pre-approving `git_push` lets it push without asking.

**Project config.** The runtime reads `opencode.json`, `opencode.jsonc`, `.opencode/opencode.json`,
and `.opencode/opencode.jsonc` at the workspace root, in that order (each at most 64 KiB; JSONC
comments and trailing commas work). Each file contributes; a bad file is skipped with a warning.

- `skills`: relative paths are workspace-relative source roots and must stay inside the workspace;
  `https://` URLs are HTTP catalogs. `~/` and absolute paths (no home or host filesystem on iPhone),
  `http://`, and other schemes are reported and ignored.
- `permission.skill` (V1: one effect, or an ordered map of patterns to effects) and `permissions`
  (V2: `{ "action": "skill", "resource": "<pattern>", "effect": "..." }` entries; `action` may be a
  wildcard) set skill rules.
- Per-agent rules apply to OpenCode's built-in agent IDs: `build` (the conversation), `general`, and
  `explore` (its children). Use V1 `agent.<id>.permission.skill` or V2 `agents.<id>.permissions`.
  V1 `agent.<id>.tools.skill: false` removes the `skill` tool and the skill list for that agent (V2
  documents no equivalent).

**Permissions.** Rules match the exact skill ID with `*` (any run) and `?` (one character); the last
matching rule wins and no match allows. Order: project rules (files in load order), the agent's
project rules, then the device owner's rules (Settings), so the device owner always wins. `deny` hides
a skill from the model, slash commands, and mentions, and rejects loads. `ask` advertises it, but each
model load waits for the usual approval prompt (as kind `other`, so the **On request** policy still
asks; only **Never ask** skips it); a `/id` or `@id` load counts as consent, and an approved skill's
files can then be read without asking again in that run. Loads that ask never run in a parallel
read batch, so several `ask` loads in one reply are approved one at a time. The per-skill switch (Copilot's
`/skills` enable/disable) is a final device-owner `deny`; turning it back on adds an exact `allow`
only when the device owner's own rules still deny the ID. A global switch turns every skill off: no
list, no `skill` tool, no slash commands or mentions.

**HTTPS catalogs.** A catalog is a base URL with `index.json`:
`{ "skills": [{ "name": "git-release", "version": "3", "files": ["SKILL.md", "references/x.md"] }] }`.
Files download from `<base>/<name>/<file>` and must be safe, relative, and same-origin; redirects are
not followed. The entry file is `SKILL.md` or `<name>.md`, and the ID is the entry `name` (lowercase
kebab-case, because it names an app-owned document). Consent adaptation: OpenCode downloads catalogs
automatically; on this iPhone only an explicit **Download/Update** action in Settings uses the
network, never the agent, and the agent reads only cached copies. Downloads require HTTPS and
connectivity, time out after 15 seconds per request, and are bounded to 64 skills, 64 files per skill,
1 MiB per file, and 4 MiB per skill. Cached copies are keyed by catalog URL, skill, and version, and
are replaced only when `version` changes; skills that leave the index are removed, and a failed skill
keeps its previous copy. Workspace catalogs rank with the explicit config sources; personal catalogs
rank just above personal skills. Removing a personal catalog deletes its cached copies.

Not available on this iPhone: running bundled scripts (there is no shell; they are readable text),
`~` and absolute skill paths, `#file:` references to a home directory, OpenCode's built-in skills,
OpenCode Console skill sharing, custom agent profiles (agent-frontmatter permissions), and plugins
or skill marketplaces.

Limits: an 8,192-byte frontmatter prefix, 160 description characters per prompt entry, 64 listed
bundled files at most 6 directories deep, up to 64 personal skills of at most 128 files and 4 MiB
each, 16 personal catalogs, 32 config sources, and 256 rules per list. Project skills and config are
cached until the workspace changes; personal and catalog skills until one is imported, removed, or
downloaded.

**Runtime API for Settings** (`runtime.skills`, announced through the `skills` slice):
`list(workspaceId)` returns each skill with `id`, `displayName`, `sourceKind`
(`project-root` | `config-path` | `catalog` | `personal`), `sourceRoot`, `layout` (`directory` |
`flat`), `permission` (`effect` plus the matching `rule` and its `origin`, or null for the default),
`enabled`, and `advertised`, plus diagnostics with `severity`. `rules()`/`setRules(rules)` edit the
device owner's rules, `setEnabled(id, on)` is the per-skill switch, and `skillsEnabled()`/
`setSkillsEnabled(on)` is the global switch. `catalogs(workspaceId | null)` lists workspace-configured
and personal catalogs with `state` (`not-downloaded` | `cached` | `failed`), cached skill versions,
and the last error; `addPersonalCatalog(url)`, `removePersonalCatalog(url)`, and
`downloadCatalog(workspaceId | null, url)` (null for a personal catalog; returns per-skill
`downloaded` | `unchanged` | `failed` results) manage them.

**Managing skills.** Settings › On this iPhone › Skills shows a workspace's project, catalog, and
personal skills exactly as the agent sees them (the new-chat workspace by default; choose another
under Workspace). **Use skills** turns every skill off or on: off, the agent gets no skill list, no
`skill` tool, and no slash commands, and your skills, choices, and rules are kept. Each skill shows
its display name (and ID when they differ), description, source and location, slash command and
`argument-hint`, whether it is shown to the model (and why not), `context: fork`, single-file
layout, any pre-approved tools (with a warning that they skip confirmation), and its effective
permission with the rule that decided it (no rule, your choice, your pattern rule, or the
`opencode.json` key). Its **Allow / Ask / Deny** control applies to that ID in every workspace:
Allow and Ask are saved as exact-ID rules after your others, Deny is the `/skills` off switch and
always wins, and **Follow rules** removes your choice. Ask means the model asks before loading the
skill; running `/id` or `@id` yourself counts as consent. **Details** adds the ID, display name,
source kind and root, layout, license, `compatibility`, the start of `SKILL.md`, and the bundled
files, so a skill can be reviewed before it is allowed. **Skipped** lists skills the agent cannot
use and **Warnings** lists ones that still load (for example, no description or a display name
that differs from the ID), each with its location and reason. **Add personal skill** imports from
any workspace: tap a discovered project skill, or browse to any folder that contains `SKILL.md`,
such as `skills/<name>` in a cloned skills repository (the replacement for `gh skill install`). The
copied and skipped files, or the reason it failed, appear beside what you added; adding the same
ID again replaces the copy, and **Remove** asks first.

Under **Manage**, **Permission rules** lists your ordered rules (`*` and `?` wildcards over skill
IDs; the last match wins, and yours apply after the workspace's `opencode.json` rules), adds a
pattern with an effect, deletes rules, and lists denied skills with **Remove denial**.
**Catalogs** lists the workspace's `opencode.json` catalogs and your personal ones with their state
(not downloaded, cached versions, or the last failure). Adding a personal `https://` catalog URL
downloads nothing; **Download** or **Update** is the only time this iPhone contacts a catalog, and
shows each skill's result beside the catalog. Removing a personal catalog asks first and deletes its
downloaded skills.

## Local formatting and code intelligence

With a 16,384-token context, the local model can call `code_diagnostics`, `code_definitions`,
`code_references`, and `code_symbols` for JavaScript/JSX and TypeScript/TSX (`.js`, `.jsx`, `.ts`, `.tsx`, `.mjs`,
`.cjs`, `.mts`, `.cts`, including declaration files). These use the **real TypeScript 6
LanguageService in-process**, not text matching, a remote service, or an LSP protocol/server.
iOS does not launch arbitrary external language-server subprocesses.

Each request reads a fresh, bounded native workspace snapshot. Definitions and references follow
relative imports between snapshot files; results include workspace-relative paths, file revisions,
and 1-based line/UTF-16 column ranges. References include declarations. Navigation returns workspace
locations only, not bundled standard-library definitions. The initial compiler settings are strict
ES2022, checked JavaScript, and preserved JSX, with bundled ES2022 standard-library declarations.
Workspace `tsconfig.json`, package metadata, installed package types, automatic type acquisition,
and Node/DOM/React ambient types are **not loaded**. Unresolved imports/types appear as diagnostics;
an empty diagnostic list is not proof that the project's normal build or tests pass.

Successful `write_file` and `edit_file` calls **automatically format** the source extensions above
and `.json`; `apply_patch` does the same for each applicable changed destination.
The shared `formatAfterFileEdit(native, workspace, {path, revision}, signal?)` hook uses the
successful native mutation's revision, only touches that file, and returns the latest post-format
revision. Patch formatting happens after the coordinated native transaction: formatting errors
do not roll back the applied patch, and each affected file reports its formatting status.
Rename/delete/read calls do not trigger formatting.
`format_file` remains available to explicitly format an existing file.
When formatting changes content, the result asks the model to re-read before another exact-text
edit or patch rather than assuming its unformatted input still matches the file.

Formatting uses bundled Prettier 3 standalone with its TypeScript/Babel/ESTree plugins and a distinct
JSON parser. No workspace configuration, plugins, or embedded language formatting are executed.
Already-formatted files are not rewritten. Each successful edit returns `formatting.status`:
`formatted`, `unchanged`, `unsupported`, `failed`, or `cancelled`. Unsupported languages keep the
successful edit and report that formatting was skipped. Parse/budget/native formatting failures
include bounded code/message data (parse failures also include source location); they do **not**
pretend that the preceding edit failed or erase it. The edit's revision remains observed so a
subsequent repair can be checked safely. A failed original mutation propagates unchanged and never
invokes the formatter. Explicit formatting rejects unsupported languages and syntax errors without
writes. Only genuine Prettier `SyntaxError`s with source locations become parse errors; unexpected
runtime/initialization exceptions retain their identity/message for explicit calls and are reported
separately after successful edits. Conflicts require a fresh read; formatting never silently retries
over a user's concurrent edit.

Source limits are 64 KiB per UTF-8 file, 64 source files/512 KiB total, 512 visited directory
entries, 12 directory levels, and 256-character relative paths. Symbolic links are never followed;
`.git`, `node_modules`, `.expo`, `dist`, `build`, and `Pods` directories are excluded. Exceeding a
project budget is an error, not a misleading partial-project success. Results are capped at 40
entries/8,192 serialized characters with `truncated`; diagnostic messages are individually bounded.

Production native APIs accept directory limits `1...1000` and read limits `1...65536`; code tools
use 512/65536 directly, within those limits. The lower 200/16384 values belong to model file-tool
schemas, not the native APIs. Strict native-port fixtures and the native simulator gate cover this
distinction rather than relying on unconstrained mocks.

Formatting also caps output at 64 KiB UTF-8, so a successful format stays within the next read's
budget. A five-second **cooperative** deadline and the run's
abort signal are checked between native calls and compiler checkpoints. Stop/background cancellation
prevents subsequent formatting writes; an already-admitted native atomic write is not rolled back.
Synchronous parser/compiler work occupies the JS thread until a checkpoint returns, so this is not
a hard real-time limit. Retry builds a new snapshot; no language-service cache survives the call.

No source is uploaded, no shell/interpreter/JIT is used, no host filesystem resolver is available,
and no app metadata is written into the workspace. Native workspace API/schema versions are unchanged.
The build-time `intelligence:prepare` step bundles the installed TypeScript compiler and standard
libraries for browsers with Node-host detection compiled out; runtime calls provide an explicit
memory-only language-service host. The generated compiler is about **4.04 MB of minified JavaScript**
before Hermes bytecode/package compression, plus Prettier and its three parser/printer plugins.
These are real runtime dependencies, not free native OS services; they increase download size and
first-use/transient AST memory costs. Compiler/parser modules are evaluated lazily on the first
applicable edit or code-tool call. Generated code is ignored, reproduced at install/start/build/test,
and does not replace or modify vendor files.

Validation commands:

```bash
pnpm --filter @dappercode/mobile run intelligence:check
pnpm --filter @dappercode/mobile exec jest --runInBand src/features/on-device/code-intelligence/tools.test.ts src/features/on-device/runtime/localTools.test.ts
pnpm --filter @dappercode/mobile run build --max-workers 2
pnpm --filter @dappercode/mobile run typecheck:native
mkdir -p .e2e/native-code-runtime
TMPDIR="$PWD/.e2e/native-code-runtime" node .agents/skills/local-e2e-validation/scripts/run.mjs --evidence "$PWD/.e2e/new-native-code-evidence.jsonl" apps/mobile/modules/on-device-agent/tests/native-code-intelligence.mjs
```

The first (also run by the mobile test/coverage preflight) runs actual compiler/formatter operations
in a browser sandbox without Node globals,
filesystem/network imports, or dynamic code generation. Native-memory regression fixtures cover
cross-file lookup, edits and fresh diagnostics, parser errors, formatting idempotence/conflicts,
containment, resource budgets, cancellation, and registry routing. Expo export additionally compiles
the production iOS/Android bundles with Hermes. The native gate requires the worktree-local Release
simulator app described in the native module README; it executes the real compiler, automatic
formatter, native containment/revisions, and native list/read bounds on an isolated simulator.
This proves runtime compatibility, not physical-device performance or memory admission.

## Questions and persistent tasks

With at least an 8,192-token context, the local model can call `ask_user` to wait for 1–8 structured questions in the existing
**Clarification needed** sheet. Questions support single-choice, multiple-choice, and custom text
answers (up to 12 choices per question). Nothing is preselected or answered automatically, even
when tool approvals are disabled. **Cancel** and **Decline** return an explicit tool error and
let generation continue; **Stop** interrupts the turn instead. A turn keeps waiting while the phone
is locked (see [Running while the phone is locked](#running-while-the-phone-is-locked)). Losing
background time, leaving the local profile, deleting the conversation, or reloading settles pending calls without replaying them.
Answers to an old request cannot resolve a later one.
Choices and reply actions keep the platform's minimum touch target size.

`todo_read` and `todo_write` manage up to 64 conversation-owned tasks. Each task has a stable
alphanumeric id (hyphens/underscores allowed), nonblank text (maximum 500 characters), and
`pending`, `in_progress`, or `completed` status. Writes upsert by id, preserve omitted tasks, and
remove only explicitly listed ids. The existing execution card shows progress; tool rows also
show readable task results. Completing every task does **not** finish the user's request.

Tasks are acknowledged only after saving in the app-private conversation journal, never in the
Git workspace. They survive context trimming, retry, and reload; deleting a conversation deletes
its tasks. Persistence failures remain visible and retryable rather than being reported as success.

## Workspace search and coordinated patches

The local model can call `glob_files` for file discovery and `search_files` for UTF-8 line
search. Both accept a directory `path`, root-relative glob (`pattern` / `include`), `file_type`
extension, and `offset` / `limit` (offset maximum 10,000; limit 20 by default, maximum 100). Globs support `*`, `**`, and `?`;
other characters are literal. Search defaults to literal, case-sensitive text; `regex: true`
uses ICU regex and `case_sensitive: false` ignores case. Matches include one-based line numbers
and UTF-8-safe 512-byte previews with `previewTruncated`.

Native scans never follow symbolic or hard links, never inspect `.git`, and honor libgit2's
nested `.gitignore`, negation and `info/exclude` rules in Git workspaces. Non-Git workspaces
have no Git ignore evaluation. A scan visits at most 2,000 entries, reads at most 16 MiB
(1 MiB per file), and runs for at most two seconds with cooperative checkpoints. Pattern
matching for regex/globs has a separate 25 ms progress-callback deadline per line/path.
Invalid patterns, pathological regex and cancellation fail explicitly. Results report budgets,
visited entries, searched bytes, skipped non-text/oversized/linked files, excluded entries/subtrees,
and a truncation `reason`. Only a non-null `nextOffset` permits paging; an entry/byte/time-limited
scan is incomplete, not evidence that remaining files contain no matches. Pages rescan sorted
paths, so restart paging if files change.

`apply_patch` coordinates up to 32 add/update/delete/move operations (4 MiB patch input,
4 MiB per file, 16 MiB combined old/new data, 100,000 lines per patch/source, 4,096 hunks per
update). Read every existing source in the current turn
first; the runtime supplies those observed revisions, never model-provided hashes. New and moved
destinations must be absent. Paths, exact byte context, numbered hunk counts, all revisions,
duplicate/case-colliding paths and ancestor collisions validate before publication:

```diff
*** Begin Patch
*** Add File: src/new.txt
+hello
*** Update File: src/old.txt
*** Move to: src/renamed.txt
@@ -1,2 +1,2 @@
 unchanged context
-old
+new
*** Delete File: obsolete.txt
*** End Patch
```

Hunks use standard `@@ -oldStart,oldCount +newStart,newCount @@` headers (omitted count means
one, zero counts permit insertion/deletion). Prefix context with a space, removal with `-`,
addition with `+`; `\ No newline at end of file` marks the immediately preceding line.
A move without hunks preserves bytes. Existing single-file tools remain available unchanged.

The workspace actor serializes app operations. Descriptor-relative, no-follow access and exclusive
renames prevent link traversal and overwriting a newly appeared destination. Originals are claimed
and rechecked before any new contents publish; ordinary failures roll back prior publications.
This is **not** an OS-wide atomic multi-file snapshot or a crash-atomic transaction: outside readers
can observe intermediate names. Non-cooperating external writers can prevent rollback; the tool
then fails with `PATCH_RECOVERY_REQUIRED` and retains originals plus a path manifest in the workspace
container's `.patch-*` directory, outside the repository. Never delete that recovery directory
until its originals have been reconciled. A process interruption can leave the same recovery data.
Cancellation is honored through validation/source claiming; once publication starts it finishes
or rolls back rather than abandoning half a patch. Rebuild iOS for native ABI 10.

## Web access

Every local chat with at least an 8,192-token context includes `web_search` and `web_fetch` by
default, alongside the file and Git tools (see [Advertised tools by context size](#advertised-tools-by-context-size)).
There is no toggle, MCP configuration, account, or API key to set up.

Ask the agent to **search the web** with a normal query. `web_search` uses
[Exa's hosted search service](https://docs.exa.ai/reference/exa-mcp), one of the keyless backends
used by [OpenCode](https://opencode.ai/docs/tools/#websearch), and returns search text with source
URLs. Approval follows the global **Settings → Chat → Approvals** setting, also available in the
local profile. **Require all approvals** asks before Exa searches, HTTPS fetches, and model-requested
Git pushes. **Require some approvals** allows searches automatically but still asks for fetches and
pushes. **Require absolutely no approvals** bypasses all local tool prompts, including requests
already waiting for a decision. Switching back to a stricter mode gates subsequent tool calls.
The same setting is restored on startup, reconnect, and profile switches; it does not change native
workspace boundaries, input validation, or network limits.

Every tool declares its category and permission sensitivity in its definition. One shared policy
handles approvals and pending requests using that metadata, not tool-name exceptions. In
**Require some approvals**, permission-sensitive `read`, `search`, and `think` categories are
allowed automatically; other permission-sensitive categories still prompt. Model schemas contain
only the callable schema, not the runtime's approval metadata.

Each search query is sent to Exa; never include secrets or
private workspace content. Searches default to three results (maximum eight), cap returned text at 8,192 characters
with explicit truncation, and time out after 30 seconds. Exa's free keyless service is rate limited;
errors are shown rather than silently switching providers. This is a fixed search integration, not
general-purpose remote MCP server configuration. Inference still runs on the phone.

### Researching before answering

Small models answer from stale training data and can read an empty workspace search as proof that
something does not exist. Like OpenCode, the agent searches without being asked:

- The system prompt ends with `Today's date: …`, and the `web_search` description says to use it for
  current information beyond training data, such as libraries, APIs, products, and versions.
- An empty `search_files` result carries a note that the workspace not mentioning something does not
  mean it does not exist. The note deliberately does not say to search the web: that wording made
  models send this project's own symbols to Exa.
- Research guidance is tailored per model family, as OpenCode routes prompts per model. The same
  words push small models in opposite directions, so `runtime/systemPrompt.ts` maps each catalog
  family to the wording and position that measured best for it. Unknown models get the reminder.

| Family   | Guidance | Position                      | Why                                                                                                    |
| -------- | -------- | ----------------------------- | ------------------------------------------------------------------------------------------------------ |
| Qwen3.5  | reminder | After the identity sentence   | Already searches readily; firmer or final rules made it search the web for workspace code and thrash.  |
| Gemma 4  | reminder | After the identity sentence   | Already research-eager.                                                                                |
| LFM3     | reminder | After the identity sentence   | Needs its reasoning on (below); then it searched in 9 of 10 seeds and never sent project symbols out.  |
| Qwen3    | access   | After the identity sentence   | Otherwise told the user it had no access to the project or the web, and answered from memory.          |
| Bonsai 2 | direct   | Last instruction, before date | Otherwise said it could not browse; this took effect only as the final instruction, and `access` hurt. |

The access guidance first tells the model that its tools can read the workspace and search the web,
so it must call one instead of claiming it lacks access. The access and direct guidance also say to
use workspace tools, never `web_search`, for this project's own files and symbols. These choices
came from running the production `LocalModelSession`, agent loop, tools, and persistence against
each catalog GGUF in `llama.node`, which shares `llama.rn`'s llama.cpp completion core, over several
seeds. Re-measure on real models before changing the wording or position: a one-sentence change can
flip a family from never searching to leaking workspace code. Small models still sometimes explain
configuration from memory without searching, and Gemma 4 tends to ask for code rather than read the
workspace.

The read-only, curl-like `web_fetch` tool reads the resulting HTTPS pages or documentation URLs.
When approvals are required, each request
shows the destination URL for **Allow** or **Deny** before any network access; scroll the request
details to inspect long URLs in full. The URL and its
query are sent to that server; do not approve URLs containing secrets or private workspace content.
No cookies, authorization headers, request bodies, or workspace files are attached automatically.
Local inference still runs on the phone, without a desktop bridge or remote model.

Only HTTPS GET is supported. Redirects are reported, not followed: fetching their destination needs
another approval. Responses must be text, HTML, JSON, or XML. HTML is returned as source, not a
rendered page; JavaScript-only pages, sign-in, CAPTCHAs, and search-provider restrictions are not
bypassed. This is URL access, not a configured search-provider API.

Reads default to 4,096 text characters (maximum 16,384), with `offset` and `nextOffset` for further
chunks up to offset 262,144. `truncated` marks incomplete output. Each request has a 1 MiB download
budget and a 15-second deadline. **Stop**, backgrounding that stops the turn, and memory pressure
abort an in-flight request; declining approval or stopping while approval is pending sends nothing. Web failures
appear in the tool transcript and are returned to the model, with no silent offline fallback.

## Model downloads

- Up to two models download at once; further downloads wait in a visible **Queued** state and
  start automatically when a slot frees. Pause, resume, and cancel apply to one model at a time.
- Download actions return as soon as the transfer is accepted, so other models stay usable while
  it runs. Each model row shows its state in words ("Downloading 42% · 310 MB of 740 MB · 2 min
  left", "Queued", "Paused at 42%", "Verifying 30%", "Downloaded") with a progress bar that VoiceOver
  reads as a percentage; starts, completions, pauses, and failures are announced. Verification can
  be paused (the downloaded file is kept) or cancelled. Pause, resume, cancel, and delete act
  immediately on that one model; their errors stay on its row.
- Transfers use an iOS background URL session: locking the phone or switching apps does not stop
  them. If iOS terminates the app, a running transfer continues and is re-attached on the next
  launch; a transfer that finished meanwhile is verified when the app becomes active. Force-quitting
  from the app switcher makes iOS cancel the transfer; it resumes from its checkpoint next time.
- Free-space checks reserve the bytes still needed by every queued or running transfer, plus a
  64 MiB margin.
- Cancel discards partial data but never deletes an installed model; **Delete** does.

## Models and memory

The family-first catalog includes **LFM3**, **Bonsai 2**, **Qwen3.5**, and **Gemma 4**, with pinned public GGUF
variants. Qwen3.5 has 0.8B/2B choices across Q4, Q5, and Q8 formats; Gemma 4 exposes E2B Q4_0/Q8_0.
The original Qwen3 variants remain under **More families**, preserving existing downloads and chats.
Catalog artifacts are immutable; arbitrary model URLs/imports are not supported.

LFM3 uses Liquid AI's official **1.7B** text GGUFs in **Q4_K_M**, **Q5_K_M**, and **Q8_0**.
Downloads are pinned to revision `cd0c74c575b5c416f3011b5b4c298077f26ca8c2` with publisher
SHA-256 and size checks. Its hybrid convolution/full/sliding-attention architecture has an
FP16 KV estimate of 22,528 bytes per token (conservatively counting all eleven attention layers)
plus a 128 MiB prompt-state budget. Fresh app headroom selects a context up to the native
262,144-token maximum. The 4 GiB RAM-class floor is an admission estimate, not physical-device
certification. Vision, audio, Omni, decision, draft-head, and NVFP4 variants are not offered.
Unlike the existing Apache-2.0 entries, these weights use the
[LFM Open License v1.0](https://huggingface.co/LiquidAI/LFM3-1.7B-GGUF/blob/cd0c74c575b5c416f3011b5b4c298077f26ca8c2/LICENSE);
commercial use by entities exceeding its $10 million annual-revenue threshold requires a separate
license from Liquid AI. The model row links to the publisher's source and license.
Liquid AI does not recommend this small model for complex agentic coding or multi-step reasoning;
review its edits and keep approval prompts enabled.

LFM3 is the only catalog family that runs with its reasoning on (`thinking` in the catalog): its
model card makes reasoning the default and warns that disabling it is inconsistent. Measured with
the production prompt and all 30 tool schemas over ten seeds in `llama.node` (the same llama.cpp
b12211 core), reasoning-off LFM3 answered current library questions by inventing `skill` names or
listing the workspace (at best 5 of 10 called `web_search`, whatever the guidance wording or
position); reasoning-on called `web_search` in 9 of 10 and kept project symbols in workspace tools in
10 of 10. The cost is latency: a typical answer round adds about 200–400 reasoning tokens (up to
about 900), several seconds on a phone. The reasoning streams in the transcript as for desktop
agents. Rolling-summary rounds and capped child-agent rounds keep reasoning off, so it never
consumes their small output budgets.

LFM3 was also the model that exposed an ambiguous stopped-tool result: after a push stopped at its
approval prompt, it re-issued the push on the next turn in most seeds. A stopped approval now
returns "It did not run. Do not retry it unless the user asks.", matching a declined one; LFM3 then
answered from the next tool's result in 10 of 10 seeds, and Qwen3.5 was unchanged. A system-prompt
rule alone did not prevent the retry. Even so, a re-issued push would still have needed approval.

The native simulator gate (`modules/on-device-agent/README.md`) passes for LFM3 1.7B Q4_K_M at a
131,072-token context: complete tool schemas, a structured file read, tool-result use, the
stopped-push continuation, streaming, cancellation, unload/reload, and research routing (workspace
symbols stayed local on every seed; `web_search` on 2 of 3 seeds, consistent with the host rate).

Bonsai 2 exposes the publisher's 2B/4B ternary packings. Q2_0 uses upstream llama.cpp support.
PQ2_0/PTQ1_0 are displayed with an explicit unavailable reason: they require PrismML-specific
kernels that are not in this build. These packings contain the same ternary weights, not different
precision levels. Unsupported packings cannot be downloaded or passed to inference through the
controller APIs. The app does not download draft heads or multimodal projectors; these models run
text-only here.

The maintained `llama.rn` engine is pinned to `0.13.0-rc.10` (llama.cpp b12211) for LFM3 architecture
and tool-template support, retaining the Hadamard activation support needed by Bonsai 2 Q2_0.
This is a pre-release binding and requires a rebuilt native app
(on-device ABI 11 or later). Old binaries fail with a rebuild message rather than attempting unsupported
inference through a JavaScript-only update.

Compatibility uses physical RAM plus a fresh native app-memory-headroom measurement. A model's
minimum device RAM is the marketed size (for example 8 GB for Gemma 4 E2B Q4_0). iOS reports
physical memory somewhat below the marketed size because of GPU and system carve-outs, so the
reported value is rounded up to the device's whole-GiB RAM class before that comparison; the raw
value must still hold the model's estimate. Admission
includes weights, an FP16 KV cache at the model's minimum context (4,096 tokens), working space, the
prompt-state budget of hybrid/sliding-window models, and a 384 MiB reserve. When fresh headroom
allows, each load doubles the context from 4,096 through 8K, 16K, 32K and higher, up to the
pinned GGUF's native limit: **40,960** for Qwen3, **131,072** for Gemma 4 E2B, and **262,144**
for Qwen3.5, Bonsai 2, and LFM3. There is no global 16K cap and no extrapolated RoPE scaling.
The complete estimate, including the larger KV cache and reserve, must fit measured app headroom;
marketed device RAM alone never enables a tier. Reloading re-measures headroom, so another load can
choose a smaller or larger context. The loaded size is shown separately from the supported range.
This does not resize an active native context in place. The Models page credits the memory of a currently loaded model when
judging another one ("Loading replaces the current model in memory"), because loading always
releases the previous context first and then checks memory again. Free memory is re-measured every
few seconds while the page is open and whenever the loaded model changes, so there is no manual
refresh. A loaded model is not double-counted when starting generation.

iOS builds request Apple's `com.apple.developer.kernel.increased-memory-limit` entitlement (added by
`plugins/withOnDeviceAgentNative.js`) so local models can use the larger per-app limit iOS grants
on supported devices. It raises the limit `os_proc_available_memory()` reports; it is not a Jetsam
exemption, and admission still uses the fresh measurement. iOS can still reclaim memory or terminate
an app; admission is an estimate.

The three original Qwen3 variants have passed simulator CPU checks with the complete production tool
schemas, native file reads, JSON tool-result consumption, streaming, stop, and unload/reload.
Representative modern-family checks on ABI 6 also pass for Bonsai 2 2B Q2_0, Qwen3.5 0.8B Q4_0,
and Gemma 4 E2B Q4_0. These are native tool-calling checks, not just successful model loads.
Other size/quant variants share those architectures but do not constitute measured phone support.
Simulator headroom is explicitly labelled as host estimation. Physical-iPhone RAM limits, Metal
performance, thermal behavior, and offline battery use have **not** been certified. Do not publish
specific supported-phone or performance claims from simulator results.

Only one local context and one local turn run at a time. Each round measures the prompt with the
model's real chat template and tokenizer, then lets generation use all remaining context (minus a
small safety margin) rather than a fixed output cap, so long `write_file`/`edit_file` payloads are
not cut off. A round starts only if at least a quarter of the context (up to 2,048 tokens) remains
free. Low-level model callers without a conversation checkpoint use this elision path directly; normal
chats use it whenever semantic memory (below) is skipped or fails. Saved history stays unchanged:

1. Earlier turns' tool output is replaced by a short `{"elided": true, ...}` marker that keeps
   identifying fields such as `path`, `revision`, and `error`, and long earlier tool arguments and
   reasoning are dropped.
2. The oldest turns are omitted, with a note to the model.
3. Only if the current turn still does not fit are its older tool results elided.

The current user message is never removed. If a single turn cannot fit even then, it fails with a
clear message and the next conversation turn can continue. File reads default to 3 KiB chunks (16 KiB
maximum) and directory listings to 64 entries (200 maximum).

### Advertised tools by context size

Tool schemas and the system prompt are a fixed prefix in every round, so the advertised tools depend
on the loaded context. Advertisement only narrows the registered set; every advertised tool has a
dispatcher, and saved-output retrieval is always advertised.

- **4,096 tokens** (low-memory fallback): `list_directory`, `read_file`, `write_file`, `edit_file`,
  `search_files`, `git_status`, `git_diff`, `skill`, `read_tool_output`, `search_tool_output`, and
  `todo_read`.
- **8,192 tokens** adds `rename_path`, `delete_path`, `glob_files`,
  `apply_patch`, `git_history`, `git_stage`, `git_commit`, `git_push`, `web_fetch`, `web_search`,
  `ask_user`, and `todo_write`.
- **16,384 tokens** adds code intelligence, `format_file`, `task`, and `read_child` (all 30 tools).

Without web tools, the system prompt omits web rules and the family research cue rather than naming
absent tools. Tool descriptions keep only behavior-critical constraints (paging, size caps, read
before mutate, protected paths, untrusted web text); the dispatcher still enforces every bound.
Measured with the Qwen3 tokenizer and Hermes tool template (system prompt plus tool section, compact
JSON schema characters), the fixed prefix shrank from 15,920 schema characters (4,957 tokens, all 30
tools at every size) to:

| Context | Tools | Schema characters | Fixed prefix tokens                    | Room left with one generation reserve |
| ------- | ----- | ----------------- | -------------------------------------- | ------------------------------------- |
| 4,096   | 11    | 4,452             | 1,604 (was 4,957: no turn could start) | 1,436                                 |
| 8,192   | 23    | 9,638             | 3,101 (was 4,957)                      | 3,011 (was 1,155)                     |
| 16,384  | 30    | 12,671            | 3,903 (was 4,957)                      | 10,401 (was 9,347)                    |

Qwen3.5 measures about 30 tokens less. Real counts vary by family and skill catalog; tests assert
these tiers and their room with a conservative 3.5-characters-per-token approximation (measured
Qwen3 prefixes have more characters per token).

After earlier tool activity, model input labels the latest request as current and older workspace
observations as historical snapshots. This encourages fresh reads instead of stale answers after
edits or model switches; the stored user message and prior conversation remain unchanged.

Native tuning (verify on a physical iPhone): 4 CPU threads on device with every layer on Metal, 6 on
the CPU-only simulator, 512-token batches, one sequence, and native prompt-prefix reuse across rounds
(state snapshots for hybrid/sliding-window models). The chat template is rendered once per attempt
and that prompt is passed straight to completion.

### Saved tool evidence and rolling conversation memory

Normal local chats save large tool outputs outside the prompt, in app-private runtime documents,
never in the Git workspace. Outputs over 4,096 JSON characters return a 512-character preview,
an opaque `artifactId`, and small identifying/truncation fields. `read_tool_output` pages saved JSON
(2,048 characters by default, maximum 4,096); `search_tool_output` finds literal text in at most
10 excerpts per page. Both tools are restricted to the originating conversation and workspace.
They read historical evidence, not current files, and must not be replaced by replaying a mutation.

The saved result is the exact bounded output available from the producer, **not omitted upstream
data**. Agent web searches save returned Exa text before the legacy 8,192-character clipping;
agent fetches read/save the complete decoded response within the 1 MiB download cap before page
slicing. Oversized responses fail explicitly. Git status/history are captured before their
JavaScript list clipping, and agent diffs request the native maximum 128 KiB rather than 4 KiB.
Native diff/search/status limits and file/list pagination still apply; their `truncated`,
`nextOffset`, and other omission metadata remain authoritative.

Storage is capped at 2 MiB per serialized output, 8 MiB per conversation, 32 MiB total, and 128
outputs. There is no silent eviction or clipping at these caps: the turn fails with an explicit
completed-operation warning and bounded preview, so retry does not replay the tool. Delete old
conversations to free space. Evidence survives reload; deleting a conversation removes its evidence
and memory checkpoint, and startup finishes interrupted deletions without resurrecting history.
Artifacts associated with quarantined damaged conversations are preserved.

Before each generation, the resident model's real chat template/tokenizer measures the entire
prompt, including tool definitions. Memory only ever covers turns **before** the latest user
request: the current turn (request, tool calls and results) always stays verbatim, apart from the
elision of its older tool results when nothing else fits. The fixed prefix (system prompt and tool
schemas) and the current turn are measured separately, so only the conversation counts. With
_room_ = context − fixed prefix − one generation reserve − 32, a summary is generated only when all
of these hold:

- fewer than **two generation reserves** remain (each a quarter of context, capped at 2,048 tokens,
  plus the 32-token safety margin), and the conversation leaves less headroom in _room_ than one
  reserve (or half of _room_ when smaller);
- earlier turns exist and fill more than half of _room_, so a large fixed prefix or a large current
  turn alone never forces it;
- the current turn still fits beside a full-size memory.

The same model then generates a rolling semantic summary with no tools. Oversized transcripts are
processed in token-sized chunks, at most 64 rounds. Each round may generate at most
min(1,024, a quarter of context, a quarter of _room_) tokens, so memory at least halves earlier
history; the model is told the memory size derived from that cap (1.5 characters per token: about
1,130 characters at 8,192 tokens with that tier's tools, so even hash- and ID-dense memory finishes
within the cap). A summary that stops at the cap is rejected rather than kept partial. The summary is
durably journaled with the last message before the current request, model ID, and timestamp before
answering resumes.

The summary prompt retains user requests, decisions/constraints, pending work, completed mutations,
uncertainties and observed evidence; saved artifact references are included independently of model
wording. Original messages/tool intent remain intact: semantic memory is **not** journal-file
compaction. “Summarizing conversation” activity remains stoppable, and stop or background/memory
interruption fails the turn as before. A summary that fails, is empty, truncated, stops at its cap,
or whose proposed prompt does not fit, and a checkpoint that cannot be saved, are **not committed**:
the round falls back to the elision path above with history unchanged and the previous checkpoint
retained, and the status returns from summarizing to generating. The same earlier history is not
summarized again in that turn; a later turn tries again. Low iOS memory headroom still fails the
turn.
Workspace rules, persistent tasks and rolling memory preserve each family's research-cue placement
and the authoritative date footer. Physical-iPhone inference quality/performance still require device
validation; deterministic tests use the real JavaScript loop/session/repository with scripted
inference and isolated filesystem persistence.

## Tool and lifecycle boundaries

- Automatic App Store review requests wait for an idle chat surface after local preparation,
  running turns, and tool approvals settle. A focused composer or unsent draft also defers them,
  including with a hardware keyboard. They do not appear in model settings or file/Git editors.
- Git initialization remains UI-only. The model's capability guidance directs requests for
  `git init` to DapperCode's **Git > Initialize Git** from the chat's Git button, not a separate app.
  Unavailable shell, package, and test commands must not be emulated through file or Git mutations.
- A tool-result continuation includes an empty assistant prefill in model input, so native chat
  templates open a fresh model-generation boundary rather than immediately returning EOS. The
  prefill is not saved as a message, adds no user prompt, and never replays completed tools.
- Authoritative local history retains client-only notes, such as a prior Stop notice, but does not
  resurrect an optimistic user message once its real submitted message is present.
- Live tool results use the same message identity as their saved ACP projection, so revalidation
  does not print a result twice. **Show tool calls** applies to both live and saved output without
  hiding approval controls or changing which tools execute.
- Expanded results render opaque immediately; row-height changes still honor system Reduce Motion.
  Touching a settled tool row does not enable native scroll anchoring underneath the finger.
- Deleting the selected conversation returns to **New chat** while keeping the session list open.
  An explicit close takes precedence over that navigation; other conversation histories remain intact.
- Tools can list/read/write/exactly edit/rename/delete/search inside the selected app-private
  workspace. Paths cannot escape through traversal, symlinks, hard links, or Git metadata.
- File tools and local Git changes run automatically within that workspace. Small models can
  omit requested steps or make unwanted tool calls; a "do not change files" instruction is not an
  enforced read-only permission mode. Use disposable workspaces and inspect actual file/Git changes.
  Chat `git_push`, `web_fetch`, and `web_search` request explicit approval unless the app's global
  **Require absolutely no approvals** mode is enabled.
- Like OpenCode's doom-loop check, the third identical consecutive tool call (same name and
  arguments) is not run; the model gets an error telling it to use the earlier result or answer. A
  fourth stops the turn as interrupted with a visible notice. Alternating between different calls is
  not detected; a turn still stops after 32 model rounds.
- Replacing existing files requires their last read revision. Output, search, and file sizes are
  bounded; truncation is explicit.
- The runtime remembers file versions from successful reads/writes within the same turn and
  workspace; the model does not copy opaque revision strings. Every mutation still checks that
  observed version natively. External changes require another explicit source-file read; the
  runtime never silently refreshes a version before writing. A rename destination must not exist.
- Git uses linked libgit2, not a Git executable. Hooks, shell commands, package managers,
  interpreters, test runners, downloaded executable plugins, and JIT workarounds are unavailable.
  SSH, submodule/LFS hydration, custom providers' private credentials, and force-push are out of scope.
- The workspace root is the empty path `''` everywhere (`'.'` is accepted as an alias for listing).
  `~` is a literal workspace-relative name, not a shortcut to the phone's home directory.
  Directory listing, search, and size walks normalize the trusted storage root to its physical
  filesystem path before checking containment, so iOS `/var` and `/private/var` aliases do not
  break resumed workspaces. Entry symlinks are still never followed.
  The Files screen (from the Git screen or the workspace picker) creates files in the open folder,
  shows the total size of large read-only previews, renames (touch and hold) or deletes (swipe)
  entries, and refreshes when a native change token moves after agent edits.
- Git status reports origin, upstream, ahead/behind counts, and staged-file counts. Push, fetch, and
  pull are disabled without an origin; commit is disabled (and rejected natively) with nothing staged.
- Pull fetches origin and only fast-forwards. Diverged histories (`GIT_NON_FAST_FORWARD`) and local
  changes the update would overwrite (`GIT_CONFLICT`) are rejected before anything changes. Fetch and
  pull share push's HTTPS-only, origin-bound credential, redirect, cancellation, and timeout rules.
  The first push of a new branch records `origin/<branch>` as its upstream.
- Discard restores working-tree files from the index (staged content is kept); discarding a single
  untracked file deletes it, and discard-all removes untracked files only when asked. Ignored files
  (including inside untracked folders) and files staged for deletion but still on disk are never
  removed; unstage a staged deletion before discarding it.
- Native failures reach the UI as `OnDeviceNativeError` values with stable codes (for example
  `GIT_NOT_REPOSITORY`, `PATH_OUTSIDE_WORKSPACE`, `GIT_NO_ORIGIN`) and never include native exception
  names or Swift source locations. These capabilities require on-device ABI 7.
- Clone, fetch, pull, and push progress is pushed by the native module as the
  `onGitTransferProgress` event (ABI 8): once when a transfer begins, is cancelled, or ends, and at
  most every 100 ms (plus the final object) while objects arrive. `getGitTransferProgress` remains for
  a single read.
- `getWorkspaceSize` (ABI 9) returns `{ bytes, files, truncated }` for a workspace: allocated bytes
  of its regular files, Git metadata included. It never follows symbolic links, stays inside the
  workspace, and stops after 50,000 entries or 2 seconds with `truncated: true`.
- Git diffs label staged (HEAD to index) and unstaged (index to working tree) patches separately.
  Opposing changes are not collapsed away; only the staged content is committed. Both sections,
  including their labels, share the reported output byte limit.
- File, status, diff, history, stage, and commit tools run without per-tool approval. A
  model-requested `git_push`, `web_search`, and `web_fetch` follow the global approval setting described
  above; declining a requested approval
  returns a tool error to the model, and Stop leaves the push unrun. Manual pushes from the Git
  screen are user actions and are unaffected. Desktop approval settings are unchanged.
- Stop waits for current tool work to settle. Stop during a model load settles the turn immediately;
  the native load cannot be aborted, so its context is released as soon as it returns. Git
  cancellation is cooperative; unresponsive transports have a 15-second connection/read/write
  timeout. A cancelled push may already have reached its remote.
- A message is recorded (journaled), and the composer draft cleared, only after the model has
  loaded. If loading fails or is stopped, the draft stays in the composer. A failed or stopped turn
  can be retried: an answer with no tool activity is regenerated, and a turn whose tools already ran
  continues from their recorded results. Tools are never replayed. Like sending, retrying waits for
  a pending model load/unload and is refused during workspace operations, backgrounding, or disposal.
- A generation failure is a conversation failure; the resident model stays loaded and ready.
- A running turn keeps going after the phone locks or the app moves to the background, unlike a
  desktop connection, which disconnects to save battery. See
  [Running while the phone is locked](#running-while-the-phone-is-locked).
- Otherwise, only moving to the **background** stops local work, unloads the context, and flushes
  drafts/history; model downloads keep running (see [Model downloads](#model-downloads)).
  Transient `inactive` states (Control Center, Notification Center, the app switcher, calls,
  Face ID, system alerts) do not interrupt anything. At startup and on each return, downloads are
  re-attached, transfers or verification the system interrupted continue (once the network is
  reachable), and the previously loaded model is reloaded if memory admission still passes.
  Interrupted turns are not resumed or replayed.
- A memory warning stops local work and unloads the context but leaves downloads running.
- Unrelated actions never stop a running conversation. Selecting the already-loaded model,
  choosing a workspace for new conversations, deleting an unrelated download, and signing out (when
  no Git transfer is active) proceed alongside the run. Actions that would replace or remove the
  model a run is using are rejected with an explanation instead of silently stopping it.
- User turns and tool intent are journaled before execution. After an interrupted launch, uncertain
  tools are marked interrupted and are **never automatically replayed**. Inspect the workspace and,
  for push, the remote before retrying. Streamed text, tool results, and run settlement are
  coalesced into one write shortly afterwards (and on backgrounding). The stored conversation is
  authoritative: after a crash, the chat shows what was recovered, dropping any streamed output the
  app displayed but had not yet stored, rather than waiting for missing history.
- Conversations are stored append-first (`runtime/threads.ts`, `runtime/threadJournal.ts`) using
  only the native runtime-document store. `thread-<id>.json` is the base: the whole conversation
  plus `segment`, the last journal position it contains. Each save after that writes one small
  `threadseg-<id>-<position>.json` segment holding only what changed (conversation fields, updated
  or new messages, removed message ids), so a tool turn writes a few hundred bytes per journal step
  regardless of conversation length. A segment is durable before the step it journals continues.
  Run settlement is an ordinary segment too. The journal is compacted into a new base only when a
  change would exceed a 512 KiB segment, or when the journal reaches 64 segments or the base's size
  (at least 256 KiB), so settling a turn no longer rewrites the whole conversation; every document
  stays far below the native 8 MiB limit. Change detection compares message objects (which are
  never changed in place) by identity, so a save serializes only the messages it writes. The base
  is written first and the segments it contains are removed afterwards, so a crash at any point
  replays to the same conversation.
- A failed native write may already have reached disk. Recovery writes an acknowledged corrective
  segment even if memory returned to the cached state; it never clears a failure by skipping that
  write. An unacknowledged base remains marked for replacement, and a recovered base advances past
  any potentially written next segment, preventing a rejected model choice from reappearing later.
- At startup, the contiguous segments after the base are replayed; segments the base already
  contains (an interrupted compaction) are discarded. A damaged, unreadable, or out-of-order segment
  ends the replay: it and every later segment are set aside with their bytes preserved, the
  conversation opens at the last good step, and its next write is a new base positioned past every
  set-aside segment, so no name is ever reused. A segment that cannot be moved is left in place
  and recorded in the base's `skipped` list, so it is never applied or deleted as already folded;
  it is set aside at a later start. A damaged base is set aside together with its segments (and
  stays in place while any of them cannot be moved).
- Whole-conversation documents from older builds (no `segment`) are read as a base and rewritten
  once as a positioned base on their first save, before any segment follows them. Because an older
  build ignores segments and rewrites the base without `segment`, segments found next to such a
  base are never applied: they are set aside with their bytes preserved and the base's content
  wins. Deleting a conversation removes the base first and then its segments; segments left
  without a base by an interrupted delete are discarded at the next start.
- Composer drafts are the shared chat drafts, stored per profile and chat exactly like desktop
  chats; the runtime never writes drafts. Unsent drafts from older builds (inline in
  `preferences.json` or in per-conversation `draft-…` documents) are imported once into the
  composer's store for the matching local chat before any local chat opens
  (`shell/runtime/localDraftImport.ts`). The runtime removes its copies only after that write
  succeeds, so a failed import is retried at the next start and never loses text. A chat that
  already has a newer composer draft keeps it; the older text is set aside with its bytes preserved
  and a notice. Deleting a conversation also deletes any legacy draft it still has.
- Startup is not fail-closed. Damaged or unexpected conversation, draft, or settings files are
  moved to a `quarantine-…` name with their bytes unchanged (or skipped and left in place when they
  cannot be moved), a dismissible notice explains what happened, and the rest of the mode starts.
- Problems are reported as typed issues: persistence failures (retryable, cleared by a later
  successful write), transient operation failures, and startup recovery notices. All are
  dismissible and several can be shown at once. Settings → On this iPhone lists them, the drawer
  status points there, and VoiceOver announces each new issue once.
- Network reachability is observed with `expo-network`. When the device is known to be offline,
  clone, push, sign-in, and model downloads fail immediately with a friendly message.
- There is no automatic desktop/cloud fallback or synchronization of local workspaces.

### Running while the phone is locked

Each send or retry asks iOS for background time before the turn is admitted
(`runtime/runActivity.ts`, native `LocalRunActivity.swift`):

- On iOS 26 and later, the turn runs as a user-initiated continued-processing task
  (`BGContinuedProcessingTask`, identifiers `<bundle id>.localrun.<n>`, permitted by the
  `withOnDeviceAgentNative` config plugin). iOS shows its progress as **Local agent** with a
  generic phase subtitle (**Generating on this iPhone**, **Running read_file**, **Waiting for your
  approval**…). Conversation text, approval summaries, and questions never appear on the Lock
  Screen. Progress is reported every 5 seconds in every phase, including approval and question
  waits, so you can unlock and answer.
- Earlier iOS versions, or a continued-processing request iOS refuses, fall back to ordinary
  background task time, which iOS limits to about 30 seconds. The turn is told to stop once about
  10 seconds remain, so it can still unload the model and save before iOS suspends the app.
- Without either, backgrounding stops the turn as before.

While the app is in the background, Metal refuses GPU work, so the next completion (or one whose
native decode failed) reloads the same model with the same context size on the CPU and continues.
Generation is slower there. After a return, the next completion moves back to the GPU. A decode
that keeps failing after two reloads fails the turn with **The local model could not evaluate the
prompt. Try again.** A turn that settles while the app is in the background unloads its model and
flushes state before it gives the time back; the model warms again on return. So does a turn
refused at admission after the phone locked. Reloading JavaScript ends every activity the previous
runtime held.

If iOS ends the time first, or you cancel the task from the system UI, the turn stops with **iOS
ended background time for this turn. Completed edits are preserved; retry to continue.**
A memory warning still stops the turn.

## GitHub configuration

DapperCode bundles its registered **public client ID**, so GitHub Device Flow sign-in is available
without additional build configuration. No client secret is needed or included.

For a fork, register your own GitHub OAuth app with Device Flow enabled and override
`EXPO_PUBLIC_GITHUB_CLIENT_ID` in the build environment (or `apps/mobile/.env`). An explicitly empty
value disables sign-in, including in isolated native test bundles. Rebuild the JavaScript bundle
after changing this value; existing installed builds do not acquire it automatically. Public
clones, local commits, and offline inference do not require sign-in.

The user authorizes the displayed short-lived code on GitHub. The requested `repo` scope enables
private clone/push. Tokens are held in a separate device-only Keychain service; JavaScript stores
only an opaque credential reference, and models cannot read tokens. Credentials are restricted to
the authorized HTTPS origin. Redirects are not followed.

The current app does not refresh expiring GitHub tokens. If token expiration is enabled for the
OAuth app, sign in again when GitHub expires the credential.

Signing out removes the local credential, not GitHub's authorization. Revoke the OAuth application
in GitHub account settings when necessary. Other authentication providers can implement the
feature's `GitProviderAuthStrategy`; the agent loop and file tools are provider-independent.

## Unified shell architecture

The chat shell has no local-mode branches. The local agent speaks the bridge's JSON-RPC protocol
in-process, so `HostBridgeApiClient`, `MainScreen`, the drawer, and the Git and workspace screens drive
it unchanged.

```text
MainScreen / drawer / Git / picker ── HostBridgeApiClient ── HostBridgeWsClient seam
                                                                  │
                                    shell/runtime/LocalBridgeWsClient (extends it, no socket)
                                                                  │
                         features/on-device/transport/LocalBridgeServer (wire shapes + events)
                                                                  │
                         LocalAgentPort ── runtimePort.ts ── OnDeviceRuntime (models, loop, Git)
```

### Profile model

- `shell/state/localProfile.ts` defines the built-in profile (`LOCAL_PROFILE_ID = 'on-device'`) and
  the `ShellProfile` union. Bridge profile ids are `bridge-…`, so the id cannot collide.
- `bridgeProfiles.activeProfileId` may be `'on-device'`; the local profile itself is never stored.
  `activeProfileAtom` resolves it only when `localProfileAvailableAtom` is true: iOS with the
  on-device native module at the expected ABI (`shell/runtime/localProfileSupport.ts`). Android, web,
  and old builds fall back to a bridge profile or onboarding.
- `activeBridgeProfileAtom` is bridge-only (`null` while the local profile is open). Use
  `activeProfileAtom`/`activeProfileIdAtom` for anything profile-scoped (routes, caches, drawer).
- Migration: a persisted `settings.preferredExecutionTarget === 'on-device'` becomes
  `activeProfileId = 'on-device'` when app state loads, and the setting no longer exists.
- Startup restores the chat snapshot cache of the resolved active profile, including the local
  profile, so a relaunch reopens the last local chat.
- `defaultStartCwdAtom` keeps a separate `localDefaultStartCwd`, so local workspace paths never
  become a desktop bridge's new-chat path.
- Routes are the regular `/profiles/on-device/(drawer)/…` routes. There are no separate local
  screens: links from older builds (`/on-device/*`) are redirects in `src/app/on-device`
  (`shell/navigation/legacyOnDeviceLinks.ts`) to the matching profile route — the old home and
  `chat/[threadId]` to chats, `models` and `models/[familyId]` to Settings → Models, `account` to
  Settings → Git & GitHub, and anything else to a new chat.

### Runtime ownership and lifecycle

`shell/runtime/LocalRuntimeHost.tsx`, mounted once by `RootLayout`, owns the single
`OnDeviceRuntime` through `OnDeviceProvider` while the local profile is open. While the runtime
starts, the host draws nothing and `ProfileRouteBoundary` shows its **Opening On this iPhone**
indicator, exactly as for a bridge profile. If it fails to start, `LocalRuntimeRecovery` covers the
shell with a standard Settings page: the error notice (announced as an alert), **Retry without
resetting storage**, and ordinary profile switches (`LocalProfileExit`; with no desktop profile the
local profile is closed before onboarding opens). The host never renders over `/onboarding`. When
ready, the host publishes
`localRuntimeAtom` and a `LocalBridgeWsClient` in `localTransportAtom`; `wsClientAtom` returns that
transport for the local profile, and `ProfileRouteBoundary` keeps local routes in their loading
state until it exists. Leaving the profile unmounts the host, which disposes the transport and the
runtime (stop, unload, pause downloads, cancel sign-in) — every exit path is the same.

Profile lifecycles in `useAppBridgeLifecycle` keep running (capabilities, prefetch, snapshot cache),
but WebSocket foreground/background handling, push presence, and push registration are skipped for
the local profile. `LocalBridgeWsClient` is connected from creation until disposal and ignores
`disconnect()`.

### Implemented RPCs

`LOCAL_IMPLEMENTED_METHODS` in `transport/server.ts` is authoritative:

| Area       | Methods                                                                                                                                                                                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session    | `bridge/capabilities/read`, `bridge/health/read`, `thread/approvalPolicy/set` (accepted, no approvals locally)                                                                                                                                                |
| Chats      | `thread/list`, `thread/loaded/list`, `bridge/thread/list/stream/start`/`cancel`, `thread/read`, `thread/start`, `bridge/thread/create`, `thread/name/update`, `thread/delete`, `thread/config/set` (model), `thread/resume`                                   |
| Turns      | `bridge/thread/queue/send`, `turn/start`, `turn/interrupt`, `bridge/turn/retry` (local only), `bridge/thread/queue/read`, `bridge/thread/schedules/read` (always empty)                                                                                       |
| Models     | `model/list` (downloaded, runnable catalog models with load state in `description` and the new-chat model as `isDefault`)                                                                                                                                     |
| Workspaces | `bridge/workspaces/list`, `bridge/fs/list` (workspace roots only), `bridge/git/clone` (HTTPS, into a new workspace)                                                                                                                                           |
| Attention  | `bridge/approvals/list`, `bridge/approvals/resolve` (the loop's pending tool approval, such as a push), `bridge/userInput/list` (always empty)                                                                                                                |
| Git        | `bridge/git/status`, `diff`, `history`, `branches`, `stage`, `stageAll`, `unstage`, `unstageAll`, `commit`, `switch`, `push`                                                                                                                                  |
| Extensions | `workspace/list`, `states`, `select`, `create`, `rename`, `delete`, `changeToken`, `clone/progress`, `clone/cancel`, `workspace/git/fetch`, `pull`, `init`, `discard`, `branch/create`, `workspace/files/list`, `read`, `write`, `create`, `rename`, `remove` |

The transport forwards each native progress event as the host notification
`workspace/clone/progressChanged` (params match `workspace/clone/progress`) while the server is
started.

Every other method rejects with JSON-RPC `-32601` and `data.error = 'unsupported_on_device'`
(surfaced as `RpcRequestError`). Other stable `data.error` reasons are `thread_not_found`,
`on_device_model_required`, `on_device_workspace_required`, `on_device_busy`, `on_device_offline`,
`on_device_not_repository`, `on_device_subagent_read_only` (a mutating call such as `turn/start`,
`thread/resume`, or `thread/delete` named a task child's thread), `on_device_interrupted` (a send or
retry stopped while its model was still loading; nothing was recorded), and `on_device_failed`; typed native failures also carry
`data.nativeCode`. While a send or retry loads its model, `thread/read` lists it as an in-progress
turn with no items, so the shell's Stop (`interruptLatestTurn`) can find and cancel the load. Git
file paths are passed through exactly as sent; only an explicit `null` path discards every file. A tool approval requested by the agent loop is sent as
`bridge/approval.requested`/`bridge/approval.resolved` with the bridge's `commandExecution` kind
(the banner shows the tool's summary as the command), so the shared approval banner answers it,
including Deny. Only one local chat runs at a time; there is no queue or steering.

`bridge/turn/retry` (`transport/retry.ts`) continues a failed or interrupted turn in place through
`runtime.retryTurn`, without resending the user message or replaying tools. It resolves with the new
turn id once the run has started. A failed thread's snapshot lists its last turn as `failed` with
the runtime's message, so a reopened chat shows the failure.

Local workspaces are presented as `/On this iPhone/<name>` paths (`transport/wire.ts`). The shell
stores only these strings (the new-chat default, each chat's `cwd`, the Git screen), so a path
depends only on its own workspace and is never re-resolved onto another one:

- Names are unique case-insensitively. `workspace/create` and `bridge/git/clone` number a taken
  name (`app 2`, `app 3`); `workspace/rename` onto another workspace's name fails with
  `on_device_workspace_name_taken`. `Workspace unavailable` (the path of chats whose workspace was
  removed) is reserved.
- Names that older builds let workspaces share are presented as `<name> (<id6>)` for every member,
  never "first one bare". A tagged path resolves by its id tag alone, so it keeps working after a
  rename or once the name is unique again; a bare path resolves only while exactly one workspace
  has that name. Anything else fails with `on_device_workspace_required` instead of guessing.
- The transport also follows the `workspaces` slice: when a chat's presented path changes (its
  workspace was renamed or removed) it sends `workspace/thread/cwdChanged` (`{ threadId, cwd }`),
  which updates the open chat, the cached chat, and the drawer.
- `LocalPresencePublisher` repairs `localDefaultStartCwd` whenever workspaces or preferences change:
  a remembered path that no longer resolves becomes the workspace a new chat would fall back to,
  or is cleared, so the drawer's readiness and `thread/start` always agree.
  Presence reads the repaired path directly from the store and follows its changes immediately;
  queued runtime updates cannot republish a stale "Needs a workspace" state.
  The setup checklist and profile summary resolve that same remembered workspace, rather than
  requiring a separate runtime preference after deletion. Their fallback order matches chat
  creation: a valid preference, a surviving recent chat's workspace, then the only workspace.

Git refreshes preserve an explicit branch choice while that branch still exists. Unchanged default
choices follow a changed HEAD, while a removed branch falls back to the current branch; background
polls and late branch-panel responses do not silently disable the user's pending Switch action.

A chat's model is an ACP config option (`id: 'model'`), so the existing model sheet changes
it through `thread/config/set`, which also makes it the default for new chats without loading it.
Before a chat exists, the capability-gated host extension `model/default/set` saves the default
without creating a conversation or loading a model. Local new chats take the default from
`model/list.isDefault`, including after a Settings change. Model choices are saved in order,
and a failed preference write restores the previous choice rather than acknowledging success.
While the device-model picker is open, it refreshes its catalog once a second so a background
download appears as soon as verification completes; closing the picker stops that polling.
Existing-chat choices also restore the chat model when either the thread or default write fails.
The preference store publishes a model default only after its write succeeds, and serializes
other preference saves from the latest confirmed state when their queued writes run. A concurrent
workspace or author save cannot persist a rejected model choice or clear a persistence warning
unless it has saved all current settings.
Deleting a conversation fences every conversation write queued during or after the deletion, so
a failed model-choice rollback cannot recreate the deleted conversation. While a model's weights
are being deleted it is hidden from the picker, and choosing, loading, sending or retrying on it
is rejected until removal settles.
Send, Retry, and competing model/workspace changes are rejected while a model choice is still
saving. The composer also waits for its pending model configuration acknowledgment, so Send
cannot overtake a newer queued choice. An unadmitted request keeps its draft and can be sent again
after selection settles.
An uncertain configuration response is read back before clearing the pending choice; a failed
read-back keeps Send blocked with an explicit reselect instruction rather than inferring success
or reverting to a potentially stale model. Profile/transport disposal fences late configuration
and catalog callbacks from the next screen lifetime.
Stopping an unadmitted model load does not carry that Stop request into the next submitted turn.
`thread/create` falls back to the runtime's remembered workspace and
model when the composer sends none or a desktop path.

### Capability flags

- Wire capabilities (`localCapabilities()`): one agent, `threadDelete` only; steer, fork, plan mode,
  review, browser preview, bridge UI surfaces, and fast mode are false, so the shell hides them.
- Client profile features (`activeProfileFeaturesAtom`): `attachments`, `pushNotifications`,
  `connectionSettings`, and `browserPreview` are false for the local profile; `managedWorkspaces`,
  `workspaceFiles`, `gitSync`, `gitDiscard`, `gitBranchCreate`, `gitInit`, and `turnRetry` are true
  only for it (see [Workspaces, Git, and Files](#workspaces-git-and-files)). The composer disables
  attach/paste, the drawer hides **Browser**, and Settings hides notifications and approvals. With
  `turnRetry` the composer's failure alert offers **Retry**, which calls `bridge/turn/retry`
  (`features/chat/turn/turnRetry.ts`). `modelLibrary` is also true only for the local profile: the
  model sheet then uses device wording, hides the agent-side "Use server default" row, labels an
  empty choice "Choose a model", and links to Settings → Models. The local API client reads
  `model/list` fresh each time (`modelListCacheTtlMs: 0`) because downloads and loads change it.
- The agent mode chip is hidden once the agent's capabilities are known and it offers a single
  mode (no plan mode and no advertised ACP modes), which is the case for the local agent.

### Status, readiness, and activity

- `LocalRuntimeHost` publishes `localAgentPresenceAtom` (`shell/runtime/localAgentPresence.ts`):
  the agent status line from `localAgentStatus` and new-chat readiness from
  `localConversationReadiness`, using the same model and workspace fallbacks as the server. It is
  null for desktop profiles. The drawer footer shows the status line (with a dot for ready, busy,
  attention, and error), and the empty new chat shows the readiness reason with **Get a model**
  (`LOCAL_SETUP_DESTINATIONS.models`) when no model is usable; suggestions are hidden until a chat can start. When the
  local new-chat workspace is unset, the host seeds it with the workspace the agent would use.
- Run phases stream as the `dappercode.dev/activity` custom AG-UI event (`bridge/runActivity.ts`).
  The loop loads the model before it records the message, so load progress is sent for the turn
  the loop is starting before `RUN_STARTED`; a failed or stopped load stays a rejected send (the
  draft is kept) rather than a run. Phases:
  `Preparing`, `Loading <model> · N%`, `Generating`, the running tool's action (for example
  `Reading README.md`, from `describeLocalTool`), `Stopping`, and `Saving`. The shell shows the
  title (and detail) in the transcript activity row instead of a rotating working phrase; a later
  generic "Working" from the shell does not replace a reported phase. VoiceOver hears reported
  phases (not progress) and the completion of a turn the screen watched running, never the
  shell's own transitions such as opening a settled chat.
- Tool titles come from `describeLocalTool`. Like the Rust bridge, an interrupted tool keeps the
  wire's `failed` status and adds `interrupted: true` (in `tool-meta` and the snapshot), so the
  transcript shows it neutrally, for example "Stopped editing src/app.ts".

### Streaming

The runtime publishes state, not events. `LocalEventProjector` (`transport/events.ts`) diffs each
thread against the last state it delivered and emits the bridge notifications the shell already
consumes: `thread/started`, `thread/name/updated`, `thread/deleted`, and `bridge/agui.event` with
`RUN_STARTED`, reasoning and text message start/content/end, `TOOL_CALL_START/ARGS/END/RESULT`, the
`dappercode.dev/tool-meta` custom event, and `RUN_FINISHED` or `RUN_ERROR` (`code: 'interrupted'` for
stops). Snapshot message, reasoning, and tool ids match the event ids, so the reload the shell
performs after a run converges with what was streamed. Text that is not an append of the streamed
draft is corrected by that reload.

### Workspaces, Git, and Files

The shared screens serve the local profile through the transport; nothing branches on "local".

- **Workspace host extensions.** Methods beyond the Rust bridge contract are declared once in
  `features/workspace/api/protocol.ts` (`WORKSPACE_HOST_METHODS`) and called through
  `WorkspaceHostClient` (`workspaceHostClientAtom`). They are only called when the active profile
  advertises the matching `activeProfileFeaturesAtom` flag, so desktop bridges are never asked.
  They are deliberately outside `src/bridge`, whose requests must match the contract manifest.
  `transport/workspaceHandlers.ts` and `transport/gitHandlers.ts` implement them over
  `LocalAgentPort` (`git`, `workspaceAdmin`, `files`, `network`), with mutations serialized by
  `runtime.workspaceTask`.
- **Git status** keeps the bridge shape: untracked files are stageable, `raw` starts with the
  porcelain `## branch...upstream [ahead n, behind m]` header, and an optional `remote`
  (`GitRemoteState`: origin, upstream, ahead/behind, detached, unborn, reachability) lets the Git
  screen disable push, fetch, and pull with a reason. Typed native failures reach the screen as
  `data.nativeCode` and are shown through `describeHostError` copy; `on_device_not_repository`
  turns into the **Initialize Git** card (`gitInit`).
- **Git screen** (`features/git`): human change labels, swipe-to-discard per file and a
  press-and-hold **Discard all** (no dialogs; discarding never touches staged or ignored files),
  **Fetch**/**Pull** (fast-forward only), and branch creation in the branch panel. With
  `managedWorkspaces` the workspace row is read-only and links to Files.
- **Workspace picker** (`picker/ManagedView.tsx`, `managedWorkspaces`): a flat list from
  `workspace/list` with branch and origin, tap to use, touch-and-hold to rename or browse files,
  swipe to delete, plus **New workspace** and **Clone repository**. After the list renders,
  `workspace/states` adds each repository's working tree (**Clean** or **N changed**) and every
  workspace's size (for example "main · Clean · 42 MB") in one request; the transport caches both
  until the workspace's change token moves, so reopening the picker reads Git status and walks the
  folder only for workspaces that changed. A failed part is retried on the next open. Size is
  native `getWorkspaceSize` (ABI 9): allocated bytes including `.git`, symlinks never followed,
  bounded to 50,000 entries or 2 seconds off the workspace actor; a bounded walk reads
  "Over 42 MB". The workspace in use carries a checkmark and
  `accessibilityState.selected`; tapping it does nothing and its menu has no **Use** action.
  Choosing a workspace also calls
  `workspace/select`, so the runtime's remembered workspace (first-run setup, new-chat fallback)
  matches the picker. The clone screen validates
  HTTPS (`api/remoteUrl.ts`), derives the name from the URL, follows `workspace/clone/progressChanged`
  notifications (with one `workspace/clone/progress` read when it subscribes; no polling), and
  offers **Stop**.
- **Files** (`features/workspace/files`, route `chats/[chatId]/files?cwd=…`, `workspaceFiles`):
  grouped-list browser and monospace editor. Edits are explicit: a dirty dot, **Save**, and leaving
  a dirty file or the screen is refused with an inline Save/Discard banner. The listing follows
  `workspace/changeToken`, so agent edits appear without re-entering; a dirty file that changes on
  disk is flagged and a stale save offers **Overwrite** or **Discard edits**. Files over 64 KiB open
  read-only with their total size.

### Extension points for the next tracks

- **Chat parity** (activity, tool titles, errors, retry): implemented as described above. Run
  failures arrive as `RUN_ERROR` with the runtime's message; add richer error data in `events.ts`
  `finish()` and in `server.ts` error reasons rather than branching in `MainScreen`.
- **Git, workspaces, files**: implemented; see [Workspaces, Git, and Files](#workspaces-git-and-files).
- **Models and account in Settings**: `features/settings/LocalProfileSection.tsx` links to
  `routes.settingsModels` (`settings/models`, `settings/models/[familyId]`) and
  `routes.settingsGitHub` (`settings/github`), built from `SettingsGroup`/`SettingsRow` in
  `features/settings/local`. Those pages read the runtime from `localRuntimeAtom`. GitHub device-flow
  progress lives in `localSignInAtom`, so leaving the page never cancels a sign-in.
- **Discovery and onboarding**: every "where to run" surface lists the same `shellProfilesAtom`
  through `shell/profiles`: `useProfileChoices` (profiles with live state plus **Add bridge**),
  `describeProfile` (the only place that varies copy, icon, and status by profile kind), and
  `openProfileAtom`. Onboarding offers `OnDeviceEntry` beside pairing when
  `localProfileAvailableAtom` is true and words its hero for the choices actually offered. The
  drawer's **Runs on** row (`DrawerProfileRow`) and the new-chat capsule (`NewChatRunTarget`) open
  the same sheet; Settings' Connection/Profiles rows use the same presentation, so the local row
  reports setup (`Needs a model`, `Ready`) rather than a connection.
- **First-run setup**: `useLocalSetup` derives model and workspace steps from the open runtime via
  `localConversationReadiness`, resolving the model the way the server's `resolveModel` does (the
  selected model when downloaded, otherwise any downloaded runnable model, otherwise a download in
  progress), so a first download started from the library without selecting a model still counts.
  It also reports a Git author step (`recommended` until `preferences().author` is set) and whether
  any local conversation has a message. `LocalSetupGuide` renders model → workspace → author →
  first chat in the new chat until that first message exists or the user hides it. The runtime
  host records the first message once as `localSetupCompleted` (`useRecordLocalSetupCompletion`),
  so deleting every chat later does not bring the guide back; hiding it sets
  `localSetupDismissed`. Both are device-wide app settings. `useLocalSetup` keeps one result
  object until a visible field changes, so download progress ticks and token streams do not
  re-render the drawer, profile sheet, or Settings; it stops watching threads once the first chat
  has started or setup is completed or dismissed, and scans threads at most once per `threads`
  revision before that. Only model and workspace feed readiness, so a missing
  author never blocks a chat. The workspace step opens the chat's workspace picker
  (`openWorkspaceModalAtom`); the model and author steps open Settings → Models and Settings →
  Git & GitHub through `LOCAL_SETUP_DESTINATIONS` (`shell/profiles/localSetup.ts`). Missing
  prerequisites still reject chat creation with `on_device_model_required`/
  `on_device_workspace_required`.
- **Profile routes**: `app/profiles/_layout.tsx` gives `[profileId]` its own stack. Expo Router only
  notices a changed dynamic segment on a route named exactly `[param]`, so without it a profile
  switch left the previous profile id on the parent route and returning from any root-level screen
  switched back.

## Delegation and parallel work

With a 16,384-token context, the model can call `task` with one to three independent prompts. Built-in `explore` children are
runtime-enforced read-only (workspace reads, Git inspection, and approved web access); `general`
children can use the normal tools for explicitly requested work. Children cannot delegate or read
other children. No custom agent configuration, shell, executable, or additional model is involved.

Each child gets a fresh conversation in the same workspace with the parent's selected model.
**Inference is FIFO-serialized on the one resident model context, not parallel GPU inference.**
While a child waits for a read or network tool, another child can generate or run its tools.
Independent workspace-read calls also fan out, at most three at once; mutations are serialized
across children. File-version observations belong to each child's own run. Competing edits
still use native compare-and-swap, so one child's observation cannot authorize a sibling's edit.
Network and push approvals retain the global policy; waiting children have individually addressable
approval requests. Questions and approvals share one stable visible interaction at a time;
answering it reveals the next pending request instead of stacking native sheets.

Limits are six child admissions per parent turn, eight rounds/tools and at most 512 generated
tokens per child round, 8,192 characters per child tool result, and 2,048 characters per returned
summary. A conversation retains at most 24 children; resumptions stop admitting work once a child's
history reaches 128 messages. `task` returns explicit child status, errors, and a resumable
`child_id`. Supply that ID with the same agent and a new prompt to continue without replaying old
tools. Resuming requires the original workspace and model, while `read_child` can inspect historical
evidence after a model switch in the same workspace.

The transport presents each child as a read-only ACP sub-agent thread (`transport/children.ts`),
so the shell's sub-agent card and transcript work unchanged. The thread ID is
`v1.<base64url("on-device")>.<base64url(child_id)>`, the same ID the client derives from a
snapshot's `<task id state>` header. `thread/list` (unless `sourceKinds` omits
`subAgentThreadSpawn`) and `bridge/thread/list/stream/start` with `includeSubAgents` list each
child right after its parent with `source.subAgent.thread_spawn.parentThreadId`, and `thread/read`
returns its transcript. Live, the projector emits `thread/started` plus `thread/subagent/adopted`
when a child is admitted, then streams the child's own run, text, and tool events under its thread
ID while the parent's activity card (`subagent:child:<parent>:<child>`, `receiverThreadIds` =
the child thread) reports its status and latest tool or answer. Tapping the card opens the live
transcript. Child approvals and questions still surface in the parent chat, and every mutating
method rejects a child ID with `on_device_subagent_read_only`; continue a child by asking the parent
to resume it.

Stop, and backgrounding that stops the turn, cancel every child and queued generation. The parent
stays busy, including its Stop/composer controls, until all admitted children and in-flight native
tools settle.
Identity, history, status, and tool intent are journaled inside the parent's app-owned runtime
document. Each child has its own persistent tasks and summary checkpoint, never the parent's
private conversation memory. Large child results use the parent's private artifact namespace;
`read_tool_output` and `search_tool_output` accept the child's `child_id` with its artifact ID; a
child reads its own outputs with or without its own `child_id`, never a sibling's. Quota checks use
the stored byte size encoded in each artifact's document name, never re-reading saved evidence.
Restart marks active children interrupted without replaying tools; deleting the parent also deletes
its embedded children and their saved outputs and cannot resurrect them.

## Ownership and testing

`src/features/on-device` owns local models, authentication, workspaces, tool dispatch, journals,
the runtime owner (`OnDeviceProvider`), and the in-process transport (`transport/`, which may use
bridge wire types but not bridge transports). It has no screens, routes, or UI kit: ESLint rejects
React Native view components, `expo-router`, the theme, shared UI, the shell, chat, and Settings in
its non-test files (`scripts/__tests__/mobile-runtime-boundaries.test.mjs`). Every local surface is
a shared one — the chat shell, Git, workspace, and Files screens over the transport, and
`features/settings/local` for models and Git & GitHub. The Expo module under
`modules/on-device-agent` owns native memory, Keychain, workspace containment, atomic
document/model storage, and Git. Native ABI version mismatches fail locally with a rebuild message.
`src/shell/runtime` composes the runtime host, its recovery page, and the `LocalBridgeWsClient`
adapter; `src/app/on-device` only redirects links from older builds.

Transport behaviour is covered by `transport/server.test.ts` (wire shapes, events, stop, unsupported
methods), `shell/runtime/LocalBridgeWsClient.test.ts` (the real API client over the transport), and
`features/chat/screen/MainScreen.local.test.tsx` (send, stream, and stop in the real chat screen).
Startup recovery is covered by `shell/runtime/LocalRuntimeRecovery.test.tsx` and retired links by
`shell/navigation/localProfileRouting.test.tsx`.
Workspaces, Git, and Files are covered over the real transport by
`transport/workspaceHandlers.test.ts`, `features/git/GitScreen.local.test.tsx`,
`features/workspace/picker/ManagedView.test.tsx`, `features/workspace/checkout/Screen.local.test.tsx`,
and `features/workspace/files/Screen.test.tsx`.

See the [native module guide](../apps/mobile/modules/on-device-agent/README.md) for build and native
scenario commands. Run mobile lint/typecheck/tests, `typecheck:native`, architectural boundary tests,
and the production-bridge layout suite for integration changes. Real GitHub authorization requires
a configured client ID; physical-device validation remains a separate release gate.
