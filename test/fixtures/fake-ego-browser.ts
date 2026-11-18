#!/usr/bin/env bun
import { appendFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const dir = process.env.FAKE_EGO_DIR ?? "/tmp"
const source = await Bun.stdin.text()
const first = source.split("\n")[0] ?? ""
const input = JSON.parse(first.replace(/^const INPUT = /, "").replace(/;$/, "")) as { op: string; space: string; key?: string }
appendFileSync(join(dir, "log.jsonl"), `${JSON.stringify({ ...input, args: process.argv.slice(2), pid: process.pid })}\n`)
const emit = (value: unknown) => console.log(`FIGMACLI_JSON:${JSON.stringify(value)}`)

const answers: Record<string, unknown> = {
  pages: { pages: [{ id: "0:1", name: "Cover", nodes: 2 }, { id: "0:2", name: "Mockups, v2", nodes: 14 }] },
  plan: { remove: [{ id: "1:1", type: "FRAME", name: "Card", instances: 2, cut: 0 }], tokens: [] },
  check: { page: "Mockups", instances: 3, new: 0, findings: [{ kind: "detached", id: "1:2", name: "Pill", path: "Mockups/Pill" }] },
  eval: { result: { name: "Ace new design system", pages: 15 } },
  doctor: { signed_in: true, tabs: [{ title: "Ace", url: "https://www.figma.com/design/AAAAAAAAAAAA/Ace" }] },
  tokens: { created: 3, changed: [{ name: "ink", from: "#F0F0F0", to: "#E2E2E2", bound: 1111, pages: "Mockups" }], styles: 1, skipped: ["radius/share: 25% is not a size in px"], stale: [], saved: false },
  close: { closed: 1 },
}

if (input.op === "read") {
  const want = Number(process.env.FAKE_EGO_BARRIER ?? "1")
  writeFileSync(join(dir, `started-${input.space}-${process.pid}`), "")
  const stop = Date.now() + Number(process.env.FAKE_EGO_BARRIER_MS ?? "5000")
  while (readdirSync(dir).filter((n) => n.startsWith("started-")).length < want) {
    if (Date.now() > stop) {
      emit({ error: "barrier: the other run never started beside this one" })
      process.exit(0)
    }
    await Bun.sleep(20)
  }
  emit({ page: "Mockups", nodes: [{ id: "1:2", type: "FRAME", name: "Pill", depth: 1, x: 0, y: 12.5, w: 180, h: 36, text: "" }] })
} else emit(answers[input.op] ?? { error: `the fake has no answer for ${input.op}` })
