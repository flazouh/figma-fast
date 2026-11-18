import { assert, describe, it } from "@effect/vitest"
import { Duration, Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { normalizeArgs } from "../src/cli.ts"
import { FigmaConfig, parseGoDuration } from "../src/config.ts"
import { BadInput, parseKey } from "../src/domain.ts"
import { LockManager } from "../src/locks.ts"
import { idleKeys } from "../src/reaper.ts"
import { SpacePool } from "../src/spaces.ts"
import { checkGrid, checkWrite, decodeSpec, nodeJSON, WriteSpec } from "../src/specs.ts"
import { compileTokens } from "../src/tokens.ts"
import { Doc, g, value } from "../src/toon.ts"
import { tempQueue, testSettings } from "./helpers.ts"

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", name), "utf8")

describe("ported pieces", () => {
  it("compiles tokens.json exactly as the Go compiler does", () => {
    const compiled = compileTokens(fixture("tokens.json"))
    assert.notInstanceOf(compiled, BadInput)
    const expected = JSON.parse(fixture("tokens.expected.json")) as unknown
    assert.deepStrictEqual(JSON.parse(JSON.stringify(compiled)), expected)
  })

  it("refuses a tokens file with no colours", () => {
    assert.instanceOf(compileTokens("{}"), BadInput)
  })

  it("quotes TOON values as the spec says", () => {
    assert.strictEqual(value("Cover"), "Cover")
    assert.strictEqual(value("0:1"), '"0:1"')
    assert.strictEqual(value("14"), '"14"')
    assert.strictEqual(value("-x"), '"-x"')
    assert.strictEqual(value(""), '""')
    assert.strictEqual(value("a\nb"), '"a\\nb"')
    assert.strictEqual(new Doc().object("", { key: "n", value: "3", raw: true }).list("l", ["a, b"]).toString(), 'n: 3\n\nl[1]:\n  - "a, b"\n')
  })

  it("prints sizes as Go's %g", () => {
    assert.deepStrictEqual([g(375), g(12.5), g(0), g(1000), g(1e6), g(1234567), g(0.0001), g(0.00001)], ["375", "12.5", "0", "1000", "1e+06", "1.234567e+06", "0.0001", "1e-05"])
  })

  it("reads Go durations as FIGMACLI_LOCK_WAIT did", () => {
    assert.strictEqual(Duration.toMillis(parseGoDuration("20m") ?? Duration.zero), 1_200_000)
    assert.strictEqual(Duration.toMillis(parseGoDuration("1h30m") ?? Duration.zero), 5_400_000)
    assert.strictEqual(Duration.toMillis(parseGoDuration("250ms") ?? Duration.zero), 250)
    assert.isUndefined(parseGoDuration("20 minutes"))
  })

  it("turns figmacli's single-dash flags into effect/cli's", () => {
    assert.deepStrictEqual(normalizeArgs(["write", "k", "-", "-yes", "-page=Mockups", "-h", "--json", "--", "-raw"]), ["write", "k", "-", "--yes", "--page=Mockups", "-h", "--json", "--", "-raw"])
  })

  it("parses links and keys", () => {
    assert.strictEqual(String(parseKey("https://www.figma.com/design/AbCdEf123456/Name?node-id=1")), "AbCdEf123456")
    assert.strictEqual(String(parseKey("https://www.figma.com/board/AbCdEf123456")), "AbCdEf123456")
    assert.instanceOf(parseKey("short"), BadInput)
  })

  it("checks write specs as figmacli did", () => {
    const parse = (spec: unknown) => {
      const decoded = decodeSpec(WriteSpec, JSON.stringify(spec))
      return decoded instanceof BadInput ? decoded : checkWrite(decoded)
    }
    assert.isUndefined(parse({ page: "P", tokens: { collection: "C", colors: { ink: "#000" } }, nodes: [{ type: "frame", name: "F", fill: "$ink", children: [{ type: "text", text: "hi", size: 12 }] }] }))
    assert.match(parse({ page: "P", nodes: [{ type: "frame", name: "F", fill: "$ink" }] })?.message ?? "", /token \$ink, which it does not define/)
    assert.match(parse({ page: "P", nodes: [{ type: "text", name: "T", text: "x", size: 1, radius: 4 }] })?.message ?? "", /takes no layout/)
    assert.match(parse({ page: "P", nodes: [{ type: "frame" }] })?.message ?? "", /every top-level node needs a name/)
    assert.match(parse({ page: "P", nodes: [{ type: "variants", name: "V", layout: "row", props: [{ name: "Label", type: "TEXT", default: 3 }], children: [{ type: "component", name: "c" }] }] })?.message ?? "", /needs a TEXT, BOOLEAN or INSTANCE_SWAP type/)
    assert.match(parse({ page: "P", nodes: [], extra: 1 })?.message ?? "", /not valid/)
  })

  it("sends a node as Go's encoder did: empty fields left out, a zero opacity kept", () => {
    assert.deepStrictEqual(nodeJSON({ type: "frame", name: "F", x: 0, clip: false, opacity: 0, children: [] }), { type: "frame", name: "F", opacity: 0 })
  })

  it("checks grid specs", () => {
    assert.match(checkGrid({ page: "P", section: "S", collection: "C", columns: ["a"], rows: [{ name: "r", cells: [""] }] })?.message ?? "", /row "r" has no cell/)
  })

  it.effect("the reaper closes only Spaces idle past FIGMACLI_IDLE_CLOSE with no run waiting", () =>
    Effect.gen(function* () {
      const used = new Map<string, number>([["IDLE", 0], ["BUSY", 0], ["FRESH", 30_000], ["CLOSED", -1]])
      const layer = Layer.mergeAll(
        Layer.succeed(FigmaConfig, testSettings({ queueDir: tempQueue(), idleClose: Duration.minutes(10) })),
        Layer.succeed(LockManager, LockManager.of({
          acquire: () => Effect.void,
          keys: Effect.succeed([...used.keys()]),
          tickets: (key) => Effect.succeed(key === "BUSY" ? [{ pid: 1, op: "read", access: "read", state: "holding", dir: "/", since: 0 }] : []),
        })),
        Layer.succeed(SpacePool, SpacePool.of({
          takeTab: () => Effect.void,
          touch: () => Effect.void,
          forget: () => Effect.void,
          lastUsed: (key) => Effect.succeed(used.get(key) === -1 ? undefined : used.get(key)),
        })),
      )
      yield* TestClock.setTime(10 * 60_000)
      const result = yield* idleKeys.pipe(Effect.provide(layer))
      assert.deepStrictEqual(result, { idle: ["IDLE"], open: 3 })
      yield* TestClock.adjust(Duration.minutes(1))
      const later = yield* idleKeys.pipe(Effect.provide(layer))
      assert.deepStrictEqual(later.idle, ["IDLE", "FRESH"])
    }))
})
