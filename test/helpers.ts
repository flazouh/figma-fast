import { Context, Deferred, Effect, Layer, Queue } from "effect"
import { spawn } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FigmaClient, FigmaClientLive } from "../src/client.ts"
import { FigmaConfig, type Settings, testSettings } from "../src/config.ts"
import type { Request, Ticket, TransportError } from "../src/domain.ts"
import { LockManager, LockManagerLive, type OnWait } from "../src/locks.ts"
import { SpacePoolLive } from "../src/spaces.ts"
import { type TransportShape, Transports } from "../src/transport.ts"
import { fakeAppBin, holderBin } from "./global-setup.ts"

export const tempQueue = () => mkdtempSync(join(tmpdir(), "figma-fast-test-"))

/** One run the scripted transport is holding: the test lets it finish by opening its gate. */
export interface Held {
  readonly request: Request
  readonly gate: Deferred.Deferred<void>
}

/**
 * A transport that reports each run as it starts, then waits for the test to open that run's gate. It counts the
 * runs in flight, so a test can read the most that ever ran at once.
 */
export const scriptedTransport = (options: {
  readonly name?: "desktop" | "ego"
  readonly opensTabs?: boolean
  readonly fail?: (request: Request) => TransportError | undefined
  readonly gated?: boolean
}) =>
  Effect.gen(function* () {
    const started = yield* Queue.unbounded<Held>()
    const stats = { active: 0, max: 0, runs: [] as Array<Request> }
    const transport: TransportShape = {
      name: options.name ?? "ego",
      opensTabs: options.opensTabs ?? false,
      run: (request) =>
        Effect.gen(function* () {
          const failure = options.fail?.(request)
          if (failure) return yield* Effect.fail(failure)
          stats.runs.push(request)
          stats.active += 1
          stats.max = Math.max(stats.max, stats.active)
          const gate = yield* Deferred.make<void>()
          yield* Queue.offer(started, { request, gate })
          if (options.gated !== false) yield* Deferred.await(gate)
          stats.active -= 1
          return JSON.stringify({ ok: true, op: request.op, key: request.key, space: request.space, via: options.name ?? "ego" })
        }),
    }
    return { transport, started, stats }
  })

/** A client stack, as one process has it, on the given queue folder. Two stacks on one folder are two processes. */
export const clientLayer = (settings: Settings, transports: ReadonlyArray<TransportShape>, onWait?: OnWait) => {
  const config = Layer.succeed(FigmaConfig, settings)
  const base = Layer.mergeAll(LockManagerLive(onWait ? { onWait } : {}), SpacePoolLive, Layer.succeed(Transports, transports)).pipe(
    Layer.provideMerge(config),
  )
  return FigmaClientLive.pipe(Layer.provideMerge(base))
}

/** Builds a client stack inside the current scope, and returns its client and lock manager. */
export const buildClient = (settings: Settings, transports: ReadonlyArray<TransportShape>, onWait?: OnWait) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(clientLayer(settings, transports, onWait))
    const client = Context.get(context, FigmaClient)
    const locks = Context.get(context, LockManager)
    return { client, locks }
  })

/** An onWait that hands each "waiting for holder" to the test as a signal. */
export const waitSignals = Effect.gen(function* () {
  const waits = yield* Queue.unbounded<{ key: string; holder: Ticket }>()
  const onWait: OnWait = (key, holder) => Queue.offer(waits, { key, holder }).pipe(Effect.asVoid)
  return { waits, onWait }
})

export { testSettings }

/** Starts the Go holder, built by the global setup, on the fake app and resolves once it listens. */
export const startHolder = (socket: string) =>
  Effect.acquireRelease(
    Effect.callback<ReturnType<typeof spawn>>((resume) => {
      const child = spawn(holderBin, [], {
        env: { ...process.env, FIGMA_HOLDER_APP: fakeAppBin, FIGMACLI_DESKTOP_SOCKET: socket },
        stdio: ["ignore", "pipe", "inherit"],
      })
      child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
        if (chunk.includes("listening")) resume(Effect.succeed(child))
      })
      child.once("exit", (code) => resume(Effect.die(new Error(`figma-fast-holder ended with ${code} before it listened`))))
    }),
    (child) => Effect.sync(() => child.kill("SIGKILL")),
  )

