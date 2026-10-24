# OpenCode compatibility

## 2026-10-24 — OpenCode 2.1.4

**Result:** the existing plugin passes the checks below on OpenCode **2.1.4** without source changes. The repository's dependency pins and lockfile remain unchanged.

**中文摘要：** 原插件在 OpenCode 2.1.4 上通过类型检查、9 个单元测试和 12 项集成检查；临时副本改用 2.1.4 的 plugin/client 依赖后，也通过同样的检查。无需修改运行时代码或提升最低版本要求；未逐一验证中间版本，原有边界限制仍适用。

### Version discovery

- The official [V2 installation guide](https://opencode.ai/v2/docs/) identifies `@opencode/cli` as the V2 CLI package. Its [npm `latest` tag](https://registry.npmjs.org/-/package/@opencode%2fcli/dist-tags) resolved to **2.1.4** on the date above.
- `@opencode/plugin` and `@opencode/client` also resolved to **2.1.4** on their `latest` tags.
- The official source tag [`v2.1.4`](https://github.com/anomalyco/opencode/tree/v2.1.4) resolved to commit `68bc26b7da1990ce10ffecfbc1e09eb13aa5d824`.
- Do not use `opencode-ai/latest` or GitHub's default latest-release endpoint to identify the V2 release: both pointed to **V1 1.19.4** during this check.

### Verification matrix

Environment: macOS ARM64, Bun **1.3.11**, TypeScript **5.9.3**; the installed executable reported `opencode v2.1.4`.

| Plugin/client dependencies | TypeScript check | Unit tests | Native smoke checks |
| --- | --- | --- | --- |
| **2.0.26**, repository's existing pinned dependencies | Pass | 9 passed, 0 failed | 12 passed |
| **2.1.4**, isolated temporary copy only | Pass | 9 passed, 0 failed | 12 passed |

Both smoke runs used an independent OpenCode 2.1.4 service, isolated XDG directories, a local mock model, and the real native `subagent` tool. No real model requests or existing chat sessions were used. Both produced this summary:

```json
{
  "parentCalls": 3,
  "idleParentCalls": 3,
  "passes": 12,
  "version": "opencode v2.1.4"
}
```

The checks cover multiple children, no premature parent continuation, exactly one continuation with both results, no duplicated native notifications, idle/failed/interrupted `session.wait`, native idle-parent wakeup, early notifications, timeout/retry, cancellation of the parent wait without cancelling the child, child failure, and reused child sessions.

### Native contract review

Compared the relevant official source at `v2.0.26` and `v2.1.4`:

- [`Plugin.define`](https://github.com/anomalyco/opencode/blob/v2.1.4/packages/plugin/src/promise/plugin.ts) and [tool transforms/hooks](https://github.com/anomalyco/opencode/blob/v2.1.4/packages/plugin/src/promise/tool.ts) retain the interfaces used by this plugin.
- The [native subagent tool](https://github.com/anomalyco/opencode/blob/v2.1.4/packages/core/src/tool/plugin/subagent.ts) still returns `metadata.sessionID` and `metadata.status: "running"` for background launches.
- [Completion delivery](https://github.com/anomalyco/opencode/blob/v2.1.4/packages/core/src/session/subagent-completion.ts) is unchanged: synthetic notifications carry `source: "subagent"`, `childID`, and terminal `state`. The [`session.inbox.enqueued` event](https://github.com/anomalyco/opencode/blob/v2.1.4/packages/schema/src/session-event.ts) retains the fields the plugin reads.
- [Session/plugin storage access](https://github.com/anomalyco/opencode/blob/v2.1.4/packages/core/src/plugin/host.ts) and the relevant historical tool-message fields remain compatible.
- The [session coordinator](https://github.com/anomalyco/opencode/blob/v2.1.4/packages/core/src/session/run-coordinator.ts) still records a pending wake while the parent is executing, rather than interrupting the active tool or starting a second parent execution.
- [Subagent jobs](https://github.com/anomalyco/opencode/blob/v2.1.4/packages/core/src/session/subagent-job.ts) now use a global service so jobs and completion observers can outlive the launching plugin/location. This does not change the notification contract; it does not guarantee that this plugin can recover every missed event.
- No built-in `wait_for_subagents` tool was found in the 2.1.4 [internal plugin registry](https://github.com/anomalyco/opencode/blob/v2.1.4/packages/core/src/plugin/internal.ts) or native tool implementations. [`session.wait`](https://github.com/anomalyco/opencode/blob/v2.1.4/packages/core/src/session/session.ts) still waits for idle, not completion-notification delivery.

### Reproduce

```sh
bun install --frozen-lockfile
bun run check
OPENCODE_BINARY=/absolute/path/to/opencode bun run smoke
```

Confirm the selected executable's `--version` first. The smoke script prints a `FIXTURE` directory containing `requests.json`, `server.log`, and `summary.json`; check the recorded version and successful exit, not just the requested binary path.

For the second matrix row, an isolated copy of `server.ts`, `src/`, `test/`, `scripts/`, `package.json`, and `tsconfig.json` was used. Only its `@opencode/plugin` and `@opencode/client` pins were changed to `2.1.4`; `bun install --ignore-scripts`, `bun run check`, and the same smoke command all succeeded. This did not update the working repository's dependencies.

### Scope and remaining limits

- **2.0.26 and 2.0.27** remain previously recorded tested versions; they were not rerun in this verification. Intermediate releases were not individually tested.
- The declared engine range `>=2.0.26 <3` is not a claim that every V2 release has been tested. Future releases need another smoke run and contract review.
- This run validates macOS ARM64 with a scripted local model, not other operating systems, real-model delegation quality, or load/stress behavior.
- Plugin reload/service restart recovery, subscription gaps, and context-compaction recovery were not exercised end to end. The [documented limitations](README.md#limitations) remain in force.
