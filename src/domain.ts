// The data shape every layer shares. A run is one Request for one file (or none, for doctor), with an Access
// that decides its lock. Errors are tagged so the CLI can pick the exit code and the client can pick a fallback.
import { Data } from "effect"

/** A Figma file key, as a link or bare key parses to. */
export type FileKey = string & { readonly _brand: "FileKey" }

/** read: many at once per file. write: alone on its file. */
export type Access = "read" | "write"

export type Op =
  | "file" | "pages" | "read" | "export" | "plan" | "doctor" | "check"
  | "write" | "tokens" | "arrange" | "label" | "swap" | "grid" | "eval" | "rename" | "close"

/** The JSON the page script reads as INPUT. Field names match figmacli 0.1.0, so figma.mjs runs unchanged. */
export interface Request {
  readonly op: Op
  readonly key?: FileKey
  readonly space?: string
  /** Only an exclusive run may close the space's extra pages. */
  readonly exclusive?: boolean
  readonly page?: string
  readonly depth?: number
  readonly node?: string
  readonly scale?: number
  readonly name?: string
  readonly replace?: boolean
  readonly dry?: boolean
  readonly shapes?: ReadonlyArray<string>
  readonly script?: string
  readonly evalMs?: number
  readonly spec?: unknown
  readonly tokens?: unknown
  readonly arrange?: unknown
  readonly label?: unknown
  readonly grid?: unknown
  readonly swap?: unknown
}

const readOps: ReadonlySet<Op> = new Set<Op>(["file", "pages", "read", "export", "plan", "doctor", "check"])

/** A dry run changes nothing, so it locks as a read. eval may change the file, so it locks as a write. */
export const accessOf = (request: Request): Access =>
  readOps.has(request.op) || request.dry === true ? "read" : "write"

/** Who waits for, or holds, a file's lock. One JSON file per run in the file's ticket folder. */
export interface Ticket {
  readonly pid: number
  readonly op: string
  readonly access: Access
  readonly state: "waiting" | "holding"
  readonly dir: string
  /** Epoch milliseconds. */
  readonly since: number
}

export const describeTicket = (t: Ticket): string =>
  `pid ${t.pid}, ${t.access} "${t.op}" in ${t.dir}, ${t.state} since ${new Date(t.since).toTimeString().slice(0, 8)}`

// ---- errors -------------------------------------------------------------------------------------------------

/** The lock stayed held past FIGMACLI_LOCK_WAIT. holders names who held it. */
export class LockTimeout extends Data.TaggedError("LockTimeout")<{
  readonly key: string
  readonly access: Access
  readonly waitedMs: number
  readonly holders: ReadonlyArray<Ticket>
}> {
  override get message(): string {
    const who = this.holders.length === 0 ? "a process that left no ticket" : this.holders.map(describeTicket).join("; ")
    return `figma-fast waited ${Math.round(this.waitedMs / 1000)} s for the ${this.access} lock on ${this.key}: ${who} holds it`
  }
}

/** Every tab slot stayed taken past FIGMACLI_LOCK_WAIT. */
export class TabTimeout extends Data.TaggedError("TabTimeout")<{ readonly max: number; readonly waitedMs: number }> {
  override get message(): string {
    return `figma-fast waited ${Math.round(this.waitedMs / 1000)} s for a Figma tab: all ${this.max} (FIGMACLI_MAX_TABS) are busy`
  }
}

/** The lock folder could not be read or written. */
export class LockIOError extends Data.TaggedError("LockIOError")<{ readonly path: string; readonly cause: unknown }> {
  override get message(): string {
    return `figma-fast cannot use its lock file ${this.path}: ${String((this.cause as Error)?.message ?? this.cause)}`
  }
}

/** The transport cannot take a run: the holder socket is gone, ego-browser or node is missing. Nothing ran. */
export class TransportUnavailable extends Data.TaggedError("TransportUnavailable")<{
  readonly transport: string
  readonly reason: string
}> {
  override get message(): string {
    return `the ${this.transport} transport is unavailable: ${this.reason}`
  }
}

/** No tab of the Figma app holds the file. Nothing ran in the page. */
export class NoDesktopTab extends Data.TaggedError("NoDesktopTab")<{ readonly key: string }> {
  override get message(): string {
    return `no tab of the Figma app holds file ${this.key}: open it in the app, then retry`
  }
}

/** The transport ran and failed without an answer. A write may have landed. */
export class RunFailed extends Data.TaggedError("RunFailed")<{ readonly transport: string; readonly detail: string }> {
  override get message(): string {
    return `the ${this.transport} run failed: ${this.detail}`
  }
}

/** The run outlived its limit. It may still run in the tab. */
export class RunTimeout extends Data.TaggedError("RunTimeout")<{ readonly transport: string; readonly ms: number }> {
  override get message(): string {
    return `the run did not finish within ${Math.round(this.ms / 1000)} s, opening the file included. It may still run in the Figma tab`
  }
}

/** The page script ran and answered why not. */
export class PageError extends Data.TaggedError("PageError")<{ readonly detail: string }> {
  override get message(): string {
    return this.detail
  }
}

/** A wrong argument, flag value or spec. Exit code 2. */
export class BadInput extends Data.TaggedError("BadInput")<{ readonly detail: string }> {
  override get message(): string {
    return this.detail
  }
}

/** check found something: the report stays on stdout, exit code 1. */
export class Findings extends Data.TaggedError("Findings")<{ readonly count: number; readonly report: string }> {}

export type TransportError = TransportUnavailable | NoDesktopTab | RunFailed | RunTimeout
export type AppError = TransportError | LockTimeout | TabTimeout | LockIOError | PageError | BadInput | Findings

// ---- file keys ----------------------------------------------------------------------------------------------

const fileURL = /^https?:\/\/(?:www\.)?figma\.com\/(?:design|file|make|board|slides|proto)\/([A-Za-z0-9]{10,})(?:[/?#]|$)/
const bareKey = /^[A-Za-z0-9]{10,}$/

/** Takes a file link or a bare file key. */
export const parseKey = (value: string): FileKey | BadInput => {
  const match = fileURL.exec(value)
  if (match?.[1]) return match[1] as FileKey
  if (bareKey.test(value)) return value as FileKey
  return new BadInput({ detail: `${JSON.stringify(value)} is not a Figma file link or file key` })
}
