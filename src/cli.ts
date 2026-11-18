import { Effect, Layer } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { AfterRun, FigmaClient, FigmaClientLive } from "./client.ts"
import { FigmaConfig, FigmaConfigLive, parseGoDuration } from "./config.ts"
import * as C from "./commands.ts"
import { type AppError, BadInput, describeTicket, type FileKey, parseKey } from "./domain.ts"
import { LockManager, LockManagerLive } from "./locks.ts"
import { startReaper } from "./reaper.ts"
import { SpacePoolLive } from "./spaces.ts"
import { value } from "./toon.ts"
import { TransportsLive } from "./transport.ts"

export const VERSION = "0.2.0"
const BIN = "figma-fast"

/** Turns -name and -name=value into --name forms. A lone "-" (stdin) and anything after "--" stay as they are. */
export const normalizeArgs = (args: ReadonlyArray<string>) => {
  const out: Array<string> = []
  let rest = false
  for (const arg of args) {
    if (rest || arg === "--") {
      rest = true
      out.push(arg)
    } else out.push(/^-[A-Za-z][A-Za-z0-9-]+(=.*)?$/.test(arg) ? `-${arg}` : arg)
  }
  return out
}

/** Everything a command needs, built only when a command runs, so --help never probes the holder. */
export const AppLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* FigmaConfig
    const base = Layer.mergeAll(
      LockManagerLive({ onWait: (key, holder) => Effect.sync(() => process.stderr.write(`${BIN}: waiting for file ${key}, held by ${describeTicket(holder)}\n`)) }),
      SpacePoolLive,
      TransportsLive,
      Layer.succeed(AfterRun, config.reaper ? startReaper(config.queueDir) : () => {}),
    )
    return FigmaClientLive.pipe(Layer.provideMerge(base))
  }),
).pipe(Layer.provideMerge(FigmaConfigLive))

type Services = FigmaClient | LockManager | FigmaConfig

/** The output of one command, or why not: stdout, stderr, exit code. */
export interface Outcome { readonly stdout: string; readonly stderr: string; readonly code: number }

