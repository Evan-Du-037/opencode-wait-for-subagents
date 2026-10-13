export type Receipt = {
  id: string
  parentID: string
  childID: string
  created: number
  state: "completed" | "error" | "cancelled"
}
export type Target = { sessionID: string; since: number; excludedID?: string }
export type WaitResult = { status: "ready" | "pending"; results: { sessionID: string; state: Receipt["state"] }[]; pending: string[] }

export function parseReceipt(parentID: string, id: string, created: number, payload: unknown): Receipt | undefined {
  if (!payload || typeof payload !== "object") return
  const metadata = (payload as { metadata?: Record<string, unknown> }).metadata
  if (metadata?.source !== "subagent" || typeof metadata.childID !== "string") return
  if (!["completed", "error", "cancelled"].includes(String(metadata.state))) return
  return { id, parentID, childID: metadata.childID, created, state: metadata.state as Receipt["state"] }
}

/** Native notification receipts only; no synthetic messages or session scheduling. */
export class Receipts {
  private entries = new Map<string, Receipt>()
  private listeners = new Set<() => void>()
  private failure?: Error

  get(parent: string, child: string) { return this.entries.get(`${parent}/${child}`) }
  // A history/storage read can have started before a fresh event arrived.
  hydrate(receipt: Receipt) {
    const current = this.get(receipt.parentID, receipt.childID)
    if (!current || receipt.created > current.created) this.put(receipt)
  }
  put(receipt: Receipt) {
    const current = this.get(receipt.parentID, receipt.childID)
    if (current && (current.created > receipt.created || current.id === receipt.id)) return
    this.entries.set(`${receipt.parentID}/${receipt.childID}`, receipt)
    for (const notify of [...this.listeners]) notify()
  }
  fail(error: Error) { this.failure = error; for (const notify of [...this.listeners]) notify() }
  snapshot(parent: string, targets: Target[]): WaitResult {
    const results: WaitResult["results"] = [], pending: string[] = []
    for (const target of targets) {
      const receipt = this.get(parent, target.sessionID)
      if (receipt && receipt.created >= target.since && receipt.id !== target.excludedID)
        results.push({ sessionID: target.sessionID, state: receipt.state })
      else pending.push(target.sessionID)
    }
    return { status: pending.length ? "pending" : "ready", results, pending }
  }
  wait(parent: string, targets: Target[], signal: AbortSignal, timeoutMs: number): Promise<WaitResult> {
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      let finished = false
      const cleanup = () => { finished = true; clearTimeout(timer); this.listeners.delete(check); signal.removeEventListener("abort", abort) }
      const abort = () => { cleanup(); reject(signal.reason ?? new Error("Wait cancelled")) }
      const check = () => {
        if (finished) return
        if (signal.aborted) return abort()
        if (this.failure) { cleanup(); reject(this.failure); return }
        const state = this.snapshot(parent, targets)
        if (state.status === "ready") { cleanup(); resolve(state) }
      }
      this.listeners.add(check)
      signal.addEventListener("abort", abort, { once: true })
      timer = setTimeout(() => { cleanup(); resolve(this.snapshot(parent, targets)) }, timeoutMs)
      check()
    })
  }
}
