import { expect, test } from "bun:test"
import { Receipts, parseReceipt, type Receipt } from "../src/receipts.ts"
const receipt = (childID = "a", overrides: Partial<Receipt> = {}): Receipt => ({ id: "notice-1", parentID: "parent", childID, created: 100, state: "completed", ...overrides })
const targets = [{ sessionID: "a", since: 99 }, { sessionID: "b", since: 99 }]

test("waits for all selected native receipts, including receipts that arrived early", async () => {
  const store = new Receipts(); store.put(receipt())
  let done = false
  const waiting = store.wait("parent", targets, new AbortController().signal, 1000).then(result => { done = true; return result })
  await Promise.resolve(); expect(done).toBe(false)
  store.put(receipt("unrelated")); await Promise.resolve(); expect(done).toBe(false)
  store.put(receipt("b"))
  expect(await waiting).toEqual({ status: "ready", results: [{ sessionID: "a", state: "completed" }, { sessionID: "b", state: "completed" }], pending: [] })
})
test("failure and cancellation are terminal receipt states, not wait failures", async () => {
  const store = new Receipts(); store.put(receipt("a", {state:"error"})); store.put(receipt("b", {state:"cancelled"}))
  expect((await store.wait("parent", targets, new AbortController().signal, 100)).results.map(x=>x.state)).toEqual(["error", "cancelled"])
})
test("timeout does not label missing subagents as failed", async () => {
  const store = new Receipts(); store.put(receipt())
  expect(await store.wait("parent", targets, new AbortController().signal, 5)).toEqual({status:"pending",results:[{sessionID:"a",state:"completed"}],pending:["b"]})
})
test("previous generation receipt cannot complete a reused child, even at the same timestamp", async () => {
  const store = new Receipts(); store.put(receipt())
  const selected = [{sessionID:"a",since:100,excludedID:"notice-1"}]
  expect((await store.wait("parent", selected, new AbortController().signal, 5)).status).toBe("pending")
  store.put(receipt("a",{id:"notice-2"}))
  expect((await store.wait("parent", selected, new AbortController().signal, 5)).status).toBe("ready")
})
test("wrong parent, stale receipts, and duplicate events cannot replace the latest receipt", async () => {
  const store = new Receipts(); store.put(receipt("a",{parentID:"other"}))
  expect(store.snapshot("parent",targets).pending).toEqual(["a","b"])
  store.put(receipt("a",{id:"new",created:200,state:"error"})); store.put(receipt("a",{created:100})); store.put(receipt("a",{id:"new",created:200}))
  expect(store.get("parent","a")?.state).toBe("error")
})
test("aborting one waiter does not affect another waiter or future receipt delivery", async () => {
  const store = new Receipts(), controller = new AbortController()
  const first = store.wait("parent", targets, controller.signal, 1000)
  const rejection = first.catch(error => error.message)
  const second = store.wait("parent", targets, new AbortController().signal, 1000)
  controller.abort(new Error("user cancelled")); expect(await rejection).toBe("user cancelled")
  store.put(receipt()); store.put(receipt("b"))
  expect((await second).status).toBe("ready")
})
test("already aborted signals and event stream failure fail promptly", async () => {
  const store = new Receipts(), controller = new AbortController(); controller.abort(new Error("stopped"))
  await expect(store.wait("parent",targets,controller.signal,1000)).rejects.toThrow("stopped")
  const waiting = store.wait("parent", targets, new AbortController().signal, 1000)
  const rejection = waiting.catch(error => error.message)
  store.fail(new Error("stream failed")); expect(await rejection).toBe("stream failed")
})
test("only native terminal subagent metadata is accepted", () => {
  expect(parseReceipt("parent","id",1,{metadata:{source:"subagent",childID:"a",state:"running"}})).toBeUndefined()
  expect(parseReceipt("parent","id",1,{metadata:{source:"shell",childID:"a",state:"completed"}})).toBeUndefined()
  expect(parseReceipt("parent","id",1,{metadata:{source:"subagent",childID:"a",state:"error"}})?.state).toBe("error")
})
test("a stale history read cannot replace a fresh event in the same millisecond", () => {
  const store = new Receipts()
  store.put(receipt("a", {id:"new"}))
  store.hydrate(receipt("a", {id:"old"}))
  expect(store.get("parent","a")?.id).toBe("new")
})
