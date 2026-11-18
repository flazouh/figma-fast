import { execFileSync } from "node:child_process"
import { mkdirSync } from "node:fs"
import { join } from "node:path"

export const root = join(import.meta.dirname, "..")
export const testBin = join(root, "dist", "test")
export const holderBin = join(testBin, "figma-fast-holder")
export const fakeAppBin = join(testBin, "fake-figma-app")

/** Builds the Go holder and the fake Figma app the holder tests launch, once per test run. */
export const setup = () => {
  mkdirSync(testBin, { recursive: true })
  const holder = join(root, "holder")
  execFileSync("go", ["build", "-o", holderBin, "./cmd/figma-fast-holder"], { cwd: holder, stdio: "inherit" })
  execFileSync("go", ["build", "-o", fakeAppBin, "./internal/fakeapp"], { cwd: holder, stdio: "inherit" })
}

export default setup
