// TOON output, as figmacli 0.1.0 writes it (sitecli internal/toon): an object of scalar fields, a table of uniform
// rows, and a list of strings, with the spec's section 7.2 quoting.
const indent = "  "
const numericLike = /^[+-]?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/

export interface Field {
  readonly key: string
  readonly value: string
  /** Written as it is: a number or a boolean. */
  readonly raw?: boolean
}

export const raw = (key: string, value: number | boolean): Field => ({ key, value: String(value), raw: true })
export const text = (key: string, value: string): Field => ({ key, value })

const mustQuote = (value: string): boolean =>
  value === "" ||
  value !== value.trim() ||
  value === "true" || value === "false" || value === "null" ||
  numericLike.test(value) ||
  /[:"\\[\]{},]/.test(value) ||
  value.startsWith("-") || value.startsWith("#") ||
  // biome-ignore lint: control characters are the point
  /[\u0000-\u001f]/.test(value)

const quote = (value: string): string => {
  let out = '"'
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0
    if (ch === "\\") out += "\\\\"
    else if (ch === '"') out += '\\"'
    else if (ch === "\n") out += "\\n"
    else if (ch === "\r") out += "\\r"
    else if (ch === "\t") out += "\\t"
    else if (code <= 0x1f) out += `\\u${code.toString(16).padStart(4, "0")}`
    else out += ch
  }
  return `${out}"`
}

export const value = (v: string): string => (mustQuote(v) ? quote(v) : v)
export const key = (k: string): string => (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(k) ? k : quote(k))

/** A TOON document, one block at a time. */
export class Doc {
  private readonly blocks: Array<string> = []

  object(name: string, ...fields: ReadonlyArray<Field>): this {
    const depth = name === "" ? "" : indent
    const head = name === "" ? "" : `${key(name)}:\n`
    return this.add(head + fields.map((f) => `${depth}${key(f.key)}: ${f.raw ? f.value : value(f.value)}\n`).join(""))
  }

  table(name: string, columns: ReadonlyArray<string>, rows: ReadonlyArray<ReadonlyArray<string>>): this {
    let out = `${key(name)}[${rows.length}]{${columns.map(key).join(",")}}:\n`
    rows.forEach((row, index) => {
      if (row.length !== columns.length) throw new Error(`toon: row ${index} has ${row.length} cells for ${columns.length} columns`)
      out += `${indent}${row.map(value).join(",")}\n`
    })
    return this.add(out)
  }

  list(name: string, items: ReadonlyArray<string>): this {
    return this.add(`${key(name)}[${items.length}]:\n${items.map((i) => `${indent}- ${value(i)}\n`).join("")}`)
  }

  private add(block: string): this {
    if (block.trim() !== "") this.blocks.push(block.replace(/\n+$/, ""))
    return this
  }

  toString(): string {
    return this.blocks.length === 0 ? "" : `${this.blocks.join("\n\n")}\n`
  }
}

/** Go's %g, which figmacli used for sizes such as 375x812: shortest digits, and e-notation from 1e+06 up. */
export const g = (n: number): string => {
  if (n === 0 || !Number.isFinite(n)) return String(n)
  const [mantissa = "0", exponent = "0"] = n.toExponential().split("e")
  const exp = Number(exponent)
  if (exp < -4 || exp >= 6) return `${mantissa}e${exp < 0 ? "-" : "+"}${String(Math.abs(exp)).padStart(2, "0")}`
  return String(n)
}
