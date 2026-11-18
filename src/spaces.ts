import { Clock, Context, Duration, Effect, Layer, Scope, Semaphore } from "effect"
import { mkdirSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { FigmaConfig } from "./config.ts"
import { LockIOError, TabTimeout } from "./domain.ts"
import { openLockFile, tryLock, unlockAndClose } from "./flock.ts"

/** The Space of keyless runs (doctor), and the prefix of every file's Space. figmacli 0.1.0 used it for all. */
export const BASE_SPACE = "figmacli"

export const spaceFor = (key: string | undefined) => (key ? `${BASE_SPACE}-${key}` : BASE_SPACE)

export interface SpacePoolShape {
  /** Holds a tab slot until the scope closes. With no cap, or a transport that opens no tab, it holds nothing. */
  readonly takeTab: (opensTabs: boolean) => Effect.Effect<void, TabTimeout | LockIOError, Scope.Scope>
  /** Records that a run used the file's Space now. */
  readonly touch: (key: string) => Effect.Effect<void>
  /** When a run last used the file's Space, in epoch ms; undefined when none did, or the reaper closed it. */
  readonly lastUsed: (key: string) => Effect.Effect<number | undefined>
  /** Marks the Space closed, so the next run on the file opens it alone. */
  readonly forget: (key: string) => Effect.Effect<void>
}

export class SpacePool extends Context.Service<SpacePool, SpacePoolShape>()("figma-fast/SpacePool") {}

export const makeSpacePool = Effect.gen(function* () {
  const config = yield* FigmaConfig
  const tabsDir = join(config.queueDir, "tabs")
  const filesDir = join(config.queueDir, "files")
  const local = config.maxTabs > 0 ? Semaphore.makeUnsafe(config.maxTabs) : undefined

  const takeTab = (opensTabs: boolean) =>
    Effect.gen(function* () {
      if (!opensTabs || !local) return
      const started = yield* Clock.currentTimeMillis
      const fail = Effect.flatMap(Clock.currentTimeMillis, (now) => Effect.fail(new TabTimeout({ max: config.maxTabs, waitedMs: now - started })))
      yield* Semaphore.takeScoped(local, 1).pipe(Effect.timeoutOrElse({ duration: config.lockWait, orElse: () => fail }))
      yield* Effect.try({ try: () => mkdirSync(tabsDir, { recursive: true, mode: 0o700 }), catch: (cause) => new LockIOError({ path: tabsDir, cause }) })
      const deadline = started + Duration.toMillis(config.lockWait)
      for (;;) {
        for (let slot = 0; slot < config.maxTabs; slot++) {
          const path = join(tabsDir, `slot-${slot}.lock`)
          const file = yield* Effect.try({ try: () => openLockFile(path), catch: (cause) => new LockIOError({ path, cause }) })
          if (tryLock(file, "exclusive")) {
            yield* Effect.addFinalizer(() => Effect.sync(() => unlockAndClose(file)))
            return
          }
          unlockAndClose(file)
        }
        if ((yield* Clock.currentTimeMillis) >= deadline) return yield* fail
        yield* Effect.sleep(config.lockPoll)
      }
    })

  const stamp = (key: string) => join(filesDir, `${key}.last`)

  const touch = (key: string) =>
    Effect.sync(() => {
      try {
        mkdirSync(filesDir, { recursive: true, mode: 0o700 })
        const now = new Date()
        writeFileSync(stamp(key), now.toISOString(), { mode: 0o600 })
        utimesSync(stamp(key), now, now)
      } catch {
      }
    })

  const lastUsed = (key: string) =>
    Effect.sync(() => {
      try {
        const ms = statSync(stamp(key)).mtimeMs
        return ms > 0 ? ms : undefined
      } catch {
        return undefined
      }
    })

  const forget = (key: string) =>
    Effect.sync(() => {
      try {
        writeFileSync(stamp(key), "")
        utimesSync(stamp(key), new Date(0), new Date(0))
      } catch {
      }
    })

  return SpacePool.of({ takeTab, touch, lastUsed, forget })
})

export const SpacePoolLive = Layer.effect(SpacePool, makeSpacePool)
