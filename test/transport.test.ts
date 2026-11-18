// The transport order: desktop first when its holder answers, ego after it, and a fallback only when nothing ran.
import { assert, describe, it } from "@effect/vitest"
import { Context, Duration, Effect, Layer } from "effect"
import { chmodSync, mkdirSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { join } from "node:path"
import { FigmaConfig } from "../src/config.ts"
import { type FileKey, NoDesktopTab, RunFailed, TransportUnavailable } from "../src/domain.ts"
import { desktopHealthy, makeEgo, readOnly, Transports, TransportsLive } from "../src/transport.ts"
import { buildClient, scriptedTransport, tempQueue, testSettings } from "./helpers.ts"

const KEY = "FALLBACK0001" as FileKey

const transportsFor = (settings: ReturnType<typeof testSettings>) =>
  Layer.build(TransportsLive.pipe(Layer.provide(Layer.succeed(FigmaConfig, settings)))).pipe(
    Effect.map((context) => Context.get(context, Transports).map((t) => t.name)),
  )

/** A socket that answers each CDP call with its id, as a healthy holder does. */
const fakeHolder = (path: string) =>
  Effect.acquireRelease(
    Effect.callback<ReturnType<typeof createServer>>((resume) => {
      const server = createServer((conn) => {
        conn.setEncoding("utf8").on("data", (chunk: string) => {
          for (const line of chunk.split("\n").filter(Boolean)) {
            conn.write(`${JSON.stringify({ id: (JSON.parse(line) as { id: number }).id, result: {} })}\n`)
          }
        })
      })
      server.listen(path, () => resume(Effect.succeed(server)))
    }),
    (server) => Effect.sync(() => server.close()),
  )

describe("transport order and fallback", () => {
  it.live("auto picks ego alone when no holder answers", () =>
    Effect.gen(function* () {
      const names = yield* transportsFor(testSettings({ queueDir: tempQueue() }))
      assert.deepStrictEqual(names, ["ego"])
    }))

  it.live("auto puts desktop first when the holder answers a CDP call", () =>
    Effect.gen(function* () {
      const queueDir = tempQueue()
      const socket = join(queueDir, "cdp.sock")
      yield* fakeHolder(socket)
      assert.isTrue(yield* desktopHealthy(socket))
      assert.deepStrictEqual(yield* transportsFor(testSettings({ queueDir, desktopSocket: socket })), ["desktop", "ego"])
    }))

  it.live("FIGMACLI_TRANSPORT forces one transport", () =>
    Effect.gen(function* () {
      const queueDir = tempQueue()
      assert.deepStrictEqual(yield* transportsFor(testSettings({ queueDir, transport: "desktop" })), ["desktop"])
      assert.deepStrictEqual(yield* transportsFor(testSettings({ queueDir, transport: "ego" })), ["ego"])
    }))

  it.live("a desktop holder that went away falls back to ego, a write included", () =>
    Effect.gen(function* () {
      const settings = testSettings({ queueDir: tempQueue(), maxTabs: 1 })
      const desktop = yield* scriptedTransport({ name: "desktop", fail: () => new TransportUnavailable({ transport: "desktop", reason: "gone" }) })
      const ego = yield* scriptedTransport({ name: "ego", opensTabs: true, gated: false })
      const { client } = yield* buildClient(settings, [desktop.transport, ego.transport])
      const answer = (yield* client.call({ op: "write", key: KEY })) as { via: string; space: string }
      assert.strictEqual(answer.via, "ego")
      assert.strictEqual(answer.space, "figmacli-FALLBACK0001")
    }))

  it.live("no app tab for the file falls back to ego", () =>
    Effect.gen(function* () {
      const settings = testSettings({ queueDir: tempQueue() })
      const desktop = yield* scriptedTransport({ name: "desktop", fail: (r) => new NoDesktopTab({ key: r.key ?? "" }) })
      const ego = yield* scriptedTransport({ name: "ego", opensTabs: true, gated: false })
      const { client } = yield* buildClient(settings, [desktop.transport, ego.transport])
      assert.strictEqual(((yield* client.call({ op: "read", key: KEY })) as { via: string }).via, "ego")
    }))

  it.live("a run that failed in the page does not fall back: it may have written", () =>
    Effect.gen(function* () {
      const settings = testSettings({ queueDir: tempQueue() })
      const desktop = yield* scriptedTransport({ name: "desktop", fail: () => new RunFailed({ transport: "desktop", detail: "boom" }) })
      const ego = yield* scriptedTransport({ name: "ego", opensTabs: true, gated: false })
      const { client } = yield* buildClient(settings, [desktop.transport, ego.transport])
      const error = yield* Effect.flip(client.call({ op: "write", key: KEY }))
      assert.strictEqual(error._tag, "RunFailed")
      assert.strictEqual(ego.stats.runs.length, 0)
    }))

  it.live("the last transport's error comes back when every one is unavailable", () =>
    Effect.gen(function* () {
      const settings = testSettings({ queueDir: tempQueue() })
      const ego = makeEgo(testSettings({ queueDir: settings.queueDir, egoBrowser: ["/nonexistent/ego-browser"] }), readOnly)
      const { client } = yield* buildClient(settings, [ego])
      const error = yield* Effect.flip(client.call({ op: "pages", key: KEY }))
      assert.strictEqual(error._tag, "TransportUnavailable")
      assert.match(error.message, /not installed/)
    }))

  it.live("the ego transport sends the page script, the file's Space and the server name to ego-browser", () =>
    Effect.gen(function* () {
      const queueDir = tempQueue()
      const bin = join(queueDir, "bin")
      mkdirSync(bin)
      const stub = join(bin, "ego-browser")
      // The stub runs the script it gets with INPUT replaced by a fake page API, and reports what it saw.
      writeFileSync(stub, `#!/bin/sh
args="$*"
input=$(cat)
space=$(printf '%s' "$input" | head -1 | sed 's/.*"space":"\\([^"]*\\)".*/\\1/')
printf 'FIGMACLI_JSON:{"args":"%s","space":"%s","script":%s}\\n' "$args" "$space" "$(printf '%s' "$input" | grep -c 'FIGMACLI_JSON:')"
`)
      chmodSync(stub, 0o755)
      const settings = testSettings({ queueDir, egoBrowser: [stub], egoServerName: "work" })
      const { client } = yield* buildClient(settings, [makeEgo(settings, readOnly)])
      const answer = (yield* client.call({ op: "pages", key: KEY })) as { args: string; space: string; script: number }
      assert.strictEqual(answer.args, "--ego-server-name=work nodejs")
      assert.strictEqual(answer.space, "figmacli-FALLBACK0001")
      assert.isAtLeast(answer.script, 1)
    }).pipe(Effect.timeout(Duration.seconds(10))))
})
