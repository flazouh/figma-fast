// flock(2) through bun:ffi. The kernel drops the lock when the holding process dies, however it dies, which is the
// crash safety the lock design rests on. Node has no flock binding, so figma-fast runs on Bun.
import { dlopen, FFIType } from "bun:ffi"
import { closeSync, openSync } from "node:fs"

const LOCK_SH = 1
const LOCK_EX = 2
const LOCK_NB = 4
const LOCK_UN = 8

const libc = dlopen(process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6", {
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
})

/** One open lock file. Each acquisition opens its own, as flock locks belong to an open file description. */
export interface LockFile {
  readonly fd: number
  readonly path: string
}

export const openLockFile = (path: string): LockFile => ({ fd: openSync(path, "a+", 0o600), path })

/** Takes the lock without waiting: true when this file now holds it. */
export const tryLock = (file: LockFile, mode: "shared" | "exclusive"): boolean =>
  libc.symbols.flock(file.fd, (mode === "shared" ? LOCK_SH : LOCK_EX) | LOCK_NB) === 0

/** Lets the lock go and closes the file. Closing alone would release it too. */
export const unlockAndClose = (file: LockFile): void => {
  libc.symbols.flock(file.fd, LOCK_UN)
  closeSync(file.fd)
}
