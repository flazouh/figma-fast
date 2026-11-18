// Every setting, read once from the environment through Effect Config. Tests build the service by hand.
import { Config, Context, Duration, Effect, Layer } from "effect"
import { homedir, platform, tmpdir } from "node:os"
import { join } from "node:path"

export type TransportChoice = "auto" | "desktop" | "ego"

export interface Settings {
  /** FIGMACLI_TRANSPORT: auto tries the desktop holder first, then ego-browser. */
  readonly transport: TransportChoice
  /** FIGMACLI_DESKTOP_SOCKET: the CDP holder's unix socket. */
  readonly desktopSocket: string
  /** FIGMACLI_QUEUE_DIR: locks, tickets, tab slots and last-used stamps. */
  readonly queueDir: string
  /** FIGMACLI_LOCK_WAIT: how long a run waits for its file lock, and then for a tab slot. */
  readonly lockWait: Duration.Duration
  /** FIGMACLI_LOCK_POLL (new): how often a waiting run looks again. */
  readonly lockPoll: Duration.Duration
  /** FIGMACLI_MAX_TABS (new): Figma tabs that may run at once across every process; 0 means no cap. */
  readonly maxTabs: number
  /** FIGMACLI_IDLE_CLOSE (new): how long a file's Space stays open with no run before the reaper closes it. */
  readonly idleClose: Duration.Duration
  /** FIGMACLI_RUN_TIMEOUT (new): the limit on one transport run, the six-minute push limit of 0.1.0. */
  readonly runTimeout: Duration.Duration
  /** EGO_BROWSER (kept): the ego-browser command, which may carry arguments such as "ssh mac ego-browser". */
  readonly egoBrowser: ReadonlyArray<string>
  /** FIGMACLI_EGO_SERVER_NAME (new): passed as --ego-server-name= to reach a named Ego Lite server. */
  readonly egoServerName: string
  /** FIGMACLI_NODE (new): the node binary the desktop transport runs the page script in. */
  readonly node: string
  /** FIGMACLI_REAPER (new): "off" starts no idle reaper after a run, for CI and tests. */
  readonly reaper: boolean
}

export class FigmaConfig extends Context.Service<FigmaConfig, Settings>()("figma-fast/FigmaConfig") {}

const units: Record<string, number> = { ns: 1e-6, us: 1e-3, "µs": 1e-3, ms: 1, s: 1000, m: 60_000, h: 3_600_000 }

/** Parses a Go duration ("90s", "20m", "1h30m", "250ms"), as figmacli 0.1.0 read FIGMACLI_LOCK_WAIT. */
export const parseGoDuration = (value: string): Duration.Duration | undefined => {
  const text = value.trim()
  if (text === "0") return Duration.zero
  if (!/^([0-9]*\.?[0-9]+(ns|us|µs|ms|s|m|h))+$/.test(text)) return undefined
  let total = 0
  for (const [, amount, unit] of text.matchAll(/([0-9]*\.?[0-9]+)(ns|us|µs|ms|s|m|h)/g)) {
    total += Number(amount) * (units[unit ?? "ms"] ?? 0)
  }
  return Duration.millis(total)
}

/** The user's cache folder, as Go's os.UserCacheDir picks it. */
export const userCacheDir = (): string => {
  if (process.env.XDG_CACHE_HOME && platform() !== "darwin") return process.env.XDG_CACHE_HOME
  if (platform() === "darwin") return join(homedir(), "Library", "Caches")
  return homedir() ? join(homedir(), ".cache") : tmpdir()
}

const goDuration = (name: string, fallback: string) =>
  Config.String(name).pipe(
    Config.withDefault(fallback),
    Config.map((raw) => parseGoDuration(raw) ?? parseGoDuration(fallback) ?? Duration.zero),
  )

export const settingsConfig: Config.Config<Settings> = Config.all({
  transport: Config.Literals(["auto", "desktop", "ego"], "FIGMACLI_TRANSPORT").pipe(Config.withDefault("auto" as const)),
  desktopSocket: Config.String("FIGMACLI_DESKTOP_SOCKET").pipe(
    Config.withDefault(join(homedir(), ".cache", "figma-cdp", "cdp.sock")),
  ),
  queueDir: Config.String("FIGMACLI_QUEUE_DIR").pipe(Config.withDefault(join(userCacheDir(), "figmacli"))),
  lockWait: goDuration("FIGMACLI_LOCK_WAIT", "20m"),
  lockPoll: goDuration("FIGMACLI_LOCK_POLL", "250ms"),
  maxTabs: Config.Int("FIGMACLI_MAX_TABS").pipe(Config.withDefault(3)),
  idleClose: goDuration("FIGMACLI_IDLE_CLOSE", "10m"),
  runTimeout: goDuration("FIGMACLI_RUN_TIMEOUT", "6m"),
  egoBrowser: Config.String("EGO_BROWSER").pipe(
    Config.withDefault("ego-browser"),
    Config.map((raw) => (raw.trim() === "" ? ["ego-browser"] : raw.trim().split(/\s+/))),
  ),
  egoServerName: Config.String("FIGMACLI_EGO_SERVER_NAME").pipe(Config.withDefault("")),
  node: Config.String("FIGMACLI_NODE").pipe(Config.withDefault("node")),
  reaper: Config.String("FIGMACLI_REAPER").pipe(Config.withDefault("on"), Config.map((raw) => raw.trim().toLowerCase() !== "off")),
})

/** The settings from the environment. */
export const FigmaConfigLive = Layer.effect(FigmaConfig, Effect.gen(function* () {
  return yield* settingsConfig
}))

/** Settings for tests and embedders: the defaults with some fields replaced. */
export const testSettings = (overrides: Partial<Settings> & Pick<Settings, "queueDir">): Settings => ({
  transport: "auto",
  desktopSocket: join(overrides.queueDir, "cdp.sock"),
  lockWait: Duration.seconds(5),
  lockPoll: Duration.millis(10),
  maxTabs: 0,
  idleClose: Duration.minutes(10),
  runTimeout: Duration.seconds(10),
  egoBrowser: ["ego-browser"],
  egoServerName: "",
  node: "node",
  reaper: false,
  ...overrides,
})
