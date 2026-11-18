// One run: take the file's lock, then a tab slot if the transport opens tabs, then run the page script in the
// file's Space, and decode its answer. Different files never wait for each other; only the tab cap joins them.
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

/** Nothing ran in a page, so the next transport may take the run, a write included. */
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

  /** Tries each transport in order; moves on only when nothing ran in a page. */
  const runAny = (request: Request, timeout: Duration.Duration): Effect.Effect<string, AppError> => {
    const attempt = (index: number, last?: TransportError): Effect.Effect<string, AppError> => {
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
      // A cold Space opens its tab: the first run on a file does that alone, so two reads never race to open it.
      if (key && access === "read" && transports[0]?.opensTabs && (yield* pool.lastUsed(key)) === undefined) access = "write"
      const timeout = options.timeout ?? config.runTimeout
      const raw = yield* Effect.scoped(
        Effect.gen(function* () {
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

const friendly = (raw: string): string => {
  const flat = raw.split(/\s+/).filter(Boolean).join(" ")
  return flat.includes("not signed in") ? "the browser is not signed in to Figma. Open figma.com in the browser, sign in, then retry" : raw
}

export const FigmaClientLive = Layer.effect(FigmaClient, makeFigmaClient)
