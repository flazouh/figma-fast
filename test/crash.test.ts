// A holder that dies, however it dies, gives its file back: the kernel drops its flock, and its ticket goes.
import { assert, describe, it } from "@effect/vitest"
import { Context, Duration, Effect, Layer } from "effect"
import { spawn } from "node:child_process"
import { join } from "node:path"
import { FigmaConfig } from "../src/config.ts"
import { LockManager, LockManagerLive } from "../src/locks.ts"
import { tempQueue, testSettings } from "./helpers.ts"

const KEY = "CRASHCRASH12"

/** Starts the fixture in its own process and resolves once it holds the lock. */
const holdInChild = (queueDir: string) =>
  Effect.acquireRelease(
    Effect.callback<ReturnType<typeof spawn>>((resume) => {
      const child = spawn(process.execPath, [join(import.meta.dirname, "fixtures", "hold-lock.ts")], {
        env: { ...process.env, QUEUE: queueDir, KEY },
        stdio: ["ignore", "pipe", "inherit"],
      })
      child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
        if (chunk.includes("held")) resume(Effect.succeed(child))
      })
    }),
    (child) => Effect.sync(() => child.kill("SIGKILL")),
  )

const killed = (child: ReturnType<typeof spawn>) =>
  Effect.callback<void>((resume) => {
    child.once("exit", () => resume(Effect.void))
    child.kill("SIGKILL")
  })

const locksWith = (queueDir: string, lockWait: Duration.Duration) =>
  Layer.build(LockManagerLive().pipe(Layer.provide(Layer.succeed(FigmaConfig, testSettings({ queueDir, lockWait }))))).pipe(
    Effect.map((context) => Context.get(context, LockManager)),
  )

describe("crash safety", () => {
  it.live("a killed holder's lock is released and its ticket cleared", () =>
    Effect.gen(function* () {
      const queueDir = tempQueue()
      const child = yield* holdInChild(queueDir)
      const short = yield* locksWith(queueDir, Duration.millis(150))

      // While it lives, a run times out and names it.
      const error = yield* Effect.flip(Effect.scoped(short.acquire(KEY, "write", "test")))
      assert.strictEqual(error._tag, "LockTimeout")
      assert.match(error.message, new RegExp(`pid ${child.pid}, write "hold-lock fixture"`))

      yield* killed(child)
      const patient = yield* locksWith(queueDir, Duration.seconds(5))
      yield* Effect.scoped(patient.acquire(KEY, "write", "after the crash"))
      const left = yield* patient.tickets(KEY)
      assert.deepStrictEqual(left.filter((t) => t.pid === child.pid), [])
    }))
})
