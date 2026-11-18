import { Schema } from "effect"
import { BadInput } from "./domain.ts"

const PerTheme = Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.String)])
const Named = <S extends Schema.Top>(value: S) => Schema.Struct({ name: Schema.String, value })
const Values = Schema.Struct({ tokens: Schema.optionalKey(Schema.Array(Named(Schema.String))) })

/** The parts of tokens.json the push reads. Other fields are allowed, as Go's decoder allowed them. */
export const TokenFile = Schema.Struct({
  color: Schema.optionalKey(Schema.Struct({ tokens: Schema.optionalKey(Schema.Array(Named(PerTheme))) })),
  type: Schema.optionalKey(
    Schema.Struct({
      groups: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            name: Schema.String,
            family: Schema.optionalKey(Schema.String),
            styles: Schema.optionalKey(
              Schema.Array(
                Schema.Struct({
                  name: Schema.String,
                  family: Schema.optionalKey(Schema.String),
                  fontSize: Schema.optionalKey(Schema.String),
                  lineHeight: Schema.optionalKey(Schema.String),
                  fontWeight: Schema.optionalKey(Schema.Number),
                  letterSpacing: Schema.optionalKey(Schema.String),
                }),
              ),
            ),
          }),
        ),
      ),
    }),
  ),
  spacing: Schema.optionalKey(Values),
  radius: Schema.optionalKey(Values),
  shadow: Schema.optionalKey(Schema.Struct({ tokens: Schema.optionalKey(Schema.Array(Named(PerTheme))) })),
  ui: Schema.optionalKey(
    Schema.Struct({
      groups: Schema.optionalKey(Schema.Array(Schema.Struct({ name: Schema.String, tokens: Schema.optionalKey(Schema.Array(Named(Schema.Unknown))) }))),
    }),
  ),
})

export interface ColorSet { readonly name: string; readonly mode: string; readonly colors: Record<string, string> }
export interface TextStyle {
  readonly name: string; readonly family: string; readonly style: string; readonly size: number; readonly lineHeight: number
  readonly letterPercent?: number
}
export interface Shadow { x: number; y: number; blur: number; spread: number; r: number; g: number; b: number; opacity: number }
export interface EffectStyle { readonly name: string; readonly layers: ReadonlyArray<Shadow> }
export interface TokenPush {
  readonly colors: ReadonlyArray<ColorSet>
  readonly numbers: Record<string, number>
  readonly text: ReadonlyArray<TextStyle>
  readonly effects: ReadonlyArray<EffectStyle>
}

const themeSets = [
  { id: "dark", collection: "Cursor Dark", mode: "Dark" },
  { id: "light", collection: "Cursor Light", mode: "Light" },
  { id: "web", collection: "Ace Warm", mode: "Web" },
] as const

const familyNames: Record<string, string> = { ui: "Geist", mono: "Geist Mono", sans: "Archivo", narrow: "Archivo Narrow" }
const weightNames: Record<number, string> = { 300: "Light", 400: "Regular", 500: "Medium", 600: "SemiBold" }
export const hexColor = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/
const aliasColor = /^\{[a-z0-9-]+\}$/
const shadowLayer = /^(-?[\d.]+)(?:px)? (-?[\d.]+)(?:px)? (-?[\d.]+)(?:px)?(?: (-?[\d.]+)px)? rgba\((\d+), ?(\d+), ?(\d+), ?([\d.]+)\)$/

const perTheme = (value: string | { readonly [k: string]: string }, theme: string) =>
  typeof value === "string" ? value : value[theme] ?? ""

const pixels = (value: string) => {
  if (!value.endsWith("px")) return undefined
  const n = Number(value.slice(0, -2))
  return value.length > 2 && Number.isFinite(n) ? n : undefined
}

const lineHeight = (value: string, size: number) => {
  const share = value.trim() === "" ? Number.NaN : Number(value)
  return Number.isFinite(share) ? share * size : pixels(value)
}

const splitShadows = (value: string) => {
  const parts: Array<string> = []
  let depth = 0
  let start = 0
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]
    if (ch === "(") depth++
    else if (ch === ")") depth--
    else if (ch === "," && depth === 0) {
      parts.push(value.slice(start, i))
      start = i + 1
    }
  }
  parts.push(value.slice(start))
  return parts
}

