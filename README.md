# OpenCode Wait for Subagents

[简体中文](README.zh-CN.md)

Adds a `wait_for_subagents` tool to OpenCode V2. A parent agent can launch background subagents, do its own work, then explicitly wait for their results instead of repeating the delegated work.

The tool description tells the model when to use it. No custom system prompt is required.

Tested with OpenCode **2.0.26, 2.0.27, and 2.1.4**. **2.1.4** was the latest stable V2 release verified on **2026-10-24**; no plugin code changes were needed. See the [compatibility record](COMPATIBILITY.md) for test results and scope. V1 is not supported; unlisted versions are not individually verified. Run the integration tests again when upgrading OpenCode.

## Install

Requires Bun and OpenCode V2.

```sh
git clone https://github.com/Evan-Du-037/opencode-wait-for-subagents.git
cd opencode-wait-for-subagents
bun install --frozen-lockfile
```

Append the following object to the existing `plugins` array in `~/.config/opencode/opencode.json`, replacing the path with the absolute path to your clone:

```json
{
  "package": "file:///absolute/path/to/opencode-wait-for-subagents"
}
```

Saving the configuration reloads plugins automatically. The tool should be available on the next request; use `/reload` to force a reload if needed. The plugin's directory entrypoint is `server.ts`.

## Usage

```json
{
  "sessionIDs": ["ses_child_a", "ses_child_b"],
  "timeoutSeconds": 300
}
```

- `sessionIDs`: 1–32 session IDs returned by native background `subagent` calls. Duplicate IDs are removed. Only direct children of the current session are accepted.
- `timeoutSeconds`: optional, defaults to 300, range 1–600. A timeout returns `pending`; it does not cancel the children or mark them as failed.
- `ready`: all selected native completion notifications have been queued or are already in context. Each result reports `completed`, `error`, or `cancelled`.
- `pending`: some notifications have not arrived. The model should wait again instead of repeating or reassigning the work.

Stopping the parent cancels the current wait. Background subagents continue under OpenCode's native lifecycle.

The tool description shown to the model is:

> Wait for native background subagent results. Call this when your independent work is done and you need results from one or more previously launched subagents to continue. Supply their sessionIDs. If the wait times out with results still pending, call again, increasing the timeout when possible.

## How it works

The plugin listens for native `session.inbox.enqueued` events carrying subagent completion metadata. Once all selected notifications have arrived, the wait tool returns. OpenCode then reads the native messages and continues the parent.

While a tool is running, a native wake request is recorded without interrupting that tool or starting a second parent execution. The plugin does not call `session.interrupt`, `session.prompt`, or `session.synthetic`, and does not inject results or schedule another generation.

`session.wait` only waits for a session to become idle. It also resolves after failure or interruption and does not guarantee that a completion notification has been delivered, so it is not the completion condition used here. Waiting for the parent model to consume the notification would deadlock with the current tool call.

The plugin stores notification metadata and the latest observed delegation in plugin storage. It also recovers delivered notifications from context and excludes previous results when a child session is reused. It does not store copies of child response text. Tool hooks observe native calls without changing their inputs or execution.

## Limitations

- Call the wait tool after the native background launch has returned. Do not launch another task in the same child and wait for that child in the same parallel batch.
- Notifications queued before the plugin was enabled but not yet read by the parent, or missed during a subscription gap, may be unverifiable. The plugin returns `pending` or an explicit subscription error rather than guessing completion.
- Repeated prompts to the same child follow OpenCode's native session/job coalescing behavior. Notifications do not provide a separate completion ID for each prompt.
- Unloading or reloading the plugin cancels active waits. Saved records support later calls, but seamless recovery across version changes or service failures is not guaranteed.

## Tests

```sh
bun run check
bun run smoke
```

`check` runs TypeScript checking and nine unit tests. `smoke` runs an isolated OpenCode service with a local mock model and the real native `subagent` tool. Its twelve lifecycle checks cover multiple children, early notifications, timeout/retry, cancellation, child failure, reused sessions, native parent wakeup, and duplicate delivery.

The smoke test uses isolated XDG directories and no real model credentials or chats. It requires permission to listen on loopback ports. Set `OPENCODE_BINARY` to test a specific executable. Temporary fixture paths are printed so you can inspect `requests.json`, `server.log`, and `summary.json`.

These tests check runtime behavior; they are not a benchmark of model delegation quality.

## Native implementation references

The initial implementation was checked against OpenCode 2.0.26. The [2.1.4 compatibility review](COMPATIBILITY.md#native-contract-review) links to the newer source:

- [Subagent tool](https://github.com/anomalyco/opencode/blob/v2.0.26/packages/core/src/tool/plugin/subagent.ts)
- [Completion delivery](https://github.com/anomalyco/opencode/blob/v2.0.26/packages/core/src/session/subagent-completion.ts)
- [Session coordinator](https://github.com/anomalyco/opencode/blob/v2.0.26/packages/core/src/session/run-coordinator.ts)
- [session.wait](https://github.com/anomalyco/opencode/blob/v2.0.26/packages/core/src/session/session.ts)
