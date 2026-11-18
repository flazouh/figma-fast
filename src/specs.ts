import { Schema } from "effect"
import { BadInput } from "./domain.ts"
import { hexColor } from "./tokens.ts"

const Str = Schema.optionalKey(Schema.String)
const Num = Schema.optionalKey(Schema.Number)
const Bool = Schema.optionalKey(Schema.Boolean)
const StrMap = Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.String)))
const NumOrNull = Schema.optionalKey(Schema.NullOr(Schema.Number))

export interface Override {
  readonly component?: string
  readonly variant?: { readonly [k: string]: string } | null
  readonly set?: { readonly [k: string]: unknown } | null
  readonly texts?: { readonly [k: string]: string } | null
  readonly paint?: { readonly [k: string]: string } | null
  readonly nested?: { readonly [k: string]: Override } | null
}

const overrideFields = {
  component: Str,
  variant: StrMap,
  set: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))),
  texts: StrMap,
  paint: StrMap,
}

const OverrideSchema: Schema.Codec<Override> = Schema.Struct({
  ...overrideFields,
  nested: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.suspend(() => OverrideSchema)))),
})

export interface Node extends Override {
  readonly type?: string
  readonly name?: string
  readonly x?: number; readonly y?: number; readonly w?: number; readonly h?: number
  readonly minH?: number; readonly minW?: number
  readonly absolute?: boolean; readonly fillW?: boolean; readonly fillH?: boolean
  readonly fill?: string; readonly fillOpacity?: number | null
  readonly gradient?: { readonly fill?: string; readonly opacity?: number; readonly end?: number } | null
  readonly under?: string; readonly stroke?: string; readonly strokeWeight?: number
  readonly opacity?: number | null
  readonly props?: ReadonlyArray<{ readonly name?: string; readonly type?: string; readonly default?: unknown }> | null
  readonly bind?: { readonly [k: string]: string } | null
  readonly radius?: number; readonly clip?: boolean
  readonly layout?: string; readonly wrap?: boolean; readonly gap?: number
  readonly pad?: ReadonlyArray<number> | null
  readonly align?: string; readonly justify?: string
  readonly text?: string; readonly font?: string; readonly style?: string; readonly size?: number; readonly lineHeight?: number
  readonly truncate?: boolean; readonly strike?: boolean
  readonly textStyle?: string; readonly effectStyle?: string
  readonly svg?: string; readonly scale?: boolean; readonly flatten?: boolean
  readonly colors?: { readonly [k: string]: string } | null
  readonly children?: ReadonlyArray<Node> | null
  readonly vars?: { readonly [k: string]: string } | null
}

const NodeSchema: Schema.Codec<Node> = Schema.Struct({
  ...overrideFields,
  nested: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, OverrideSchema))),
  type: Str, name: Str, x: Num, y: Num, w: Num, h: Num, minH: Num, minW: Num,
  absolute: Bool, fillW: Bool, fillH: Bool, fill: Str, fillOpacity: NumOrNull,
  gradient: Schema.optionalKey(Schema.NullOr(Schema.Struct({ fill: Str, opacity: Num, end: Num }))),
  under: Str, stroke: Str, strokeWeight: Num, opacity: NumOrNull,
  props: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.Struct({ name: Str, type: Str, default: Schema.optionalKey(Schema.Unknown) })))),
  bind: StrMap, radius: Num, clip: Bool, layout: Str, wrap: Bool, gap: Num,
  pad: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.Number))),
  align: Str, justify: Str, text: Str, font: Str, style: Str, size: Num, lineHeight: Num,
  truncate: Bool, strike: Bool, textStyle: Str, effectStyle: Str, svg: Str, scale: Bool, flatten: Bool,
  colors: StrMap,
  children: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.suspend(() => NodeSchema)))),
  vars: StrMap,
})

export const WriteSpec = Schema.Struct({
  page: Str,
  section: Schema.optionalKey(Schema.NullOr(Schema.Struct({ name: Str, x: Num, y: Num }))),
  tokens: Schema.optionalKey(Schema.NullOr(Schema.Struct({ collection: Str, reuse: Bool, mode: Str, colors: StrMap }))),
  nodes: Schema.optionalKey(Schema.NullOr(Schema.Array(NodeSchema))),
})
export type WriteSpec = typeof WriteSpec.Type

export const GridSpec = Schema.Struct({
  page: Str, section: Str, collection: Str,
  columns: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
  rows: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.Struct({ name: Str, cells: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))) })))),
  below: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
  gap: Num,
})
export type GridSpec = typeof GridSpec.Type

