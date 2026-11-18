#!/usr/bin/env bun
// figma-fast: figmacli 0.1.0's commands, with per-file locks so different files run at once.
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Duration, Effect, Layer } from "effect"
import { Command } from "effect/cli"
import { AfterRun, FigmaClientLive } from "./client.ts"
import { AppLayer, makeRoot, normalizeArgs, topHelp, VERSION } from "./cli.ts"
import { FigmaConfigLive } from "./config.ts"
import { LockManagerLive } from "./locks.ts"
import { reap, REAP_COMMAND } from "./reaper.ts"
import { SpacePoolLive } from "./spaces.ts"
import { TransportsLive } from "./transport.ts"

const args = normalizeArgs(process.argv.slice(2))

if (args[0] === REAP_COMMAND) {
  // The reaper's own stack: no reaper of its own after its runs.
  const layer = FigmaClientLive.pipe(
    Layer.provideMerge(Layer.mergeAll(LockManagerLive(), SpacePoolLive, TransportsLive, Layer.succeed(AfterRun, () => {}))),
    Layer.provideMerge(FigmaConfigLive),
  )
  await Effect.runPromise(reap(Duration.minutes(1)).pipe(Effect.provide(layer), Effect.ignore))
} else if (args.length === 0 || args[0] === "help") {
  process.stdout.write(topHelp())
} else {
  const program = Command.runWith(makeRoot(AppLayer), { version: VERSION })(args).pipe(
    Effect.provide(NodeServices.layer),
    // effect/cli has printed the usage error; the exit code says it was the invocation.
    Effect.catch(() => Effect.sync(() => void (process.exitCode = 2))),
  )
  await Effect.runPromise(program)
}
