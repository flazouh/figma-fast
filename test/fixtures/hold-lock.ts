import { Effect, Layer } from "effect"
import { FigmaConfig, testSettings } from "../../src/config.ts"
import { LockManager, LockManagerLive } from "../../src/locks.ts"

const queueDir = process.env.QUEUE ?? ""
const key = process.env.KEY ?? ""
const program = Effect.gen(function* () {
  const locks = yield* LockManager
  yield* locks.acquire(key, "write", "hold-lock fixture")
  process.stdout.write("held\n")
  // WARNING: Effect.never keeps no handle open; without this timer the process exits and the kernel drops the lock early.
  setInterval(() => {}, 1 << 30)
  return yield* Effect.never
})
Effect.runFork(Effect.scoped(program).pipe(Effect.provide(LockManagerLive().pipe(Layer.provide(Layer.succeed(FigmaConfig, testSettings({ queueDir })))))))