export const LabelSpec = Schema.Struct({
  page: Str, section: Str, set: Str, collection: Str, x: Num, y: Num, mode: Str,
  rows: Str, cols: Str, blocks: Str, columns: Num, colWidth: Num, left: Num, minWidth: Num,
  rename: StrMap, values: StrMap,
})
export type LabelSpec = typeof LabelSpec.Type

export const SwapSpec = Schema.Struct({
  from: Str, to: Str,
  map: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.String)))),
  keep: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
})
export type SwapSpec = typeof SwapSpec.Type

export const Arrangement = Schema.Struct({
  rename: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.Struct({ from: Str, to: Str })))),
  order: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
  moves: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.Struct({ node: Str, page: Str, section: Str, x: Num, y: Num })))),
  names: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.Struct({ node: Str, name: Str })))),
  sections: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.Struct({ page: Str, name: Str, x: Num, y: Num })))),
})
export type Arrangement = typeof Arrangement.Type

/** Parses JSON text against a spec shape; an unknown field is an error. */
export const decodeSpec = <A>(schema: Schema.Codec<A>, text: string) => {
  try {
    return Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(JSON.parse(text))
  } catch (error) {
    return new BadInput({ detail: `the spec is not valid: ${(error as Error).message.split("\n").join(" ")}` })
  }
}

const isEmpty = (v: unknown) =>
  v === undefined || v === null || v === false || v === 0 || v === "" ||
  (Array.isArray(v) && v.length === 0) ||
  (typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length === 0)

const omitEmpty = (input: Record<string, unknown>, keep: ReadonlySet<string> = new Set()) =>
  Object.fromEntries(Object.entries(input).filter(([k, v]) => (keep.has(k) ? v !== undefined && v !== null : !isEmpty(v))))

const overrideJSON = (o: Override) => {
  const out = omitEmpty({ ...o })
  if (o.nested) out.nested = Object.fromEntries(Object.entries(o.nested).map(([k, v]) => [k, overrideJSON(v)]))
  if (isEmpty(out.nested)) delete out.nested
  return out
}

/** A node as Go sent it: pointers (opacity, fillOpacity, gradient) are left out only when absent. */
export const nodeJSON = (n: Node) => {
  const out: Record<string, unknown> = { ...omitEmpty({ ...n }, new Set(["opacity", "fillOpacity", "gradient"])), type: n.type ?? "" }
  if (n.gradient) out.gradient = { fill: n.gradient.fill ?? "", opacity: n.gradient.opacity ?? 0, end: n.gradient.end ?? 0 }
  if (n.props && n.props.length > 0) out.props = n.props.map((p) => ({ name: p.name ?? "", type: p.type ?? "", default: p.default ?? null }))
  if (n.nested) Object.assign(out, overrideJSON({ nested: n.nested }))
  if (n.children && n.children.length > 0) out.children = n.children.map(nodeJSON)
  return out
}

export const writeJSON = (s: WriteSpec) => ({
  page: s.page ?? "",
  ...(s.section ? { section: { name: s.section.name ?? "", ...omitEmpty({ x: s.section.x, y: s.section.y }) } } : {}),
  ...(s.tokens ? { tokens: { collection: s.tokens.collection ?? "", ...omitEmpty({ reuse: s.tokens.reuse, mode: s.tokens.mode }), colors: s.tokens.colors ?? null } } : {}),
  nodes: (s.nodes ?? []).map(nodeJSON),
})

export const gridJSON = (s: GridSpec) => ({
  page: s.page ?? "", section: s.section ?? "", collection: s.collection ?? "",
  columns: s.columns ?? null,
  rows: s.rows ? s.rows.map((r) => ({ name: r.name ?? "", cells: r.cells ?? null })) : null,
  ...omitEmpty({ below: s.below, gap: s.gap }),
})

export const labelJSON = (s: LabelSpec) => ({
  page: s.page ?? "", section: s.section ?? "", set: s.set ?? "", collection: s.collection ?? "",
  x: s.x ?? 0, y: s.y ?? 0, mode: s.mode ?? "",
  ...omitEmpty({ rows: s.rows, cols: s.cols, blocks: s.blocks, columns: s.columns }),
  colWidth: s.colWidth ?? 0,
  ...omitEmpty({ left: s.left, minWidth: s.minWidth, rename: s.rename, values: s.values }),
})

export const swapJSON = (s: SwapSpec) => ({ from: s.from ?? "", to: s.to ?? "", map: s.map ?? null, keep: s.keep ?? null })

