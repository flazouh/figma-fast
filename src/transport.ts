import { Context, Duration, Effect, Layer } from "effect"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { createConnection } from "node:net"
import { join } from "node:path"
import script from "../assets/figma.mjs" with { type: "text" }
import shim from "../assets/shim.mjs" with { type: "text" }
import { FigmaConfig, type Settings } from "./config.ts"
import { NoDesktopTab, type Request, RunFailed, RunTimeout, type TransportError, TransportUnavailable } from "./domain.ts"
import { compact, extractMarked, runProcess } from "./process.ts"

export const MARKER = "FIGMACLI_JSON:"

export interface TransportShape {
  readonly name: "desktop" | "ego"
  /** Says a run opens a browser tab, and so needs a tab slot. */
  readonly opensTabs: boolean
  /** Runs the page script once and returns its one JSON line. */
  readonly run: (request: Request, timeout: Duration.Duration) => Effect.Effect<string, TransportError>
}

export class Transports extends Context.Service<Transports, ReadonlyArray<TransportShape>>()("figma-fast/Transports") {}

/** Says a holder answers a CDP call on the socket within the limit. It sends one Browser.getVersion. */
export const desktopHealthy = (socket: string, limit: Duration.Duration = Duration.seconds(1)) =>
  Effect.callback<boolean>((resume) => {
    const id = 1 + Math.floor(Math.random() * 1e9)
    const conn = createConnection(socket)
    let buffer = ""
    const done = (ok: boolean) => {
      clearTimeout(timer)
      conn.destroy()
      resume(Effect.succeed(ok))
    }
    const timer = setTimeout(() => done(false), Duration.toMillis(limit))
    conn.on("error", () => done(false))
    conn.on("connect", () => conn.write(`${JSON.stringify({ id, method: "Browser.getVersion", params: {} })}\n`))
    conn.setEncoding("utf8").on("data", (chunk: string) => {
      buffer += chunk
      for (const line of buffer.split("\n").slice(0, -1)) {
        try {
          if ((JSON.parse(line) as { id?: number }).id === id) return done(true)
        } catch {
        }
      }
      buffer = buffer.slice(buffer.lastIndexOf("\n") + 1)
    })
    return Effect.sync(() => {
      clearTimeout(timer)
      conn.destroy()
    })
  })

const scriptFile = (queueDir: string, source: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const dir = join(queueDir, "run")
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      const path = join(dir, `${process.pid}-${Math.random().toString(16).slice(2, 10)}.mjs`)
      writeFileSync(path, source, { mode: 0o600 })
      return path
    }),
    (path) => Effect.sync(() => rmSync(path, { force: true })),
  )

export const makeDesktop = (config: Settings) => ({
  name: "desktop",
  opensTabs: false,
  run: (request, timeout) =>
    Effect.gen(function* () {
      const source =
        `const INPUT = ${JSON.stringify(request)};\nconst SOCKET = ${JSON.stringify(config.desktopSocket)};\n` +
        `const CALL_LIMIT = ${120_000};\n${shim}\n${script}\nawait endDesktop();\nprocess.exit(0);\n`
      const result = yield* Effect.scoped(
        // WARNING: run the page script from a file: the Bun node shim cannot read a module from stdin.
        Effect.flatMap(scriptFile(config.queueDir, source), (path) => runProcess([config.node, path], "", timeout)),
      )
      if (result.missing) {
        return yield* new TransportUnavailable({ transport: "desktop", reason: `${config.node} is not installed, and the desktop transport runs the page script in it` })
      }
      const combined = `${result.stdout}\n${result.stderr}`
      const line = extractMarked(combined, MARKER)
      if (line !== undefined) return line
      if (result.timedOut) return yield* new RunTimeout({ transport: "desktop", ms: Duration.toMillis(timeout) })
      if (combined.includes("CDP holder does not answer")) {
        return yield* new TransportUnavailable({ transport: "desktop", reason: compact(combined, 200) })
      }
      if (combined.includes("no tab of the Figma app holds file")) return yield* new NoDesktopTab({ key: request.key ?? "" })
      return yield* new RunFailed({ transport: "desktop", detail: compact(combined, 600) })
    }),
}) satisfies TransportShape

const SPACE_LOST = "Task space not found"

const egoCommand = (config: Settings) => {
  const [program, ...rest] = config.egoBrowser
  const server = config.egoServerName ? [`--ego-server-name=${config.egoServerName}`] : []
  return [program ?? "ego-browser", ...rest, ...server, "nodejs"]
}

const explain = (text: string) =>
  text.includes("not signed in") ? "the browser is not signed in to Figma. Open figma.com in the browser, sign in, then retry" : undefined

export const makeEgo = (config: Settings, retryable: (request: Request) => boolean) => {
  const once = (request: Request, timeout: Duration.Duration) =>
    Effect.gen(function* () {
      const result = yield* runProcess(egoCommand(config), `const INPUT = ${JSON.stringify(request)};\n${script}`, timeout)
      const combined = `${result.stdout}\n${result.stderr}`
      return { result, combined, line: extractMarked(combined, MARKER) }
    })
  return {
    name: "ego",
    opensTabs: true,
    run: (request, timeout) =>
      Effect.gen(function* () {
        let attempt = yield* once(request, timeout)
        const lost = attempt.combined.includes(SPACE_LOST)
        // WARNING: only reads may be retried after a lost Space; a retried write could apply twice.
        if (lost && retryable(request)) attempt = yield* once(request, timeout)
        const { result, combined, line } = attempt
        if (line !== undefined) return line
        if (result.missing || combined.includes("command not found")) {
          return yield* new TransportUnavailable({ transport: "ego", reason: `${config.egoBrowser[0]} is not installed, so there is no browser session to read Figma from` })
        }
        if (result.timedOut) return yield* new RunTimeout({ transport: "ego", ms: Duration.toMillis(timeout) })
        const flat = compact(combined)
        if (flat === "") return yield* new RunFailed({ transport: "ego", detail: "the browser returned nothing at all" })
        return yield* new RunFailed({ transport: "ego", detail: explain(flat) ?? flat })
      }),
  } satisfies TransportShape
}

/** Only a known read may run twice: the first run of a write may have landed. */
export const readOnly = (request: Request) =>
  ["file", "pages", "read", "export", "plan", "doctor", "check", "close"].includes(request.op) || request.dry === true

/** The transports from the settings: forced, or desktop then ego when the holder answers, else ego alone. */
export const TransportsLive = Layer.effect(
  Transports,
  Effect.gen(function* () {
    const config = yield* FigmaConfig
    const desktop = makeDesktop(config)
    const ego = makeEgo(config, readOnly)
    if (config.transport === "desktop") return [desktop]
    if (config.transport === "ego") return [ego]
    return (yield* desktopHealthy(config.desktopSocket)) ? [desktop, ego] : [ego]
  }),
)
