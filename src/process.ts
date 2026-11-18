// One child process with stdin in and both streams out, under a time limit. Interrupting the fiber kills it.
import { Duration, Effect } from "effect"
import { spawn } from "node:child_process"

export interface ProcessResult {
  readonly stdout: string
  readonly stderr: string
  readonly code: number | null
  /** The program does not exist. */
  readonly missing: boolean
  readonly timedOut: boolean
}

export const runProcess = (command: ReadonlyArray<string>, stdin: string, timeout: Duration.Duration): Effect.Effect<ProcessResult> =>
  Effect.callback<ProcessResult>((resume) => {
    const [program, ...args] = command
    const child = spawn(program ?? "", args, { stdio: ["pipe", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    let timedOut = false
    let missing = false
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk))
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk))
    child.stdin.on("error", () => {})
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") missing = true
      else stderr += error.message
    })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, Duration.toMillis(timeout))
    child.on("close", (code) => {
      clearTimeout(timer)
      resume(Effect.succeed({ stdout, stderr, code, missing, timedOut }))
    })
    child.stdin.end(stdin)
    return Effect.sync(() => {
      clearTimeout(timer)
      child.kill("SIGKILL")
    })
  })

/** Finds the line that starts with marker in the script output. */
export const extractMarked = (output: string, marker: string): string | undefined => {
  for (const line of output.split("\n")) {
    const trimmed = line.trim()
    if (trimmed.startsWith(marker)) return trimmed.slice(marker.length)
  }
  return undefined
}

export const compact = (text: string, max = 400): string => {
  const flat = text.split(/\s+/).filter(Boolean).join(" ")
  return flat.length > max ? `${flat.slice(0, max)}...` : flat
}
