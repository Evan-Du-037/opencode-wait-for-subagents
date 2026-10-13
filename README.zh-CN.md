# OpenCode Wait for Subagents

[English](README.md)

为 OpenCode V2 添加 `wait_for_subagents` 工具。在主 agent 的独立工作完成、后续依赖后台子任务时，阻塞当前工具调用，等待指定任务的**原生完成通知入队**。

已针对 OpenCode **2.0.26 和 2.0.27** 验证。V1 不支持；其他 V2 版本升级后应重新运行集成测试。

## 安装与启用

```sh
git clone https://github.com/Evan-Du-037/opencode-wait-for-subagents.git
cd opencode-wait-for-subagents
bun install --frozen-lockfile
bun run check
bun run smoke
```

在 `~/.config/opencode/opencode.json` 的现有 `plugins` 数组中追加此项，将路径替换为本地仓库的绝对路径，保留其他插件：

```json
{
  "package": "file:///absolute/path/to/opencode-wait-for-subagents"
}
```

重启 OpenCode 后，在新请求的工具目录中应出现 `wait_for_subagents`。目录入口是 `server.ts`。工具描述已说明应在何时等待，不需要修改 agent prompt。

## 使用

```json
{
  "sessionIDs": ["ses_child_a", "ses_child_b"],
  "timeoutSeconds": 300
}
```

- `sessionIDs`：1–32 个原生 `subagent` 已返回的后台子会话 ID；重复 ID 自动去重。只允许等待当前会话的直接子会话。
- `timeoutSeconds`：可选，默认 300，范围 1–600。到时只返回仍在等待的 ID，不终止子任务，不把超时当作失败。
- `ready`：所有指定任务的原生通知已入队或已在上下文中；每项状态为 `completed`、`error` 或 `cancelled`。
- `pending`：仍有通知未到达。模型应继续调用等待工具，不应重复执行或重新分配后台任务。
- 用户停止主会话时，取消本次等待；后台子任务仍按原生机制继续运行和投递。

可选的简短 system prompt 规则：

> When your independent work is done and further progress depends on background subagents, call `wait_for_subagents` with their sessionIDs. A pending result is not failure; do not duplicate their work.

## 与原生机制的关系

原生后台子任务结束 → 原生 `session.inbox.enqueued` 合成消息事件 → 等待工具确认所有目标通知到达 → 工具返回 → OpenCode 在下一步读取原生消息并继续模型调用。

主会话正在执行工具时，原生 wake 只记录继续执行的请求，不打断当前工具或另开一条主会话执行流程。本插件不调用 `session.interrupt`、`session.prompt` 或 `session.synthetic`，不重新投递结果，也不接管原生唤醒。

`session.wait` 只表示会话空闲，失败或中断也会返回，而且不能保证后台通知已投递，因此插件不将其用作完成条件。也不会等待主模型读取消息，否则会与当前工具相互等待。

通知和最近一次委派记录使用插件 storage 保存；启动后也从上下文恢复已投递的通知。复用子会话时排除前一轮通知。只保存通知元数据，不复制子任务正文。工具 hooks 只观察原生调用，不修改参数或执行器。

## 边界

- 应在原生后台调用返回后，再调用等待工具；不要把同一子会话的重新委派和等待放进同一批并行调用。
- 插件启用前已经完成但仍未被父会话读取的通知，以及事件订阅中断窗口中的通知，可能无法确认。此时不会猜测成功：返回 `pending` 或明确的订阅错误。后台任务本身不受影响。
- 同一子会话被多次追加任务时，沿用 OpenCode 的原生会话/job 合并语义；通知未提供独立的每次 prompt 完成 ID。
- 插件卸载或重载会取消正在等待的工具。保存的记录可供后续调用恢复，但不承诺跨版本或服务异常的无缝续等。

## 验证

`bun run check`：TypeScript 类型检查和等待状态单元测试。

`bun run smoke`：启动独立临时 OpenCode 服务和本地模拟模型，调用真正的 `subagent` 和本插件。隔离 XDG 配置、数据和缓存，不使用真实模型凭证或聊天。测试包括多任务、提前到达、超时重试、取消等待、子任务失败、复用会话、原生空闲唤醒与结果去重。实验目录路径会打印，便于查看 `requests.json` 和 `server.log`。

测试需要 Bun、已安装的 OpenCode V2，以及监听本机回环端口的权限。可设置 `OPENCODE_BINARY` 指定待测试的 OpenCode 可执行文件。

## 依据

- [原生 subagent 工具](https://github.com/anomalyco/opencode/blob/v2.0.26/packages/core/src/tool/plugin/subagent.ts)
- [原生通知投递](https://github.com/anomalyco/opencode/blob/v2.0.26/packages/core/src/session/subagent-completion.ts)
- [会话调度器](https://github.com/anomalyco/opencode/blob/v2.0.26/packages/core/src/session/run-coordinator.ts)
- [session.wait](https://github.com/anomalyco/opencode/blob/v2.0.26/packages/core/src/session/session.ts)