export const outcomeOf = <R>(name: string, dataOut: boolean, run: Effect.Effect<string, AppError, R>) =>
  run.pipe(
    Effect.map((stdout) => ({ stdout, stderr: "", code: 0 })),
    Effect.catch((error: AppError) => {
      if (error._tag === "Findings") return Effect.succeed({ stdout: error.report, stderr: "", code: 1 })
      const usage = error._tag === "BadInput"
      const report = `error: ${error.message}\n${usage ? `help: Run \`${BIN} ${name} --help\` for its flags\n` : ""}`
      const code = usage ? 2 : 1
      return Effect.succeed(dataOut ? { stdout: "", stderr: report, code } : { stdout: report, stderr: "", code })
    }),
  )

const respond = (name: string, dataOut: boolean, run: Effect.Effect<string, AppError, Services>, layer: Layer.Layer<Services, unknown>) =>
  outcomeOf(name, dataOut, run).pipe(
    Effect.provide(layer),
    Effect.catchCause((cause) => Effect.succeed<Outcome>({ stdout: "", stderr: `error: ${String(cause)}\n`, code: 1 })),
    Effect.flatMap((o) =>
      Effect.sync(() => {
        if (o.stdout) process.stdout.write(o.stdout)
        if (o.stderr) process.stderr.write(o.stderr)
        process.exitCode = o.code
      }),
    ),
  )

const keyArg = Argument.String("link|key").pipe(Argument.withDescription("a Figma file link or file key"))
const jsonFlag = Flag.Boolean("json").pipe(Flag.withDefault(false), Flag.withDescription("print JSON instead of TOON"))
const yesFlag = (what: string) => Flag.Boolean("yes").pipe(Flag.withDefault(false), Flag.withDescription(`really ${what}; only after Alex approved this exact action`))

const withKey = (raw: string, run: (key: FileKey) => Effect.Effect<string, AppError, Services>) => {
  const key = parseKey(raw)
  return key instanceof BadInput ? Effect.fail(key) : run(key)
}

const withInput = (path: string, run: (text: string) => Effect.Effect<string, AppError, Services>) => {
  const text = C.readInput(path)
  return text instanceof BadInput ? Effect.fail(text) : run(text)
}

export const makeRoot = (layer: Layer.Layer<Services, unknown>) => {
  const go = (name: string, run: Effect.Effect<string, AppError, Services>, dataOut = false) => respond(name, dataOut, run, layer)

  const file = Command.make("file", { key: keyArg, json: jsonFlag }, (o) => go("file", withKey(o.key, (k) => C.runFile(k, o.json)))).pipe(
    Command.withDescription("Name, kind (design, make, figjam, slides), edit right, and pages of a Design file"))
  const pages = Command.make("pages", { key: keyArg, json: jsonFlag }, (o) => go("pages", withKey(o.key, (k) => C.runPages(k, o.json)))).pipe(
    Command.withDescription("Pages of a Design file with the top-level node count of each"))
  const read = Command.make("read", {
    key: keyArg,
    page: Flag.String("page").pipe(Flag.withDefault(""), Flag.withDescription("page name; the first page when empty")),
    depth: Flag.Int("depth").pipe(Flag.withDefault(3), Flag.withDescription("how many levels of nodes to show")),
  }, (o) => go("read", withKey(o.key, (k) => C.runRead(k, o.page, o.depth)))).pipe(
    Command.withDescription("Nodes of one page of a Design file: id, type, name, size, text"))
  const write = Command.make("write", {
    key: keyArg, spec: Argument.String("spec.json|-"), yes: yesFlag("draw"),
    replace: Flag.Boolean("replace").pipe(Flag.withDefault(false), Flag.withDescription("remove top-level nodes with the same name first")), json: jsonFlag,
  }, (o) => go("write", withKey(o.key, (k) => withInput(o.spec, (t) => C.runWrite(k, t, o))))).pipe(
    Command.withDescription("Draw a JSON spec into a Design file; without -yes it lists what it would remove or change and draws nothing"))
  const tokens = Command.make("tokens", { key: keyArg, file: Argument.String("tokens.json"), yes: yesFlag("write") },
    (o) => go("tokens", withKey(o.key, (k) => withInput(o.file, (t) => C.runTokens(k, t, o.yes))))).pipe(
    Command.withDescription("Push design/tokens.json: colours and numbers to variables, type and shadows to styles; without -yes it lists what would change"))
  const swap = Command.make("swap", { key: keyArg, spec: Argument.String("swap.json"), yes: Flag.Boolean("yes").pipe(Flag.withDefault(false), Flag.withDescription("really move the instances")), json: jsonFlag },
    (o) => go("swap", withKey(o.key, (k) => withInput(o.spec, (t) => C.runSwap(k, t, o))))).pipe(
    Command.withDescription("Move the instances of one set's variants to another set, in both themes; without -yes it counts them"))
  const arrange = Command.make("arrange", { key: keyArg, spec: Argument.String("spec.json"), yes: yesFlag("arrange") },
    (o) => go("arrange", withKey(o.key, (k) => withInput(o.spec, (t) => C.runArrange(k, t, o.yes))))).pipe(
    Command.withDescription("Rename and order pages, and move top-level nodes into sections"))
  const label = Command.make("label", { key: keyArg, spec: Argument.String("spec.json"), yes: yesFlag("label"), json: jsonFlag },
    (o) => go("label", withKey(o.key, (k) => withInput(o.spec, (t) => C.runLabel(k, t, o))))).pipe(
    Command.withDescription("Lay out a component set and label each variant; instances stay linked"))
  const grid = Command.make("grid", { key: keyArg, spec: Argument.String("grid.json"), yes: yesFlag("lay out"), json: jsonFlag },
    (o) => go("grid", withKey(o.key, (k) => withInput(o.spec, (t) => C.runGrid(k, t, o))))).pipe(
    Command.withDescription("Lay a mockup section out as a grid: one frame per row, one column per variant, column names once"))
  const check = Command.make("check", {
    key: keyArg,
    page: Flag.String("page").pipe(Flag.withDefault("Mockups"), Flag.withDescription("page to check, or all")),
    shapes: Flag.String("shapes").pipe(Flag.withDefault("Icon,Mark"), Flag.withDescription("component sets that may hold vectors, by name")),
    json: jsonFlag,
  }, (o) => go("check", withKey(o.key, (k) => C.runCheck(k, o.page, o.shapes, o.json)))).pipe(
    Command.withDescription("List detached instances, hand-set colours, stray vectors, unbound sizes and duplicate names; exit code 1 means it found something"))
  const exportCmd = Command.make("export", {
    key: keyArg,
    node: Flag.String("node").pipe(Flag.withDefault(""), Flag.withDescription("node id or name")),
    out: Flag.String("out").pipe(Flag.withDefault(""), Flag.withDescription("PNG file to write")),
    scale: Flag.Finite("scale").pipe(Flag.withDefault(2), Flag.withDescription("pixel density, 0.5 to 4")),
  }, (o) => go("export", withKey(o.key, (k) => C.runExport(k, o.node, o.out, o.scale)))).pipe(
    Command.withDescription("Render one node, by id or name, to a PNG file"))
  const evalCmd = Command.make("eval", {
    key: keyArg, script: Argument.String("script.js|-"),
    timeout: Flag.String("timeout").pipe(Flag.withDefault("2m"), Flag.withDescription("how long the script may run, up to 5m")),
  }, (o) => {
    const timeout = parseGoDuration(o.timeout)
    const run = timeout === undefined
      ? Effect.fail(new BadInput({ detail: `-timeout ${value(o.timeout)} is not a duration such as 90s or 2m` }))
      : withKey(o.key, (k) => withInput(o.script, (t) => C.runEval(k, t, timeout)))
    return go("eval", run, true)
  }).pipe(Command.withDescription("Run a Plugin API script in a file's Design editor and print the JSON it returns"))
  const rename = Command.make("rename", { key: keyArg, name: Argument.String("name"), yes: yesFlag("rename") },
    (o) => go("rename", withKey(o.key, (k) => C.runRename(k, o.name, o.yes)))).pipe(Command.withDescription("Change the name of a file"))
  const doctor = Command.make("doctor", {}, () => go("doctor", C.runDoctor())).pipe(
    Command.withDescription("Check that the browser is signed in to Figma; list its Figma tabs, their CPU, and the file locks held"))

  return Command.make(BIN).pipe(
    Command.withDescription("Figma files through the signed-in session: per-file locks, one Ego Space per file, the Figma app first"),
    Command.withSubcommands([file, pages, read, write, tokens, arrange, label, swap, grid, check, exportCmd, evalCmd, rename, doctor]),
  )
}

/** The command list of the top help, in figmacli's order, with its summaries. */
export const SUMMARIES: ReadonlyArray<readonly [string, string]> = [
  ["file", "Name, kind (design, make, figjam, slides), edit right, and pages of a Design file"],
  ["pages", "Pages of a Design file with the top-level node count of each"],
  ["read", "Nodes of one page of a Design file: id, type, name, size, text"],
  ["write", "Draw a JSON spec into a Design file, then load it in a second tab to prove it was saved"],
  ["tokens", "Push design/tokens.json: colours and numbers to variables, type and shadows to styles"],
  ["arrange", "Rename and order pages, and move top-level nodes into sections"],
  ["label", "Lay out a component set and label each variant; instances stay linked"],
  ["swap", "Move the instances of one set's variants to another set, in both themes"],
  ["grid", "Lay a mockup section out as a grid: one frame per row, one column per variant, column names once"],
  ["check", "List detached instances, hand-set colours, stray vectors, unbound sizes and component names another page holds"],
  ["export", "Render one node, by id or name, to a PNG file"],
  ["eval", "Run a Plugin API script in a file's Design editor and print the JSON it returns"],
  ["rename", "Change the name of a file"],
  ["doctor", "Check that the browser is signed in to Figma, and list its Figma tabs, their CPU and the file locks held"],
]

/** The top help, in TOON, as figmacli printed it. */
export const topHelp = () =>
  `bin: ${BIN}\nversion: ${VERSION}\ndescription: Figma files: read details, pages and nodes, draw into a Design file, export a node to PNG\n` +
  `credential: the browser session signed in to Figma; no token. Set EGO_BROWSER="ssh <mac> ego-browser" to use another machine's browser\n\n` +
  `commands[${SUMMARIES.length}]{name,summary}:\n${SUMMARIES.map(([n, d]) => `  ${n},${value(d)}`).join("\n")}\n\n` +
  `help[1]:\n  - Run \`${BIN} <command> --help\` for one command's flags\n`