export const arrangeJSON = (s: Arrangement) =>
  omitEmpty({
    rename: s.rename?.map((r) => ({ from: r.from ?? "", to: r.to ?? "" })),
    order: s.order,
    moves: s.moves?.map((m) => ({ node: m.node ?? "", page: m.page ?? "", section: m.section ?? "", x: m.x ?? 0, y: m.y ?? 0 })),
    names: s.names?.map((m) => ({ node: m.node ?? "", name: m.name ?? "" })),
    sections: s.sections?.map((m) => ({ page: m.page ?? "", name: m.name ?? "", x: m.x ?? 0, y: m.y ?? 0 })),
  })

const svgColor = /^#[0-9a-f]{6}$/
const aligns = new Set(["", "start", "center", "end", "baseline"])
const justifys = new Set(["", "start", "center", "end", "between"])
const bindTypes: Record<string, string> = { characters: "TEXT", visible: "BOOLEAN", mainComponent: "INSTANCE_SWAP" }
const varFields = new Set(["w", "h", "minW", "minH", "gap", "padX", "padY", "padL", "padR", "padT", "padB", "radius", "stroke"])
const q = JSON.stringify

const checkColor = (value: string, known: ReadonlySet<string>) => {
  if (value.startsWith("$")) return known.has(value.slice(1)) ? undefined : `the spec uses token ${value}, which it does not define`
  return hexColor.test(value) ? undefined : `${q(value)} is not a hex colour or a $token`
}

const checkPaint: (o: Override, known: ReadonlySet<string>) => string | undefined = (o, known) => {
  for (const color of Object.values(o.paint ?? {})) {
    const e = checkColor(color, known)
    if (e) return e
  }
  for (const inner of Object.values(o.nested ?? {})) {
    const e = checkPaint(inner, known)
    if (e) return e
  }
  return undefined
}

const checkFields = (n: Node) => {
  const t = n.type ?? ""
  const name = q(n.name ?? "")
  const box = t === "frame" || t === "component" || t === "variants"
  const layoutFields = !!n.layout || !!n.gap || (n.pad?.length ?? 0) > 0 || !!n.align || !!n.justify || !!n.radius || !!n.clip || (n.children?.length ?? 0) > 0
  const overrides = !!n.component || n.variant != null || n.set != null || n.texts != null || n.paint != null || n.nested != null
  const g = n.gradient
  if (!box && layoutFields) return `${t} node ${name} takes no layout, gap, pad, align, justify, radius, clip or children`
  if (t !== "instance" && overrides) return `${t} node ${name} takes no component, variant, set, texts, paint or nested; only instance does`
  if (n.textStyle && t !== "text") return `${t} node ${name} takes no textStyle; only text does`
  if (n.wrap && n.layout !== "row") return `node ${name}: wrap needs layout row`
  if (n.wrap && !n.w && !n.fillW) return `node ${name}: wrap needs w or fillW; a row that hugs its width never wraps`
  if (n.strike && t !== "text") return `${t} node ${name} takes no strike; only text does`
  if (t !== "svg" && Object.keys(n.colors ?? {}).length > 0) return `${t} node ${name} takes no colors; only svg does`
  if (n.under && !n.fill) return `node ${name} has under and no fill`
  if (n.stroke && (n.strokeWeight ?? 0) <= 0) return `node ${name} has a stroke and no strokeWeight`
  if (n.opacity != null && (n.opacity < 0 || n.opacity > 1)) return `node ${name} has opacity ${n.opacity}; use 0 to 1`
  if (t === "variants" && !n.layout && (!n.w || !n.h)) return `variants ${name}: with no layout it needs w and h, and its children x and y`
  if (Object.keys(n.vars ?? {}).length > 0 && t === "variants") return `variants ${name} takes no vars; its components do`
  if (n.flatten && (t !== "svg" || Object.keys(n.colors ?? {}).length !== 1)) return `node ${name}: flatten needs an svg with one colour`
  if (n.scale && t !== "svg") return `${t} node ${name} takes no scale; only svg does`
  if (n.absolute && (n.fillW || n.fillH)) return `node ${name}: an absolute child takes w and h, not fillW or fillH`
  if (g && n.fill) return `node ${name} has fill and gradient; use one`
  if (g && (t === "text" || t === "svg" || t === "instance")) return `${t} node ${name} takes no gradient; a frame or a component does`
  if (g && !(g.fill ?? "").startsWith("$")) return `node ${name}: a gradient needs a token, ${q(g.fill ?? "")} is not one`
  if (g && ((g.opacity ?? 0) <= 0 || (g.opacity ?? 0) > 1 || (g.end ?? 0) <= 0 || (g.end ?? 0) > 1)) return `node ${name}: a gradient takes opacity and end above 0, up to 1`
  if (n.fillOpacity != null && !n.fill) return `node ${name} has fillOpacity and no fill`
  if (n.fillOpacity != null && (n.fillOpacity < 0 || n.fillOpacity > 1)) return `node ${name} has fillOpacity ${n.fillOpacity}; use 0 to 1`
  if ([n.w, n.h, n.minH, n.minW, n.gap, n.radius, n.size].some((v) => (v ?? 0) < 0)) return `node ${name} has a negative size`
  const pads = n.pad?.length ?? 0
  if (pads !== 0 && pads !== 1 && pads !== 2 && pads !== 4) return `node ${name}: pad takes 1, 2 or 4 numbers`
  for (const [key, variable] of Object.entries(n.vars ?? {})) {
    if (!varFields.has(key) || variable === "") return `node ${name}: vars takes w, h, minW, minH, gap, padX, padY, padL, padR, padT, padB, radius or stroke with a variable name, not ${q(key)}`
  }
  if ((n.pad ?? []).some((p) => p < 0)) return `node ${name} has a negative pad`
  return undefined
}

