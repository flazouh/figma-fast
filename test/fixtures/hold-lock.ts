// Takes the write lock on a file, says "held", and keeps it until it is killed. The crash test kills it with -9.
import { Effect, Layer } from "effect"
import { FigmaConfig, testSettings } from "../../src/config.ts"
import { LockManager, LockManagerLive } from "../../src/locks.ts"

const queueDir = process.env.QUEUE ?? ""
const key = process.env.KEY ?? ""
const program = Effect.gen(function* () {
  const locks = yield* LockManager
  yield* locks.acquire(key, "write", "hold-lock fixture")
  process.stdout.write("held\n")
  // Effect.never keeps no handle open, so the process would end and drop the lock by itself.
  setInterval(() => {}, 1 << 30)
  return yield* Effect.never
})
Effect.runFork(Effect.scoped(program).pipe(Effect.provide(LockManagerLive().pipe(Layer.provide(Layer.succeed(FigmaConfig, testSettings({ queueDir })))))))
