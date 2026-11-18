// FIGMACLI_MAX_TABS caps the runs that drive a tab, across processes; each file gets its own Space.
import { assert, describe, it } from "@effect/vitest"
import { Deferred, Duration, Effect, Fiber, Queue } from "effect"
import type { FileKey } from "../src/domain.ts"
import { buildClient, scriptedTransport, tempQueue, testSettings } from "./helpers.ts"

const key = (n: number) => `FILE0000000${n}` as FileKey
const keys = [1, 2, 3, 4, 5].map(key)

describe("tab slots and Spaces", () => {
  it.live("no more than FIGMACLI_MAX_TABS runs drive a tab at once, across two processes", () =>
    Effect.gen(function* () {
      const settings = testSettings({ queueDir: tempQueue(), maxTabs: 2 })
      const { transport, started, stats } = yield* scriptedTransport({ name: "ego", opensTabs: true })
      const one = yield* buildClient(settings, [transport])
      const two = yield* buildClient(settings, [transport])
      const fibers = yield* Effect.forEach(keys, (key, i) => Effect.forkChild((i % 2 === 0 ? one : two).client.call({ op: "write", key })))
      // Let the runs through one by one: each time one finishes, at most one more may start.
      for (let i = 0; i < keys.length; i++) {
        const held = yield* Queue.take(started)
        assert.isAtMost(stats.active, 2)
        yield* Deferred.succeed(held.gate, undefined)
      }
      yield* Fiber.joinAll(fibers)
      assert.strictEqual(stats.max, 2)
    }).pipe(Effect.timeout(Duration.seconds(10))))

  it.live("a transport that opens no tab takes no slot", () =>
    Effect.gen(function* () {
      const settings = testSettings({ queueDir: tempQueue(), maxTabs: 1 })
      const { transport, started, stats } = yield* scriptedTransport({ name: "desktop", opensTabs: false })
      const { client } = yield* buildClient(settings, [transport])
      const fibers = yield* Effect.forEach(keys.slice(0, 3), (key) => Effect.forkChild(client.call({ op: "write", key })))
      const held = [yield* Queue.take(started), yield* Queue.take(started), yield* Queue.take(started)]
      assert.strictEqual(stats.active, 3)
      yield* Effect.forEach(held, (h) => Deferred.succeed(h.gate, undefined))
      yield* Fiber.joinAll(fibers)
    }))

  it.live("each file runs in its own Space, and a keyless run in the base Space", () =>
    Effect.gen(function* () {
      const settings = testSettings({ queueDir: tempQueue() })
      const { transport, stats } = yield* scriptedTransport({ name: "ego", opensTabs: true, gated: false })
      const { client } = yield* buildClient(settings, [transport])
      yield* client.call({ op: "pages", key: key(1) })
      yield* client.call({ op: "pages", key: key(1) })
      yield* client.call({ op: "doctor" })
      assert.deepStrictEqual(stats.runs.map((r) => [r.space, r.exclusive]), [
        // The first run on a cold Space opens its tab alone, so it locks as a write.
        ["figmacli-FILE00000001", true],
        ["figmacli-FILE00000001", false],
        ["figmacli", false],
      ])
    }))
})