const checkNode: (n: Node, known: ReadonlySet<string>) => string | undefined = (n, known) => {
  const t = n.type ?? ""
  const name = q(n.name ?? "")
  const children = n.children ?? []
  switch (t) {
    case "frame":
    case "component":
      break
    case "variants": {
      const wrong = children.find((c) => c.type !== "component")
      if (wrong) return `variants ${name} holds a ${wrong.type ?? ""}; it takes only components`
      if (children.length === 0) return `variants ${name} has no components`
      if (!n.layout) {
        const cells = new Set<string>()
        for (const c of children) {
          const cell = `${c.x ?? 0},${c.y ?? 0}`
          if (cells.has(cell)) return `variants ${name}: two children stand at x ${c.x ?? 0}, y ${c.y ?? 0}`
          cells.add(cell)
        }
      }
      break
    }
    case "text":
      if (!n.text || !n.size) return `text node ${name} needs text and size`
      break
    case "svg":
      if (!n.svg) return `svg node ${name} has no svg`
      break
    case "instance":
      if (!n.component) return `instance ${name} names no component`
      break
    default:
      return `node ${name} has unknown type ${q(t)}`
  }
  if (n.layout && n.layout !== "row" && n.layout !== "column") return `node ${name} has layout ${q(n.layout)}; use row or column`
  if (!aligns.has(n.align ?? "") || !justifys.has(n.justify ?? "")) return `node ${name} has align ${q(n.align ?? "")} and justify ${q(n.justify ?? "")}; one is not a known value`
  const fields = checkFields(n)
  if (fields) return fields
  for (const color of [n.fill, n.under, n.stroke]) {
    if (!color) continue
    const e = checkColor(color, known)
    if (e) return e
  }
  if (n.gradient) {
    const e = checkColor(n.gradient.fill ?? "", known)
    if (e) return e
  }
  const paint = checkPaint(n, known)
  if (paint) return paint
  for (const [from, to] of Object.entries(n.colors ?? {})) {
    if (!svgColor.test(from)) return `svg node ${name}: ${q(from)} must be six lower-case hex digits`
    const e = checkColor(to, known)
    if (e) return e
  }
  for (const child of children) {
    const e = checkNode(child, known)
    if (e) return e
  }
  return undefined
}

const checkBinds: (n: Node, inherited: ReadonlyMap<string, string> | undefined) => string | undefined = (n, inherited) => {
  const t = n.type ?? ""
  const name = q(n.name ?? "")
  let props = inherited
  if (t === "variants") {
    const own = new Map<string, string>()
    for (const p of n.props ?? []) {
      const d = p.default
      const swap = d !== null && typeof d === "object" && !Array.isArray(d) ? (d as Record<string, unknown>) : undefined
      const named = typeof swap?.component === "string" && swap.component !== ""
      const ok = (p.type === "TEXT" && typeof d === "string") || (p.type === "BOOLEAN" && typeof d === "boolean") || (p.type === "INSTANCE_SWAP" && named)
      if (!p.name || !ok) return `variants ${name}: property ${q(p.name ?? "")} needs a TEXT, BOOLEAN or INSTANCE_SWAP type and a default of that type`
      if (own.has(p.name)) return `variants ${name}: property ${q(p.name)} is defined twice`
      own.set(p.name, p.type ?? "")
    }
    props = own
  } else if ((n.props?.length ?? 0) > 0) return `${t} node ${name} takes no props; only variants does`
  const bind = Object.entries(n.bind ?? {})
  if (bind.length > 0 && (t === "variants" || t === "component")) return `${t} node ${name} cannot bind; a layer inside it can`
  for (const [field, prop] of bind) {
    const want = bindTypes[field]
    if (!want) return `node ${name}: bind takes characters, visible or mainComponent, not ${q(field)}`
    if (props?.get(prop) !== want) return `node ${name}: bind ${field} to ${q(prop)} needs a ${want} property of its variants node`
    if (field === "characters" && t !== "text") return `${t} node ${name} cannot bind characters`
    if (field === "mainComponent" && t !== "instance") return `${t} node ${name} cannot bind mainComponent; only an instance can`
  }
  for (const child of n.children ?? []) {
    const e = checkBinds(child, props)
    if (e) return e
  }
  return undefined
}

