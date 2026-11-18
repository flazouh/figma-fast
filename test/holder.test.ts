// The multi-client holder: many clients on one socket, each reply back to the client that asked, with its own id.
import { assert, describe, it } from "@effect/vitest"
import { Duration, Effect, Queue } from "effect"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { createConnection, type Socket } from "node:net"
import { join } from "node:path"
import { tempQueue } from "./helpers.ts"

const root = join(import.meta.dirname, "..")

/** Starts holder.py on a fake app and resolves once it listens. */
const startHolder = (socket: string) =>
  Effect.acquireRelease(
    Effect.callback<ReturnType<typeof spawn>>((resume) => {
      const child = spawn("python3", [join(root, "holder", "holder.py")], {
        env: { ...process.env, FIGMA_HOLDER_APP: join(root, "test", "fixtures", "fake_figma_app.py"), FIGMACLI_DESKTOP_SOCKET: socket },
        stdio: ["ignore", "pipe", "inherit"],
      })
      child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
        if (chunk.includes("listening")) resume(Effect.succeed(child))
      })
      child.once("exit", (code) => resume(Effect.die(new Error(`holder.py ended with ${code} before it listened`))))
    }),
    (child) => Effect.sync(() => child.kill("SIGKILL")),
  )

interface Client {
  readonly send: (message: object) => Effect.Effect<void>
  readonly messages: Queue.Queue<Record<string, unknown>>
  readonly conn: Socket
}

const connect = (socket: string) =>
  Effect.gen(function* () {
    const messages = yield* Queue.unbounded<Record<string, unknown>>()
    const conn = yield* Effect.acquireRelease(
      Effect.callback<Socket>((resume) => {
        const c = createConnection(socket, () => resume(Effect.succeed(c)))
      }),
      (c) => Effect.sync(() => c.destroy()),
    )
    let buffer = ""
    conn.setEncoding("utf8").on("data", (chunk: string) => {
      buffer += chunk
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines.filter(Boolean)) Queue.offerUnsafe(messages, JSON.parse(line) as Record<string, unknown>)
    })
    const send = (message: object) => Effect.sync(() => void conn.write(`${JSON.stringify(message)}\n`))
    return { send, messages, conn } satisfies Client
  })

describe("multi-client CDP holder", () => {
  it.live("routes each reply to the client that asked, with that client's id, and session events to the session's owner", () =>
    Effect.gen(function* () {
      const socket = join(tempQueue(), "cdp.sock")
      yield* startHolder(socket)
      assert.isTrue(existsSync(socket))
      const a = yield* connect(socket)
      const b = yield* connect(socket)

      // Both clients use id 7 at once: each gets its own answer back.
      yield* a.send({ id: 7, method: "A.one", params: {} })
      yield* b.send({ id: 7, method: "B.one", params: {} })
      const ra = yield* Queue.take(a.messages)
      const rb = yield* Queue.take(b.messages)
      assert.deepStrictEqual([ra.id, (ra.result as { echo: string }).echo], [7, "A.one"])
      assert.deepStrictEqual([rb.id, (rb.result as { echo: string }).echo], [7, "B.one"])

      // A session belongs to the client that attached; its events go to that client only.
      yield* a.send({ id: 8, method: "Target.attachToTarget", params: { targetId: "T1", flatten: true } })
      const attached = yield* Queue.take(a.messages)
      const session = (attached.result as { sessionId: string }).sessionId
      const event = yield* Queue.take(a.messages)
      assert.strictEqual(event.sessionId, session)

      // An event with no session goes to every client.
      yield* b.send({ id: 9, method: "Browser.ping", params: {} })
      const pingReply = yield* Queue.take(b.messages)
      assert.strictEqual(pingReply.id, 9)
      const toB = yield* Queue.take(b.messages)
      const toA = yield* Queue.take(a.messages)
      assert.strictEqual(toB.method, "Target.targetCreated")
      assert.strictEqual(toA.method, "Target.targetCreated")
      // b never saw a's session event: its queue held only its own reply and the broadcast.
      assert.strictEqual(yield* Queue.size(b.messages), 0)
    }).pipe(Effect.timeout(Duration.seconds(10))))

  it.live("a new client does not take over: the first keeps getting its replies", () =>
    Effect.gen(function* () {
      const socket = join(tempQueue(), "cdp.sock")
      yield* startHolder(socket)
      const a = yield* connect(socket)
      yield* connect(socket)
      yield* a.send({ id: 1, method: "Browser.getVersion", params: {} })
      const reply = yield* Queue.take(a.messages)
      assert.strictEqual(reply.id, 1)
    }).pipe(Effect.timeout(Duration.seconds(10))))
})
