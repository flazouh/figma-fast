// The commands of figmacli 0.1.0, with its output: TOON on stdout (or -json), the same fields and the same
// dry-run-without--yes rule. Each returns its stdout; a failure is a tagged error the CLI turns into an exit code.
import { Duration, Effect } from "effect"
import { readFileSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { FigmaClient } from "./client.ts"
import { FigmaConfig } from "./config.ts"
import { type AppError, BadInput, Findings, type FileKey, PageError, RunFailed } from "./domain.ts"
import { LockManager } from "./locks.ts"
import {
  Arrangement, arrangeJSON, checkGrid, checkLabel, checkWrite, countNodes, decodeSpec, GridSpec, gridJSON, LabelSpec, labelJSON,
  SwapSpec, swapJSON, WriteSpec, writeJSON,
} from "./specs.ts"
import { Doc, g, raw, text, value } from "./toon.ts"
import { compileTokens } from "./tokens.ts"

type Run = Effect.Effect<string, AppError, FigmaClient>

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`

/** Reads a file argument, or stdin for "-". */
export const readInput = (path: string, stdin: () => string = () => readFileSync(0, "utf8")): string | BadInput => {
  try {
    return path === "-" ? stdin() : readFileSync(path, "utf8")
  } catch (error) {
    return new BadInput({ detail: (error as Error).message })
  }
}

const orFail = <A>(value: A | BadInput): Effect.Effect<A, BadInput> => (value instanceof BadInput ? Effect.fail(value) : Effect.succeed(value))

const call = <A>(request: Parameters<FigmaClient["Service"]["call"]>[0], timeout?: Duration.Duration) =>
  Effect.gen(function* () {
    const client = yield* FigmaClient
    return (yield* client.call(request, timeout ? { timeout } : {})) as A
  })

/** A write the page did not confirm is an error, with what to run before a retry. */
const confirmSaved = (saved: boolean, check: string) =>
  saved ? Effect.void : Effect.fail(new PageError({ detail: `the page did not confirm the save: run figmacli ${check} before you retry` }))

interface Page { readonly id: string; readonly name: string; readonly nodes: number }

const pageTable = (doc: Doc, pages: ReadonlyArray<Page>) => doc.table("pages", ["id", "name", "nodes"], pages.map((p) => [p.id, p.name, String(p.nodes)]))

export const runFile = (key: FileKey, asJSON: boolean): Run =>
  Effect.gen(function* () {
    const file = yield* call<{ key: string; name: string; kind: string; can_edit: boolean; url: string; pages: Array<Page> | null }>({ op: "file", key })
    if (asJSON) return json(file)
    const doc = new Doc().object("file", text("key", file.key), text("name", file.name), text("kind", file.kind), raw("can_edit", file.can_edit), text("url", file.url))
    if (file.kind === "make") doc.list("help", ["A Make file has no document API. Use a Design file for `read` and `write`"])
    else pageTable(doc, file.pages ?? [])
    return doc.toString()
  })

export const runPages = (key: FileKey, asJSON: boolean): Run =>
  Effect.gen(function* () {
    const { pages } = yield* call<{ pages: Array<Page> | null }>({ op: "pages", key })
    if (asJSON) return json(pages)
    return pageTable(new Doc(), pages ?? []).toString()
  })

export const runRead = (key: FileKey, page: string, depth: number): Run =>
  Effect.gen(function* () {
    if (depth < 1) return yield* new BadInput({ detail: "-depth must be 1 or more" })
    const tree = yield* call<{ page: string; nodes: Array<{ id: string; type: string; name: string; depth: number; x: number; y: number; w: number; h: number; text: string }> | null }>({ op: "read", key, page, depth })
    const rows = (tree.nodes ?? []).map((n) => [String(n.depth), n.id, n.type, n.name, `${g(n.w)}x${g(n.h)}`, `${g(n.x)},${g(n.y)}`, n.text])
    return new Doc().object("", text("page", tree.page)).table("nodes", ["depth", "id", "type", "name", "size", "at", "text"], rows).toString()
  })

export const runWrite = (key: FileKey, specText: string, flags: { yes: boolean; replace: boolean; json: boolean }): Run =>
  Effect.gen(function* () {
    const spec = yield* orFail(decodeSpec(WriteSpec, specText))
    const bad = checkWrite(spec)
    if (bad) return yield* bad
    const body = writeJSON(spec)
    if (!flags.yes) {
      const plan = yield* call<{ remove: Array<{ id: string; type: string; name: string; instances: number; cut: number }> | null; tokens: Array<{ name: string; from: string; to: string }> | null }>({ op: "plan", key, spec: body, replace: flags.replace })
      if (flags.json) return json(plan)
      return new Doc()
        .object("", raw("drawn", false), text("page", spec.page ?? ""), raw("nodes", countNodes(spec.nodes ?? [])), text("help", "Add -yes to draw"))
        .table("would_remove", ["id", "type", "name", "instances", "cut"], (plan.remove ?? []).map((r) => [r.id, r.type, r.name, String(r.instances), String(r.cut)]))
        .table("would_change_tokens", ["name", "from", "to"], (plan.tokens ?? []).map((t) => [t.name, t.from, t.to]))
        .toString()
    }
    const written = yield* call<{ page: string; tokens: number; nodes: Array<{ id: string; type: string; name: string; w: number; h: number }> | null; kept: number; cut: number; saved: boolean }>({ op: "write", key, spec: body, replace: flags.replace }).pipe(
      Effect.catchIf(
        (e): e is Exclude<AppError, PageError> => e._tag !== "PageError",
        (e) => Effect.fail(new RunFailed({ transport: "", detail: `${e.message}. The write may have landed: run figmacli read before you retry` })),
      ),
    )
    yield* confirmSaved(written.saved, "read")
    if (flags.json) return json(written)
    return new Doc()
      .object("", text("page", written.page), raw("tokens", written.tokens), raw("kept", written.kept), raw("cut", written.cut), raw("saved", written.saved))
      .table("nodes", ["id", "type", "name", "size"], (written.nodes ?? []).map((n) => [n.id, n.type, n.name, `${g(n.w)}x${g(n.h)}`]))
      .toString()
  })

export const runTokens = (key: FileKey, fileText: string, yes: boolean): Run =>
  Effect.gen(function* () {
    const { push, skipped } = yield* orFail(compileTokens(fileText))
    const result = yield* call<{ created: number; changed: Array<{ name: string; from: string; to: string; bound: number; pages: string }> | null; styles: number; skipped: Array<string> | null; stale: Array<string> | null; saved: boolean }>({ op: "tokens", key, tokens: push, dry: !yes })
    if (yes) yield* confirmSaved(result.saved, "pages")
    return new Doc()
      .object("", raw("written", yes), raw("new_variables", result.created), raw("new_styles", result.styles))
      .table("changed", ["name", "from", "to", "bound", "pages"], (result.changed ?? []).map((t) => [t.name, t.from, t.to, String(t.bound), t.pages]))
      .list("skipped", [...skipped, ...(result.skipped ?? [])])
      .list("stale", result.stale ?? [])
      .toString()
  })

export const runSwap = (key: FileKey, specText: string, flags: { yes: boolean; json: boolean }): Run =>
  Effect.gen(function* () {
    const swap = yield* orFail(decodeSpec(SwapSpec, specText))
    if (!swap.from || !swap.to || Object.keys(swap.map ?? {}).length === 0) return yield* new BadInput({ detail: "the spec needs from, to and map" })
    const result = yield* call<{ moved: number; missing: Array<string> | null; saved: boolean }>({ op: "swap", key, swap: swapJSON(swap), dry: !flags.yes })
    if (flags.json) return json(result)
    return new Doc().object("", raw("moved", result.moved), raw("saved", result.saved)).list("missing", result.missing ?? []).toString()
  })

export const runArrange = (key: FileKey, specText: string, yes: boolean): Run =>
  Effect.gen(function* () {
    const arrangement = yield* orFail(decodeSpec(Arrangement, specText))
    if (!yes) {
      const order = arrangement.order ?? []
      return new Doc()
        .object("", raw("arranged", false), text("pages", order.length === 0 ? "kept as they are" : order.join(", ")),
          raw("sections", arrangement.sections?.length ?? 0), raw("moves", arrangement.moves?.length ?? 0), raw("names", arrangement.names?.length ?? 0),
          text("help", "Add -yes to arrange"))
        .toString()
    }
    const answer = yield* call<{ pages: Array<Page> | null; saved: boolean }>({ op: "arrange", key, arrange: arrangeJSON(arrangement) })
    yield* confirmSaved(answer.saved, "pages")
    return pageTable(new Doc(), answer.pages ?? []).toString()
  })

export const runLabel = (key: FileKey, specText: string, flags: { yes: boolean; json: boolean }): Run =>
  Effect.gen(function* () {
    const spec = yield* orFail(decodeSpec(LabelSpec, specText))
    const bad = checkLabel(spec)
    if (bad) return yield* bad
    if (!flags.yes) return `labelled: false\nset: ${value(spec.set ?? "")}\nhelp: Add -yes to label\n`
    const result = yield* call<{ set: string; variants: number; labels: number; w: number; h: number; saved: boolean }>({ op: "label", key, label: labelJSON(spec) })
    yield* confirmSaved(result.saved, "read")
    if (flags.json) return json(result)
    return new Doc().object("", text("set", result.set), raw("variants", result.variants), raw("labels", result.labels), text("size", `${g(result.w)}x${g(result.h)}`), raw("saved", result.saved)).toString()
  })

export const runGrid = (key: FileKey, specText: string, flags: { yes: boolean; json: boolean }): Run =>
  Effect.gen(function* () {
    const spec = yield* orFail(decodeSpec(GridSpec, specText))
    const bad = checkGrid(spec)
    if (bad) return yield* bad
    if (!flags.yes) return `gridded: false\nrows: ${spec.rows?.length ?? 0}\ncolumns: ${spec.columns?.length ?? 0}\nhelp: Add -yes to lay out\n`
    const result = yield* call<{ rows: number; columns: number; cells: number; w: number; h: number; saved: boolean }>({ op: "grid", key, grid: gridJSON(spec) })
    yield* confirmSaved(result.saved, "read")
    if (flags.json) return json(result)
    return new Doc().object("", raw("rows", result.rows), raw("columns", result.columns), raw("cells", result.cells), text("size", `${g(result.w)}x${g(result.h)}`), raw("saved", result.saved)).toString()
  })

export const runCheck = (key: FileKey, page: string, shapes: string, asJSON: boolean): Run =>
  Effect.gen(function* () {
    const result = yield* call<{ page: string; instances: number; new: number; findings: Array<{ kind: string; id: string; name: string; path: string }> | null }>({ op: "check", key, page, shapes: shapes.split(",").map((s) => s.trim()) })
    const findings = result.findings ?? []
    const report = asJSON
      ? json(result)
      : new Doc().object("", text("page", result.page), raw("instances", result.instances), raw("new_shapes", result.new))
          .table("findings", ["kind", "id", "path"], findings.map((f) => [f.kind, f.id, f.path])).toString()
    if (findings.length > 0) return yield* new Findings({ count: findings.length, report })
    return report
  })

export const runExport = (key: FileKey, node: string, out: string, scale: number): Run =>
  Effect.gen(function* () {
    if (node === "" || out === "") return yield* new BadInput({ detail: "`export` needs -node and -out" })
    if (scale < 0.5 || scale > 4) return yield* new BadInput({ detail: "-scale must be from 0.5 to 4" })
    const exported = yield* call<{ name: string; w: number; h: number; png: string }>({ op: "export", key, node, scale })
    const png = Buffer.from(exported.png, "base64")
    try {
      writeFileSync(out, png, { mode: 0o644 })
    } catch (error) {
      return yield* new RunFailed({ transport: "", detail: (error as Error).message })
    }
    return new Doc().object("", text("name", exported.name), text("size", `${g(exported.w)}x${g(exported.h)}`), raw("scale", scale), raw("bytes", png.length), text("file", out)).toString()
  })

export const MAX_EVAL = Duration.minutes(5)
/** The time an eval run gets, on top of the script's own, to start the browser and open the file. */
export const OPEN_GRACE = Duration.minutes(1)

export const runEval = (key: FileKey, script: string, timeout: Duration.Duration): Run =>
  Effect.gen(function* () {
    if (Duration.toMillis(timeout) <= 0 || Duration.isGreaterThan(timeout, MAX_EVAL)) return yield* new BadInput({ detail: "-timeout must be above 0 and at most 5m0s" })
    if (script.trim() === "") return yield* new BadInput({ detail: "the script is empty" })
    const answer = yield* call<{ result?: unknown }>({ op: "eval", key, script, evalMs: Duration.toMillis(timeout) }, Duration.sum(timeout, OPEN_GRACE))
    return json(answer.result === undefined ? null : answer.result)
  })

export const runRename = (key: FileKey, name: string, yes: boolean): Run =>
  Effect.gen(function* () {
    if (name.trim() === "") return yield* new BadInput({ detail: "the new name is empty" })
    if (!yes) return `renamed: false\nhelp: Add -yes to rename to ${value(name)}\n`
    const answer = yield* call<{ name: string }>({ op: "rename", key, name })
    if (answer.name !== name) return yield* new PageError({ detail: `Figma holds the name ${JSON.stringify(answer.name)} after the rename, not ${JSON.stringify(name)}` })
    return `name: ${value(answer.name)}\n`
  })

/** ps for every process: doctor keeps the renderers of Ego Lite and the Figma app, busiest first. */
export const parseRenderers = (ps: string): Array<[string, string, string]> => {
  const rows: Array<[string, string, string]> = []
  for (const line of ps.split("\n")) {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 3) continue
    const command = fields.slice(2).join(" ")
    let app = command.toLowerCase().includes("ego lite.app") ? "Ego Lite" : command.includes("Figma.app") ? "Figma" : ""
    if (!app) continue
    if (command.includes("--type=renderer")) app += " renderer"
    else if (command.includes("--type=gpu-process")) app += " GPU"
    else continue
    rows.push([fields[0] ?? "", fields[1] ?? "", app])
  }
  return rows.sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, 8)
}

const renderers = (): string => {
  try {
    return execFileSync("ps", ["-axo", "pid=,%cpu=,command="], { encoding: "utf8" })
  } catch {
    return ""
  }
}

export const runDoctor = (processes: () => string = renderers): Effect.Effect<string, AppError, FigmaClient | LockManager | FigmaConfig> =>
  Effect.gen(function* () {
    const client = yield* FigmaClient
    const locks = yield* LockManager
    const config = yield* FigmaConfig
    const answer = (yield* client.call({ op: "doctor" })) as { signed_in: boolean; tabs: Array<{ title: string; url: string }> | null }
    if (!answer.signed_in) return yield* new PageError({ detail: "the browser is not signed in to Figma. Open figma.com in the browser, sign in, then retry" })
    const tabs = answer.tabs ?? []
    const held: Array<Array<string>> = []
    for (const key of yield* locks.keys) {
      for (const t of yield* locks.tickets(key)) held.push([key, String(t.pid), t.access, t.state, t.op])
    }
    const doc = new Doc()
      .object("", raw("signed_in", true), text("transport", client.transport), text("space", "figmacli-<file key>, one per file"), raw("max_tabs", config.maxTabs))
      .table("figma_tabs", ["title", "url"], tabs.map((t) => [t.title, t.url]))
      .table("renderers", ["pid", "cpu", "app"], parseRenderers(processes()))
      .table("locks", ["file", "pid", "access", "state", "op"], held)
    let out = doc.toString()
    if (tabs.length > 1 && client.transport === "desktop") out += `warning: ${tabs.length} files are open in the Figma app; each one costs CPU. Close the files you do not need\n`
    else if (config.maxTabs > 0 && tabs.length > config.maxTabs) out += `warning: ${tabs.length} Figma tabs are open, above FIGMACLI_MAX_TABS=${config.maxTabs}; each one costs CPU. The reaper closes idle ones\n`
    return out
  })
