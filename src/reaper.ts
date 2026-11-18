import { Clock, Duration, Effect } from "effect"
import { spawn } from "node:child_process"
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs"
import { join } from "node:path"
import { FigmaClient } from "./client.ts"
import { FigmaConfig } from "./config.ts"
import type { FileKey } from "./domain.ts"
import { alive, LockManager } from "./locks.ts"
import { SpacePool } from "./spaces.ts"

export const REAP_COMMAND = "_reap"

/** The files whose Space is open and idle past the limit, with no run waiting or holding. */
export const idleKeys = Effect.gen(function* () {
  const config = yield* FigmaConfig
  const locks = yield* LockManager
  const pool = yield* SpacePool
  const now = yield* Clock.currentTimeMillis
  const idle: Array<string> = []
  let open = 0
  for (const key of yield* locks.keys) {
    const last = yield* pool.lastUsed(key)
    if (last === undefined) continue
    open++
    if (now - last < Duration.toMillis(config.idleClose)) continue
    if ((yield* locks.tickets(key)).length > 0) continue
    idle.push(key)
  }
  return { idle, open }
})

/** One pass: closes each idle Space under its file's write lock. Returns how many Spaces stay open. */
export const reapOnce = Effect.gen(function* () {
  const client = yield* FigmaClient
  const pool = yield* SpacePool
  const { idle, open } = yield* idleKeys
  for (const key of idle) {
    const closed = yield* client.call({ op: "close", key: key as FileKey }, { timeout: Duration.minutes(3) }).pipe(Effect.as(true), Effect.orElseSucceed(() => false))
    if (closed) yield* pool.forget(key)
  }
  return open - idle.length
})

const pidFile = (queueDir: string) => join(queueDir, "reaper-fast.pid")

/** Makes this process the one reaper, or says another one runs. The pid file is created exclusively. */
export const claimReaper = (queueDir: string) => {
  mkdirSync(queueDir, { recursive: true, mode: 0o700 })
  try {
    const pid = Number(readFileSync(pidFile(queueDir), "utf8"))
    if (pid > 0 && alive(pid)) return undefined
    rmSync(pidFile(queueDir), { force: true })
  } catch {
  }
  try {
    const fd = openSync(pidFile(queueDir), "wx", 0o600)
    writeSync(fd, String(process.pid))
    closeSync(fd)
    return () => rmSync(pidFile(queueDir), { force: true })
  } catch {
    return undefined
  }
}

export const reaperRuns = (queueDir: string) => {
  try {
    const pid = Number(readFileSync(pidFile(queueDir), "utf8"))
    return pid > 0 && alive(pid)
  } catch {
    return false
  }
}

/** Starts the reaper in the background when none runs. It outlives the run that started it. */
export const startReaper = (queueDir: string) => () => {
  if (reaperRuns(queueDir)) return
  const script = process.argv[1]
  const args = script && /\.(ts|js|mjs)$/.test(script) ? [script, REAP_COMMAND] : [REAP_COMMAND]
  try {
    spawn(process.execPath, args, { detached: true, stdio: "ignore" }).unref()
  } catch {
  }
}

/** The reaper's life: claim the place, look every poll, end when no Space is open. */
export const reap = (poll: Duration.Duration) =>
  Effect.gen(function* () {
    const config = yield* FigmaConfig
    const release = claimReaper(config.queueDir)
    if (!release) return
    yield* Effect.gen(function* () {
      for (;;) {
        yield* Effect.sleep(poll)
        if ((yield* reapOnce) <= 0) return
      }
    }).pipe(Effect.ensuring(Effect.sync(release)))
  })
