import { Context, Duration, Effect, Layer } from "effect"
import { FigmaConfig } from "./config.ts"
import { type Access, accessOf, type AppError, type NoDesktopTab, PageError, type Request, RunFailed, type TransportError, type TransportUnavailable } from "./domain.ts"
import { LockManager } from "./locks.ts"
import { SpacePool, spaceFor } from "./spaces.ts"
import { type TransportShape, Transports } from "./transport.ts"

export interface RunOptions {
  /** Bounds the transport run once the lock is held; the default is FIGMACLI_RUN_TIMEOUT. */
  readonly timeout?: Duration.Duration
}

export interface FigmaClientShape {
  /** Runs one request and returns the page script's answer. */
  readonly call: (request: Request, options?: RunOptions) => Effect.Effect<unknown, AppError>
  /** The name of the transport tried first. */
  readonly transport: string
}

export class FigmaClient extends Context.Service<FigmaClient, FigmaClientShape>()("figma-fast/FigmaClient") {}

/** Called after each run that used a Space, so the idle reaper runs. */
export class AfterRun extends Context.Reference<() => void>("figma-fast/AfterRun", { defaultValue: () => () => {} }) {}

// WARNING: only errors that prove nothing ran in a page may move on; a write must never run on two transports.
const movesOn = (error: AppError): error is TransportUnavailable | NoDesktopTab =>
  error._tag === "TransportUnavailable" || error._tag === "NoDesktopTab"

export const makeFigmaClient = Effect.gen(function* () {
  const config = yield* FigmaConfig
  const locks = yield* LockManager
  const pool = yield* SpacePool
  const transports = yield* Transports
  const afterRun = yield* AfterRun

  const runOn = (transport: TransportShape, request: Request, timeout: Duration.Duration) =>
    Effect.scoped(Effect.andThen(pool.takeTab(transport.opensTabs), transport.run(request, timeout)))

  const runAny = (request: Request, timeout: Duration.Duration) => {
    const attempt: (index: number, last?: TransportError) => Effect.Effect<string, AppError> = (index, last) => {
      const transport = transports[index]
      if (!transport) return Effect.fail(last ?? new RunFailed({ transport: "none", detail: "no transport is configured" }))
      return runOn(transport, request, timeout).pipe(
        Effect.catchIf(
          (error): error is TransportUnavailable | NoDesktopTab => movesOn(error) && index + 1 < transports.length,
          (error) => attempt(index + 1, error),
        ),
      )
    }
    return attempt(0)
  }

  const call = (request: Request, options: RunOptions = {}) =>
    Effect.gen(function* () {
      const key = request.key
      let access: Access = accessOf(request)
      // WARNING: a cold Space opens a tab, so its first read takes the write lock or two readers open two tabs.
      if (key && access === "read" && transports[0]?.opensTabs && (yield* pool.lastUsed(key)) === undefined) access = "write"
      const timeout = options.timeout ?? config.runTimeout
      const raw = yield* Effect.scoped(
        Effect.gen(function* () {
          // WARNING: take the file lock before a tab slot, never the reverse, or a full pool deadlocks against a lock holder.
          if (key) yield* locks.acquire(key, access, request.op)
          const line = yield* runAny({ ...request, space: spaceFor(key), exclusive: access === "write" }, timeout)
          if (key && request.op !== "close") yield* pool.touch(key)
          return line
        }),
      )
      if (request.op !== "close") afterRun()
      let answer: unknown
      try {
        answer = JSON.parse(raw)
      } catch (error) {
        return yield* new RunFailed({ transport: transports[0]?.name ?? "none", detail: `the page answered something that is not JSON: ${String(error)}` })
      }
      const failure = (answer as { error?: unknown } | null)?.error
      if (typeof failure === "string" && failure !== "") return yield* new PageError({ detail: friendly(failure) })
      return answer
    })

  return FigmaClient.of({ call, transport: transports[0]?.name ?? "none" })
})

const friendly = (raw: string) => {
  const flat = raw.split(/\s+/).filter(Boolean).join(" ")
  return flat.includes("not signed in") ? "the browser is not signed in to Figma. Open figma.com in the browser, sign in, then retry" : raw
}

export const FigmaClientLive = Layer.effect(FigmaClient, makeFigmaClient)