const shadowLayers = (value: string) => {
  const layers: Array<Shadow> = []
  for (const part of splitShadows(value)) {
    const m = shadowLayer.exec(part.trim())
    if (!m) return undefined
    const n = (i: number) => Number(m[i] ?? 0) || 0
    layers.push({ x: n(1), y: n(2), blur: n(3), spread: n(4), r: n(5) / 255, g: n(6) / 255, b: n(7) / 255, opacity: n(8) })
  }
  return layers.length > 0 ? layers : undefined
}

/** Turns design/tokens.json into what Figma takes, and names what it cannot take. */
export const compileTokens = (text: string) => {
  let file: typeof TokenFile.Type
  try {
    file = Schema.decodeUnknownSync(TokenFile)(JSON.parse(text))
  } catch (error) {
    return new BadInput({ detail: `the tokens file is not valid: ${(error as Error).message}` })
  }
  const colorTokens = file.color?.tokens ?? []
  if (colorTokens.length === 0) return new BadInput({ detail: "the tokens file has no colours" })
  const skipped: Array<string> = []
  const skip = (name: string, why: string) => skipped.push(`${name}: ${why}`)

  const colors: Array<ColorSet> = themeSets.map((theme) => {
    const set: Record<string, string> = {}
    for (const token of colorTokens) {
      const value = perTheme(token.value, theme.id)
      if (value === "") continue
      if (!hexColor.test(value) && !aliasColor.test(value)) {
        skip(`color/${token.name}`, `${value} is not a hex colour or an alias`)
        continue
      }
      set[token.name] = value
    }
    return { name: theme.collection, mode: theme.mode, colors: set }
  })

  const numbers: Record<string, number> = {}
  for (const [prefix, group] of [["spacing", file.spacing], ["radius", file.radius]] as const) {
    for (const token of group?.tokens ?? []) {
      const value = pixels(token.value)
      if (value === undefined) skip(`${prefix}/${token.name}`, `${token.value} is not a size in px`)
      else numbers[`${prefix}/${token.name}`] = value
    }
  }
  for (const group of file.ui?.groups ?? []) {
    for (const token of group.tokens ?? []) {
      if (typeof token.value === "number") numbers[`ui/${group.name}/${token.name}`] = token.value
      else skip(`ui/${group.name}/${token.name}`, "not a number")
    }
  }

  const textStyles: Array<TextStyle> = []
  for (const group of file.type?.groups ?? []) {
    for (const style of group.styles ?? []) {
      const family = style.family || group.family || ""
      const size = pixels(style.fontSize ?? "")
      const line = size === undefined ? undefined : lineHeight(style.lineHeight ?? "", size)
      const weight = weightNames[style.fontWeight ?? 0]
      const familyName = familyNames[family]
      if (size === undefined || line === undefined || !weight || !familyName) {
        skip(`type/${style.name}`, "a size, line height, weight or family that Figma cannot take")
        continue
      }
      const base = { name: `Ace/${group.name}/${style.name}`, family: familyName, style: weight, size, lineHeight: line }
      if (style.letterSpacing) {
        const em = style.letterSpacing.endsWith("em") ? Number(style.letterSpacing.slice(0, -2)) : Number.NaN
        if (!Number.isFinite(em)) {
          skip(`type/${style.name}`, `letter spacing ${style.letterSpacing} is not in em`)
          continue
        }
        textStyles.push({ ...base, letterPercent: em * 100 })
      } else textStyles.push(base)
    }
  }

  const effects: Array<EffectStyle> = []
  for (const theme of themeSets) {
    for (const token of file.shadow?.tokens ?? []) {
      const value = perTheme(token.value, theme.id)
      const layers = shadowLayers(value)
      if (!layers) skip(`shadow/${theme.id}/${token.name}`, value)
      else effects.push({ name: `${theme.collection}/${token.name}`, layers })
    }
  }
  skipped.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return { push: { colors, numbers, text: textStyles, effects }, skipped }
}
