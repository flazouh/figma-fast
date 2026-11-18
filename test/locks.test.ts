import { assert, describe, it } from "@effect/vitest"
import { Deferred, Duration, Effect, Fiber, Queue } from "effect"
import type { FileKey } from "../src/domain.ts"
import { buildClient, scriptedTransport, tempQueue, testSettings, waitSignals } from "./helpers.ts"

const A = "AAAAAAAAAAAA" as FileKey
const B = "BBBBBBBBBBBB" as FileKey

describe("per-file locks", () => {
  it.live("two writes to the same file run one after the other, across processes", () =>
    Effect.gen(function* () {
      const settings = testSettings({ queueDir: tempQueue() })
      const { transport, started, stats } = yield* scriptedTransport({ name: "desktop" })
      const { waits, onWait } = yield* waitSignals
      const one = yield* buildClient(settings, [transport])
      const two = yield* buildClient(settings, [transport], onWait)

      const first = yield* Effect.forkChild(one.client.call({ op: "write", key: A }))
      const held = yield* Queue.take(started)
      const second = yield* Effect.forkChild(two.client.call({ op: "write", key: A }))
      const wait = yield* Queue.take(waits)
      assert.strictEqual(wait.holder.pid, process.pid)
      assert.strictEqual(wait.holder.state, "holding")
      assert.strictEqual(stats.active, 1)

      yield* Deferred.succeed(held.gate, undefined)
      yield* Fiber.join(first)
      const next = yield* Queue.take(started)
      assert.strictEqual(next.request.op, "write")
      yield* Deferred.succeed(next.gate, undefined)
      yield* Fiber.join(second)
      assert.strictEqual(stats.max, 1)
    }))

  it.live("two writes to the same file in one process run one after the other", () =>
    Effect.gen(function* () {
      const settings = testSettings({ queueDir: tempQueue() })
      const { transport, started, stats } = yield* scriptedTransport({ name: "desktop" })
      const { client } = yield* buildClient(settings, [transport])
      const fibers = yield* Effect.forEach([1, 2, 3], () => Effect.forkChild(client.call({ op: "write", key: A })))
      for (let i = 0; i < 3; i++) {
        const held = yield* Queue.take(started)
        assert.strictEqual(stats.active, 1)
        yield* Deferred.succeed(held.gate, undefined)
      }
      yield* Fiber.joinAll(fibers)
      assert.strictEqual(stats.max, 1)
    }))

  it.live("reads of the same file run together, and a write waits for them", () =>
    Effect.gen(function* () {
      const settings = testSettings({ queueDir: tempQueue() })
      const { transport, started, stats } = yield* scriptedTransport({ name: "desktop" })
      const { waits, onWait } = yield* waitSignals
      const one = yield* buildClient(settings, [transport])
      const two = yield* buildClient(settings, [transport])
      const three = yield* buildClient(settings, [transport], onWait)

      const r1 = yield* Effect.forkChild(one.client.call({ op: "read", key: A }))
      const r2 = yield* Effect.forkChild(two.client.call({ op: "read", key: A }))
      const h1 = yield* Queue.take(started)
      const h2 = yield* Queue.take(started)
      assert.strictEqual(stats.active, 2)

      const w = yield* Effect.forkChild(three.client.call({ op: "write", key: A }))
      const wait = yield* Queue.take(waits)
      assert.strictEqual(wait.holder.access, "read")
      assert.strictEqual(stats.active, 2)

      yield* Deferred.succeed(h1.gate, undefined)
      yield* Deferred.succeed(h2.gate, undefined)
      yield* Fiber.joinAll([r1, r2])
      const hw = yield* Queue.take(started)
      assert.strictEqual(hw.request.op, "write")
      assert.strictEqual(stats.active, 1)
      yield* Deferred.succeed(hw.gate, undefined)
      yield* Fiber.join(w)
    }))

  it.live("a read waits for a write that holds the file", () =>
    Effect.gen(function* () {
      const settings = testSettings({ queueDir: tempQueue() })
      const { transport, started, stats } = yield* scriptedTransport({ name: "desktop" })
      const { waits, onWait } = yield* waitSignals
      const one = yield* buildClient(settings, [transport])
      const two = yield* buildClient(settings, [transport], onWait)
      const w = yield* Effect.forkChild(one.client.call({ op: "write", key: A }))
      const hw = yield* Queue.take(started)
      const r = yield* Effect.forkChild(two.client.call({ op: "pages", key: A }))
      const wait = yield* Queue.take(waits)
      assert.strictEqual(wait.holder.access, "write")
      assert.strictEqual(stats.active, 1)
      yield* Deferred.succeed(hw.gate, undefined)
      const hr = yield* Queue.take(started)
      yield* Deferred.succeed(hr.gate, undefined)
      yield* Fiber.joinAll([w, r])
    }))

  it.live("writes to different files run at the same time", () =>
    Effect.gen(function* () {
      const settings = testSettings({ queueDir: tempQueue() })
      const { transport, started, stats } = yield* scriptedTransport({ name: "desktop" })
      const one = yield* buildClient(settings, [transport])
      const two = yield* buildClient(settings, [transport])
      const a = yield* Effect.forkChild(one.client.call({ op: "write", key: A }))
      const b = yield* Effect.forkChild(two.client.call({ op: "write", key: B }))
      const ha = yield* Queue.take(started)
      const hb = yield* Queue.take(started)
      assert.strictEqual(stats.active, 2)
      assert.deepStrictEqual(new Set([ha.request.key, hb.request.key]), new Set([A, B]))
      yield* Deferred.succeed(ha.gate, undefined)
      yield* Deferred.succeed(hb.gate, undefined)
      yield* Fiber.joinAll([a, b])
      assert.strictEqual(stats.max, 2)
    }).pipe(Effect.timeout(Duration.seconds(5))))

  it.live("a run that waits past LOCK_WAIT fails and names the holder", () =>
    Effect.gen(function* () {
      const queueDir = tempQueue()
      const { transport, started } = yield* scriptedTransport({ name: "desktop" })
      const one = yield* buildClient(testSettings({ queueDir }), [transport])
      const two = yield* buildClient(testSettings({ queueDir, lockWait: Duration.millis(150) }), [transport])
      const w = yield* Effect.forkChild(one.client.call({ op: "tokens", key: A }))
      const held = yield* Queue.take(started)
      const error = yield* Effect.flip(two.client.call({ op: "write", key: A }))
      assert.strictEqual(error._tag, "LockTimeout")
      assert.match(error.message, new RegExp(`pid ${process.pid}, write "tokens"`))
      assert.match(error.message, /AAAAAAAAAAAA/)
      yield* Deferred.succeed(held.gate, undefined)
      yield* Fiber.join(w)
    }))
})
