import { Clock, Context, Duration, Effect, Layer, Scope, Semaphore } from "effect"
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { FigmaConfig } from "./config.ts"
import { type Access, LockIOError, LockTimeout, type Ticket } from "./domain.ts"
import { openLockFile, tryLock, unlockAndClose } from "./flock.ts"

/** Any lock-waiting run hears who holds the lock, once each time the holder changes. */
export type OnWait = (key: string, holder: Ticket) => Effect.Effect<void>

export interface LockManagerShape {
  /** Holds the file's lock until the scope closes. Waits up to FIGMACLI_LOCK_WAIT, then names the holder. */
  readonly acquire: (key: string, access: Access, op: string) => Effect.Effect<void, LockTimeout | LockIOError, Scope.Scope>
  /** The live tickets of a file, oldest first. Dead ones are deleted. */
  readonly tickets: (key: string) => Effect.Effect<ReadonlyArray<Ticket>>
  /** Every file key that has a lock file. */
  readonly keys: Effect.Effect<ReadonlyArray<string>>
}

export class LockManager extends Context.Service<LockManager, LockManagerShape>()("figma-fast/LockManager") {}

const ALL = 1 << 20

export const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

interface Entry {
  readonly name: string
  readonly ticket: Ticket
}

/** Reads a ticket folder, oldest first, and deletes the tickets of dead processes and half-written leftovers. */
export const readTickets = (dir: string, isAlive: (pid: number) => boolean = alive) => {
  let names: Array<string>
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".json")).sort()
  } catch {
    return []
  }
  const live: Array<Entry> = []
  for (const name of names) {
    const path = join(dir, name)
    try {
      const ticket = JSON.parse(readFileSync(path, "utf8")) as Ticket
      if (isAlive(ticket.pid)) live.push({ name, ticket })
      else rmSync(path, { force: true })
    } catch {
      try {
        if (Date.now() - statSync(path).mtimeMs > 60_000) rmSync(path, { force: true })
      } catch {
      }
    }
  }
  return live
}

const writeTicket = (path: string, ticket: Ticket) => {
  const draft = `${path}.draft`
  writeFileSync(draft, JSON.stringify(ticket), { mode: 0o600 })
  renameSync(draft, path)
}

const safeKey = (key: string) => key.replace(/[^A-Za-z0-9_-]/g, "_")

export const makeLockManager = (options: { readonly onWait?: OnWait; readonly isAlive?: (pid: number) => boolean } = {}) =>
  Effect.gen(function* () {
    const config = yield* FigmaConfig
    const isAlive = options.isAlive ?? alive
    const onWait = options.onWait ?? (() => Effect.void)
    const filesDir = join(config.queueDir, "files")
    const inProcess = new Map<string, Semaphore.Semaphore>()
    const semaphoreFor = (key: string) => {
      let found = inProcess.get(key)
      if (!found) {
        found = Semaphore.makeUnsafe(ALL)
        inProcess.set(key, found)
      }
      return found
    }

    const ensureDir = (path: string) =>
      Effect.try({ try: () => mkdirSync(path, { recursive: true, mode: 0o700 }), catch: (cause) => new LockIOError({ path, cause }) })

    const tickets = (key: string) => Effect.sync(() => readTickets(join(filesDir, `${safeKey(key)}.tickets`), isAlive).map((e) => e.ticket))

    const acquire = (key: string, access: Access, op: string) =>
      Effect.gen(function* () {
        const started = yield* Clock.currentTimeMillis
        const deadline = started + Duration.toMillis(config.lockWait)
        const timeout = (holders: ReadonlyArray<Ticket>) =>
          Effect.flatMap(Clock.currentTimeMillis, (now) => Effect.fail(new LockTimeout({ key, access, waitedMs: now - started, holders })))

        yield* Semaphore.takeScoped(semaphoreFor(key), access === "read" ? 1 : ALL).pipe(
          Effect.timeoutOrElse({
            duration: config.lockWait,
            orElse: () => timeout([{ pid: process.pid, op: "another run in this process", access: "write", state: "holding", dir: process.cwd(), since: started }]),
          }),
        )

        const ticketDir = join(filesDir, `${safeKey(key)}.tickets`)
        yield* ensureDir(ticketDir)
        const mine: Ticket = { pid: process.pid, op, access, state: "waiting", dir: process.cwd(), since: Date.now() }
        const name = `${String(mine.since).padStart(15, "0")}-${process.pid}-${Math.random().toString(16).slice(2, 10)}.json`
        const ticketPath = join(ticketDir, name)
        const lockPath = join(filesDir, `${safeKey(key)}.lock`)
        const file = yield* Effect.acquireRelease(
          Effect.try({
            try: () => {
              writeTicket(ticketPath, mine)
              // WARNING: flock belongs to the open file description, so every acquisition needs its own fd; never share one between fibers.
              return openLockFile(lockPath)
            },
            catch: (cause) => new LockIOError({ path: lockPath, cause }),
          }),
          (opened) =>
            Effect.sync(() => {
              unlockAndClose(opened)
              rmSync(ticketPath, { force: true })
            }),
        )
        let told = ""
        for (;;) {
          const others = readTickets(ticketDir, isAlive).filter((e) => e.name !== name)
          const olderWriter = access === "read" && others.some((e) => e.ticket.access === "write" && e.ticket.state === "waiting" && e.name < name)
          if (!olderWriter && tryLock(file, access === "read" ? "shared" : "exclusive")) {
            yield* Effect.try({
              try: () => writeTicket(ticketPath, { ...mine, state: "holding" }),
              catch: (cause) => new LockIOError({ path: ticketPath, cause }),
            })
            return
          }
          const holders = others.map((e) => e.ticket)
          const first = holders.find((t) => t.state === "holding") ?? holders[0]
          if (first && JSON.stringify(first) !== told) {
            told = JSON.stringify(first)
            yield* onWait(key, first)
          }
          const now = yield* Clock.currentTimeMillis
          if (now >= deadline) return yield* timeout(holders)
          yield* Effect.sleep(config.lockPoll)
        }
      })

    const keys = Effect.sync(() => {
      try {
        return readdirSync(filesDir).filter((n) => n.endsWith(".lock")).map((n) => n.slice(0, -5))
      } catch {
        return []
      }
    })

    return LockManager.of({ acquire, tickets, keys })
  })

export const LockManagerLive = (options?: { readonly onWait?: OnWait }) => Layer.effect(LockManager, makeLockManager(options))