/** Refuses a write spec the page script would draw wrong. */
export const checkWrite = (s: WriteSpec) => {
  const fail = (detail: string) => new BadInput({ detail })
  if (!(s.page ?? "").trim()) return fail("the spec names no page")
  if (s.section && !(s.section.name ?? "").trim()) return fail("the spec's section has no name")
  const nodes = s.nodes ?? []
  if (nodes.length === 0) return fail("the spec has no nodes")
  const known = new Set<string>()
  if (s.tokens) {
    if (!s.tokens.collection) return fail("the tokens name no collection")
    for (const [name, value] of Object.entries(s.tokens.colors ?? {})) {
      if (!s.tokens.reuse && !hexColor.test(value)) return fail(`token ${name} is ${q(value)}, which is not a hex colour`)
      known.add(name)
    }
  }
  for (const node of nodes) {
    if (!node.name) return fail("every top-level node needs a name: -replace and the save check find it by name")
    const e = checkNode(node, known) ?? checkBinds(node, undefined)
    if (e) return fail(e)
  }
  return undefined
}

/** How many nodes a write spec draws. */
export const countNodes: (nodes: ReadonlyArray<Node>) => number = (nodes) => nodes.reduce((total, n) => total + 1 + countNodes(n.children ?? []), 0)

export const checkGrid = (g: GridSpec) => {
  const fail = (detail: string) => new BadInput({ detail })
  const columns = g.columns ?? []
  const rows = g.rows ?? []
  if (!g.page || !g.section || !g.collection) return fail("the grid needs page, section and collection")
  if (columns.length === 0 || rows.length === 0) return fail("the grid needs columns and rows")
  if ((g.gap ?? 0) < 0) return fail("gap cannot be negative")
  const seen = new Set<string>()
  const names = new Set<string>()
  for (const row of rows) {
    const cells = row.cells ?? []
    if (!row.name) return fail("every row needs a name")
    if (names.has(row.name)) return fail(`two rows are named ${q(row.name)}`)
    names.add(row.name)
    if (cells.length !== columns.length) return fail(`row ${q(row.name)} has ${cells.length} cells for ${columns.length} columns`)
    if (cells.every((c) => c === "")) return fail(`row ${q(row.name)} has no cell`)
  }
  for (const row of rows) {
    for (const cell of row.cells ?? []) {
      if (cell !== "" && seen.has(cell)) return fail(`node ${cell} is in two cells`)
      seen.add(cell)
    }
  }
  for (const node of g.below ?? []) {
    if (seen.has(node)) return fail(`node ${node} is in a cell and below`)
    seen.add(node)
  }
  for (let c = 0; c < columns.length; c++) {
    if (rows.every((row) => (row.cells ?? [])[c] === "")) return fail(`column ${q(columns[c] ?? "")} is empty in every row`)
  }
  return undefined
}

export const checkLabel = (l: LabelSpec) => {
  const fail = (detail: string) => new BadInput({ detail })
  if (!l.page || !l.section || !l.set || !l.collection) return fail("the spec needs page, section, set and collection")
  if ((l.colWidth ?? 0) <= 0) return fail("the spec needs colWidth")
  if (l.mode === "grid" && (!l.rows || !l.cols)) return fail("a grid needs rows and cols")
  if (l.mode === "grid" && (l.left ?? 0) <= 0) return fail("a grid needs left: the room for its row labels")
  if (l.mode === "list" && (l.columns ?? 0) < 1) return fail("a list needs columns")
  if (l.mode !== "grid" && l.mode !== "list") return fail(`mode ${q(l.mode ?? "")} is not grid or list`)
  return undefined
}
