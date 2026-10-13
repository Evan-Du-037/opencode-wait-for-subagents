import { Plugin } from "@opencode/plugin"
import { Receipts, parseReceipt, type Receipt, type Target } from "./receipts.ts"

export default Plugin.define({
  id: "evan.wait-for-subagents",
  async setup(ctx) {
    const receipts = new Receipts()
    const controller = new AbortController()
    const writes = new Set<Promise<void>>()
    type Dispatch = { key: string; since: number; background: boolean; excludedID?: string }
    const baselines = new Map<string, { since: number; excludedID?: string }>()
    const dispatches = new Map<string, Dispatch>()
    const writeTails = new Map<string, Promise<void>>()
    const receiptKey = (parent: string, child: string) => `receipt/${parent}/${child}`
    const dispatchKey = (parent: string, child: string) => `dispatch/${parent}/${child}`
    const save = (key: string, value: Receipt | Dispatch) => {
      const data = JSON.parse(JSON.stringify(value))
      const pending = (writeTails.get(key) ?? Promise.resolve()).then(() => ctx.storage.set(key, data)).catch(error => {
        receipts.fail(new Error(`Could not persist subagent wait state: ${String(error)}`))
      }).finally(() => { writes.delete(pending); if (writeTails.get(key) === pending) writeTails.delete(key) })
      writeTails.set(key, pending)
      writes.add(pending)
    }
    const remember = (receipt: Receipt) => { receipts.put(receipt); save(receiptKey(receipt.parentID, receipt.childID), receipt) }
    const loadReceipt = async (parent: string, child: string) => {
      const value = await ctx.storage.get(receiptKey(parent, child)) as Receipt | undefined
      if (value) receipts.hydrate(value)
    }
    const readHistory = async (parent: string, signal?: AbortSignal) => {
      const history = await ctx.session.context({ sessionID: parent }, { signal })
      for (const message of history) {
        if (message.type !== "synthetic") continue
        const receipt = parseReceipt(parent, message.id, message.time.created, message)
        if (receipt) receipts.hydrate(receipt)
      }
      return history
    }

    // Subscribe before registering tools: capture completion even before the model calls wait.
    const loop = (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (event.type !== "session.inbox.enqueued" || event.data.item.type !== "synthetic") continue
          const receipt = parseReceipt(event.data.sessionID, event.data.inboxID, event.created, event.data.item.payload)
          if (receipt) remember(receipt)
        }
        if (!controller.signal.aborted) receipts.fail(new Error("Native event subscription ended; waiting cannot be confirmed. Do not redo subagent work."))
      } catch (error) {
        if (!controller.signal.aborted) receipts.fail(new Error(`Native event subscription failed: ${String(error)}. Do not redo subagent work.`))
      }
    })()

    // Exclude a previous run's receipt when reusing a child, including same-millisecond runs.
    const before = await ctx.tool.hook("execute.before", async event => {
      if (event.tool !== "subagent" || !event.input || typeof event.input !== "object") return
      const input = event.input as { sessionID?: string }
      try {
        if (input.sessionID) {
          await loadReceipt(event.sessionID, input.sessionID)
          await readHistory(event.sessionID)
        }
        baselines.set(`${event.sessionID}/${event.messageID}/${event.id}`, { since: Date.now(), excludedID: input.sessionID ? receipts.get(event.sessionID, input.sessionID)?.id : undefined })
      } catch (error) {
        // Observing a launch must never prevent the native subagent from running.
        receipts.fail(new Error(`Could not track native subagent launch: ${String(error)}. Background work must not be duplicated.`))
      }
    })
    const after = await ctx.tool.hook("execute.after", event => {
      if (event.tool !== "subagent") return
      const key = `${event.sessionID}/${event.messageID}/${event.id}`
      const baseline = baselines.get(key)
      baselines.delete(key)
      if (event.status !== "completed") return
      const child = event.result.metadata?.sessionID
      if (typeof child !== "string") return
      const dispatch = { key, since: baseline?.since ?? Date.now(), excludedID: baseline?.excludedID, background: event.result.metadata?.status === "running" }
      dispatches.set(dispatchKey(event.sessionID, child), dispatch)
      save(dispatchKey(event.sessionID, child), dispatch)
    })
    const registration = await ctx.tool.transform(editor => {
      editor.add({
        name: "wait_for_subagents",
        options: { codemode: false },
        description: "Wait for native background subagent results. Call this when your independent work is done and you need results from one or more previously launched subagents to continue. Supply their sessionIDs. If the wait times out with results still pending, call again, increasing the timeout when possible.",
        input: {
          type: "object", properties: {
            sessionIDs: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1, maxItems: 32, description: "Child session IDs returned by native subagent calls." },
            timeoutSeconds: { type: "integer", minimum: 1, maximum: 600, default: 300, description: "Maximum wait time. Timeout leaves unfinished subagents running." },
          }, required: ["sessionIDs"], additionalProperties: false,
        },
        async execute(raw, context) {
          const input = raw as { sessionIDs: string[]; timeoutSeconds?: number }
          const ids = [...new Set(input.sessionIDs)]
          const signal = AbortSignal.any([controller.signal, context.signal])
          const parent = context.sessionID
          if (ids.includes(parent)) throw new Error("Cannot wait for the current session itself.")
          await Promise.all(ids.map(async child => {
            const session = await ctx.session.get({ sessionID: child }, { signal })
            if (session.parentID !== parent) throw new Error(`Not a child of the current session: ${child}`)
            await loadReceipt(parent, child)
          }))
          const history = await readHistory(parent, signal)
          const targets: Target[] = []
          for (const child of ids) {
            let launch: { key: string; since: number } | undefined
            for (const message of history) {
              if (message.type !== "assistant") continue
              for (const part of message.content) {
                if (part.type !== "tool" || part.name !== "subagent" || part.state.status !== "completed" || part.state.metadata?.sessionID !== child) continue
                if (part.state.metadata.status !== "running") { launch = undefined; continue }
                launch = { key: `${parent}/${message.id}/${part.id}`, since: part.time.ran ?? message.time.created }
              }
            }
            const key = dispatchKey(parent, child)
            const dispatch = dispatches.get(key) ?? await ctx.storage.get(key) as Dispatch | undefined
            // Persisted launches survive context compaction and plugin reloads.
            if (dispatch && (!launch || dispatch.since >= launch.since)) launch = dispatch.background ? { key: dispatch.key, since: dispatch.since } : undefined
            if (!launch) throw new Error(`No completed background launch found for ${child}. Wait only after native subagent has returned its background sessionID.`)
            targets.push({ sessionID: child, since: launch.since, excludedID: dispatch?.key === launch.key ? dispatch.excludedID : undefined })
          }
          await context.progress({ status: "waiting", sessionIDs: ids })
          const result = await receipts.wait(parent, targets, signal, (input.timeoutSeconds ?? 300) * 1000)
          return {
            content: JSON.stringify({ ...result, note: result.status === "ready"
              ? "Native subagent completion notifications are queued or already in context. Use those native messages for the results. The listed states distinguish success, failure, and cancellation."
              : "Still waiting for native completion notifications. This is not evidence of subagent failure. Call wait_for_subagents again if needed; do not redo or reassign their work." }),
            metadata: { status: result.status, sessionIDs: ids },
          }
        },
      })
    })
    return async () => {
      controller.abort(new Error("Wait plugin unloaded; background subagents are unaffected."))
      await Promise.all([registration.dispose(), before.dispose(), after.dispose()])
      await loop
      await Promise.allSettled(writes)
    }
  },
})
