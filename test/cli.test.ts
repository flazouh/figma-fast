// The binary end to end, through effect/cli, against a fake ego-browser: output formats, exit codes, -yes safety,
// single-dash flags, and two processes on two files running at once.
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { spawn } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const root = join(import.meta.dirname, "..")

interface Run { readonly stdout: string; readonly stderr: string; readonly code: number | null }

const cli = (args: ReadonlyArray<string>, env: Record<string, string>, stdin = "") =>
  Effect.callback<Run>((resume) => {
    const child = spawn(process.execPath, [join(root, "src", "main.ts"), ...args], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8").on("data", (c: string) => (stdout += c))
    child.stderr.setEncoding("utf8").on("data", (c: string) => (stderr += c))
    child.on("close", (code) => resume(Effect.succeed({ stdout, stderr, code })))
    child.stdin.end(stdin)
  })

const setup = (extra: Record<string, string> = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "figma-fast-cli-"))
  const env = {
    FIGMACLI_TRANSPORT: "ego",
    EGO_BROWSER: join(root, "test", "fixtures", "fake-ego-browser.ts"),
    FIGMACLI_QUEUE_DIR: join(dir, "queue"),
    FIGMACLI_REAPER: "off",
    FAKE_EGO_DIR: dir,
    ...extra,
  }
  const log = () => readFileSync(join(dir, "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { op: string; space: string; dry?: boolean; exclusive?: boolean })
  return { dir, env, log }
}

const KEY = "AAAAAAAAAAAA"

describe("the command line", () => {
  it.live("pages prints TOON, with a link or a key", () =>
    Effect.gen(function* () {
      const { env, log } = setup()
      const run = yield* cli(["pages", `https://www.figma.com/design/${KEY}/Ace?node-id=1`], env)
      assert.strictEqual(run.code, 0)
      assert.strictEqual(run.stdout, 'pages[2]{id,name,nodes}:\n  "0:1",Cover,"2"\n  "0:2","Mockups, v2","14"\n')
      assert.strictEqual(log()[0]?.space, `figmacli-${KEY}`)
    }))

  it.live("write without -yes only plans, and takes the single-dash flags of figmacli", () =>
    Effect.gen(function* () {
      const { dir, env, log } = setup()
      const spec = join(dir, "card.json")
      writeFileSync(spec, JSON.stringify({ page: "Mockups", nodes: [{ type: "frame", name: "Card", w: 100, h: 50, fill: "#fff" }] }))
      const run = yield* cli(["write", KEY, spec, "-replace"], env)
      assert.strictEqual(run.code, 0, run.stderr)
      assert.match(run.stdout, /^drawn: false\npage: Mockups\nnodes: 1\nhelp: Add -yes to draw\n\nwould_remove\[1\]/)
      assert.deepStrictEqual(log().map((l) => l.op), ["plan"])
    }))

  it.live("a spec with an unknown field is a usage error, exit 2, and nothing runs", () =>
    Effect.gen(function* () {
      const { dir, env } = setup()
      const spec = join(dir, "bad.json")
      writeFileSync(spec, JSON.stringify({ page: "Mockups", nodes: [{ type: "frame", name: "Card", colour: "#fff" }] }))
      const run = yield* cli(["write", KEY, spec, "-yes"], env)
      assert.strictEqual(run.code, 2)
      assert.match(run.stdout, /^error: the spec is not valid: .*colour/)
    }))

  it.live("check prints its findings and exits 1", () =>
    Effect.gen(function* () {
      const { env } = setup()
      const run = yield* cli(["check", KEY, "-page", "Mockups"], env)
      assert.strictEqual(run.code, 1)
      assert.match(run.stdout, /findings\[1\]\{kind,id,path\}:\n {2}detached,"1:2",Mockups\/Pill\n/)
    }))

  it.live("eval prints only the script's JSON, reading the script from stdin", () =>
    Effect.gen(function* () {
      const { env } = setup()
      const run = yield* cli(["eval", KEY, "-", "-timeout", "30s"], env, "return figma.root.name")
      assert.strictEqual(run.code, 0, run.stderr)
      assert.deepStrictEqual(JSON.parse(run.stdout), { name: "Ace new design system", pages: 15 })
    }))

  it.live("tokens without -yes is a dry run that locks as a read", () =>
    Effect.gen(function* () {
      const { dir, env, log } = setup()
      const file = join(dir, "tokens.json")
      writeFileSync(file, JSON.stringify({ color: { tokens: [{ name: "ink", value: { dark: "#E2E2E2", light: "#111111" } }] }, radius: { tokens: [{ name: "share", value: "25%" }] } }))
      const run = yield* cli(["tokens", KEY, file], env)
      assert.strictEqual(run.code, 0, run.stderr)
      assert.match(run.stdout, /^written: false\nnew_variables: 3\nnew_styles: 1\n/)
      assert.match(run.stdout, /skipped\[2\]:\n {2}- "radius\/share: 25% is not a size in px"/)
      assert.strictEqual(log()[0]?.dry, true)
    }))

  it.live("two processes on two files run at the same time", () =>
    Effect.gen(function* () {
      const { env, log } = setup({ FAKE_EGO_BARRIER: "2", FIGMACLI_MAX_TABS: "2" })
      const [a, b] = yield* Effect.all([cli(["read", "AAAAAAAAAAAA"], env), cli(["read", "BBBBBBBBBBBB"], env)], { concurrency: 2 })
      assert.strictEqual(a?.code, 0, a?.stdout)
      assert.strictEqual(b?.code, 0, b?.stdout)
      assert.match(a?.stdout ?? "", /nodes\[1\]\{depth,id,type,name,size,at,text\}:\n {2}"1",.*180x36,"0,12.5"/)
      assert.deepStrictEqual(new Set(log().map((l) => l.space)), new Set(["figmacli-AAAAAAAAAAAA", "figmacli-BBBBBBBBBBBB"]))
    }))

  it.live("with FIGMACLI_MAX_TABS=1 the same two runs wait for each other", () =>
    Effect.gen(function* () {
      const { env } = setup({ FAKE_EGO_BARRIER: "2", FIGMACLI_MAX_TABS: "1" })
      const runs = yield* Effect.all([cli(["read", "AAAAAAAAAAAA"], env), cli(["read", "BBBBBBBBBBBB"], env)], { concurrency: 2 })
      // The barrier needs both at once, so the first run through it gives up and says why.
      assert.isTrue(runs.some((r) => r.code === 1 && r.stdout.includes("barrier")))
    }))

  it.live("a wrong file key is a usage error", () =>
    Effect.gen(function* () {
      const { env } = setup()
      const run = yield* cli(["read", "nope"], env)
      assert.strictEqual(run.code, 2)
    }))
})
