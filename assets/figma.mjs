// Figma page script. Figma keeps a document in a binary multiplayer socket, so
// there is no request to replay for nodes. The Design editor exposes its own
// Plugin API as window.figma; reads and writes of nodes go through that. File
// details and the rename are plain page requests. The Make editor has no
// window.figma, so a Make file refuses node commands with a sentence.
//
// The answer of /api/file_metadata holds a realtime token. Only named fields
// leave the page, so a token never reaches the terminal.
const MARKER = "FIGMACLI_JSON:";
const ORIGIN = "https://www.figma.com";
// figma-fast passes figmacli-<file key>: one Space per file.
const SPACE = INPUT.space || "figmacli";
const OPEN_TIMEOUT = 180000;
// A second tab proves the save: it loads what Figma holds, while the tab that
// wrote stays open and keeps its socket. It looks this often, this many times.
const SAVE_WAIT = 3000;
const SAVE_TRIES = 6;
// The Figma type a spec type makes, so -replace removes only its own kind.
const FIGMA_TYPES = { frame: "FRAME", component: "COMPONENT", variants: "COMPONENT_SET", text: "TEXT", svg: "FRAME", instance: "INSTANCE" };

function emit(value) {
  console.log(MARKER + JSON.stringify(value));
}

// space reuses the tool's own task space, so only the first call pays the
// browser start-up.
async function space() {
  const existing = (await listTaskSpaces()).filter((s) => s.name === SPACE);
  if (existing.length === 0) return await taskSpace(SPACE);
  const found = existing[0];
  if (found.ownership === "agent") return await taskSpace(found.id);
  if (found.ownership === "agentDelegatedToUser") return await takeOverTaskSpace(found.id);
  return await claimTaskSpace(found.id);
}

// One Figma tab for each file: the file's space keeps its first page. Only a run that holds the file alone closes
// the others, as a read that runs beside it may be using one.
async function firstPage(task) {
  const pages = await task.pages();
  if (INPUT.exclusive !== false) for (const extra of pages.slice(1)) await extra.close();
  return pages.length > 0 ? pages[0] : await task.newPage();
}

// closeSpace ends this file's space and its tab, when the reaper finds it idle.
async function closeSpace() {
  const found = (await listTaskSpaces()).filter((s) => s.name === SPACE && s.ownership === "agent");
  for (const entry of found) await (await taskSpace(entry.id)).finish({ keep: [] });
  return { closed: found.length };
}

// figmaTabs lists the browser's Figma editor tabs, in every space.
async function figmaTabs(task) {
  const targets = await task.cdp("Target.getTargets", {});
  return (targets.targetInfos || [])
    .filter((t) => t.type === "page" && /figma\.com\/(design|file|board|make|slides)\//.test(t.url))
    .map((t) => ({ title: t.title, url: t.url }));
}

function pathOf(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

function kindOf(path) {
  if (/^\/(design|file)\//.test(path)) return "design";
  if (path.startsWith("/make/")) return "make";
  if (path.startsWith("/board/")) return "figjam";
  if (path.startsWith("/slides/")) return "slides";
  return "unknown";
}

function checkSignedIn(path) {
  if (path.startsWith("/login") || path.startsWith("/signup")) throw new Error("not signed in");
}

async function onFigma(page) {
  if (!(await page.url()).startsWith(ORIGIN)) await page.goto(ORIGIN + "/files/recents-and-sharing");
  checkSignedIn(pathOf(await page.url()));
}

async function ready(page) {
  await page.waitForFunction(
    () => (window.figma && window.figma.root) || !/^\/(design|file)\//.test(location.pathname),
    undefined,
    { timeout: OPEN_TIMEOUT },
  );
}

// openFile loads the file by way of /design/, and Figma sends the other kinds
// to their own editor. The caller reads the kind from where it ended.
async function openFile(page, key) {
  if (pathOf(await page.url()).split("/")[2] !== key) await page.goto(`${ORIGIN}/design/${key}`);
  try {
    await ready(page);
  } catch {
    checkSignedIn(pathOf(await page.url()));
    throw new Error(`Figma did not open file ${key}: this account has no access, or the file does not exist`);
  }
  const path = pathOf(await page.url());
  checkSignedIn(path);
  return kindOf(path);
}

function requireDesign(kind) {
  if (kind === "design") return;
  throw new Error(
    `this is a Figma ${kind} file, and only a Design file has a document API. ` +
      "Write to a Design file; a Make file takes changes only through its own prompt",
  );
}

async function metadata(page, key) {
  const res = await page.fetch(`/api/file_metadata/${key}`, { timeout: 15000 });
  if (res.status !== 200) throw new Error(`Figma answered HTTP ${res.status} for file ${key}`);
  const body = JSON.parse(res.body);
  const meta = body.meta || body;
  return { name: meta.name, can_edit: Boolean(meta.can_edit) };
}

// The functions below run inside the page: they see no variable of this file.

// startEval runs the caller's script as `async (figma) => { BODY }` with every page loaded, and returns at
// once: ego's evaluate gives up after 15 s, so evalInPage polls for the answer. A throw or a syntax error
// is the answer as its message.
function startEval({ body }) {
  const state = { done: false, answer: null };
  window.__figmacliEval = state;
  (async () => {
    try {
      await window.figma.loadAllPagesAsync();
      const run = new Function("figma", "return (async () => {" + body + "\n})()");
      const value = await run(window.figma);
      const text = JSON.stringify(value === undefined ? null : value);
      state.answer = text === undefined ? { error: "the script returned a value that is not JSON" } : { result: JSON.parse(text) };
    } catch (error) {
      state.answer = { error: String((error && error.message) || error) };
    }
    state.done = true;
  })();
}

function evalAnswer() {
  const state = window.__figmacliEval;
  if (!state || !state.done) return null;
  delete window.__figmacliEval;
  return state.answer;
}

// The budget starts when the file is open, so a slow open does not eat the script's time.
async function evalInPage(page) {
  await page.evaluate(startEval, { body: INPUT.script });
  const deadline = Date.now() + INPUT.evalMs;
  for (;;) {
    const answer = await page.evaluate(evalAnswer);
    if (answer) return answer;
    if (Date.now() > deadline) {
      return { error: `the script did not finish within ${INPUT.evalMs / 1000} s. It may still run in the Figma tab` };
    }
    await page.waitForTimeout(250);
  }
}

async function listPages() {
  const pages = [];
  for (const p of window.figma.root.children) {
    await p.loadAsync();
    pages.push({ id: p.id, name: p.name, nodes: p.children.length });
  }
  return pages;
}

async function readTree({ page, depth }) {
  // A page may carry an emoji before its name ("🔘 Button"); a page is found by its name alone.
  const bare = (name) => String(name).replace(/^\p{Extended_Pictographic}[\uFE0F\u200D\p{Extended_Pictographic}]*\s+/u, "");
  const f = window.figma;
  const target = page ? f.root.children.find((p) => bare(p.name) === bare(page)) : f.root.children[0];
  if (!target) throw new Error(`no page named "${page}"`);
  await target.loadAsync();
  const nodes = [];
  const walk = (node, level) => {
    nodes.push({
      id: node.id,
      type: node.type,
      name: node.name,
      depth: level,
      x: Math.round(node.x * 100) / 100,
      y: Math.round(node.y * 100) / 100,
      w: Math.round(node.width * 100) / 100,
      h: Math.round(node.height * 100) / 100,
      text: node.type === "TEXT" ? node.characters : "",
    });
    if (level < depth && "children" in node) for (const child of node.children) walk(child, level + 1);
  };
  for (const child of target.children) walk(child, 1);
  return { page: target.name, nodes };
}

async function exportNode({ node, scale }) {
  const f = window.figma;
  let found = await f.getNodeByIdAsync(node);
  if (!found) {
    await f.loadAllPagesAsync();
    // A section may carry the name of the component it holds.
    found =
      f.root.findOne((n) => n.type !== "PAGE" && n.type !== "SECTION" && n.name === node) ||
      f.root.findOne((n) => n.type === "SECTION" && n.name === node);
  }
  if (!found || !("exportAsync" in found)) throw new Error(`no node "${node}" to export`);
  const bytes = await found.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: scale } });
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return { name: found.name, w: found.width, h: found.height, png: btoa(binary) };
}

async function drawSpec({ spec, replace, types }) {
  // A page may carry an emoji before its name ("🔘 Button"); a page is found by its name alone.
  const bare = (name) => String(name).replace(/^\p{Extended_Pictographic}[\uFE0F\u200D\p{Extended_Pictographic}]*\s+/u, "");
  const f = window.figma;
  const rgb = (value) => {
    const raw = value.replace("#", "");
    const full = raw.length === 3 ? [...raw].map((c) => c + c).join("") : raw;
    const color = {
      r: parseInt(full.slice(0, 2), 16) / 255,
      g: parseInt(full.slice(2, 4), 16) / 255,
      b: parseInt(full.slice(4, 6), 16) / 255,
    };
    return full.length === 8 ? { ...color, a: parseInt(full.slice(6, 8), 16) / 255 } : color;
  };
  const hexOf = (c) =>
    "#" + [c.r, c.g, c.b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("");

  // undo puts back what a failed draw changed, last change first.
  const undo = [];
  const variables = new Map();

  // Tokens become local variables, reused by name, so a second run updates them.
  const writeTokens = async () => {
    const collections = await f.variables.getLocalVariableCollectionsAsync();
    let collection = collections.find((c) => c.name === spec.tokens.collection);
    if (spec.tokens.reuse) {
      if (!collection) throw new Error(`no collection named "${spec.tokens.collection}"`);
      const held = await f.variables.getLocalVariablesAsync("COLOR");
      for (const name of Object.keys(spec.tokens.colors)) {
        const variable = held.find((v) => v.name === name && v.variableCollectionId === collection.id);
        if (!variable) throw new Error(`collection "${collection.name}" has no colour "${name}"`);
        variables.set(name, variable);
      }
      await learnBases(collection, held);
      return;
    }
    if (!collection) {
      collection = f.variables.createVariableCollection(spec.tokens.collection);
      const made = collection;
      undo.push(() => made.remove());
    }
    const mode = collection.modes[0].modeId;
    if (spec.tokens.mode) {
      const { name } = collection.modes[0];
      const held = collection;
      collection.renameMode(mode, spec.tokens.mode);
      undo.push(() => held.renameMode(mode, name));
    }
    const existing = await f.variables.getLocalVariablesAsync("COLOR");
    for (const [name, value] of Object.entries(spec.tokens.colors)) {
      let variable = existing.find((v) => v.name === name && v.variableCollectionId === collection.id);
      if (variable) {
        const old = variable.valuesByMode[mode];
        const held = variable;
        undo.push(() => held.setValueForMode(mode, old));
      } else {
        variable = f.variables.createVariable(name, collection, "COLOR");
        const made = variable;
        undo.push(() => made.remove());
      }
      variable.setValueForMode(mode, rgb(value));
      variables.set(name, variable);
    }
    await learnBases(collection, await f.variables.getLocalVariablesAsync("COLOR"));
  };

  // What an alpha variable needs: its collection, and each colour with its
  // aliases followed.
  const alpha = { collection: null, mode: "", held: [], bases: new Map() };
  const learnBases = async (collection, held) => {
    alpha.collection = collection;
    alpha.mode = collection.modes[0].modeId;
    alpha.held = held.filter((v) => v.variableCollectionId === collection.id);
    for (const [name, variable] of variables) {
      let value = variable.valuesByMode[alpha.mode];
      while (value && value.type === "VARIABLE_ALIAS") {
        const next = await f.variables.getVariableByIdAsync(value.id);
        value = next.valuesByMode[alpha.mode];
      }
      if (!value || value.r === undefined) throw new Error(`colour "${name}" has no value to fade`);
      alpha.bases.set(name, value);
    }
  };

  // An instance draws a bound paint at full strength, whatever opacity the paint
  // holds (seen live, 2026-10-31). So a colour at an opacity is its own variable,
  // "alpha/ink@90", in the same collection: its alpha holds in every instance.
  const alphaVariable = (name, opacity) => {
    const percent = Math.round(opacity * 100);
    const key = `alpha/${name}@${percent}`;
    if (variables.has(key)) return variables.get(key);
    const base = alpha.bases.get(name);
    let variable = alpha.held.find((v) => v.name === key);
    if (variable) {
      const held = variable;
      const old = held.valuesByMode[alpha.mode];
      undo.push(() => held.setValueForMode(alpha.mode, old));
    } else {
      variable = f.variables.createVariable(key, alpha.collection, "COLOR");
      const made = variable;
      undo.push(() => made.remove());
    }
    const a = (base.a === undefined ? 1 : base.a) * (percent / 100);
    variable.setValueForMode(alpha.mode, { r: base.r, g: base.g, b: base.b, a });
    variables.set(key, variable);
    return variable;
  };

  const paint = (color, opacity = 1) => {
    const base = { type: "SOLID", color: { r: 0, g: 0, b: 0 }, opacity: 1 };
    if (!color.startsWith("$")) return { ...base, color: rgb(color), opacity };
    const name = color.slice(1);
    const variable = opacity < 1 ? alphaVariable(name, opacity) : variables.get(name);
    // The paint holds the variable's value too: an instance draws an overridden paint by its own colour.
    const known = alpha.bases.get(name);
    const resolved = known ? { ...base, color: { r: known.r, g: known.g, b: known.b } } : base;
    return f.variables.setBoundVariableForPaint(resolved, "color", variable);
  };

  const fade = ({ fill, opacity, end }) => {
    const stop = (position, strength) => {
      const variable = alphaVariable(fill.slice(1), strength);
      return { position, color: variable.valuesByMode[alpha.mode], boundVariables: { color: f.variables.createVariableAlias(variable) } };
    };
    return { type: "GRADIENT_LINEAR", gradientTransform: [[1, 0, 0], [0, 1, 0]], gradientStops: [stop(0, opacity), stop(end, 0)] };
  };

  const setFill = (node, spec) => {
    if (spec.gradient) {
      node.fills = [fade(spec.gradient)];
      return;
    }
    if (!spec.fill) {
      node.fills = [];
      return;
    }
    const top = paint(spec.fill, spec.fillOpacity === undefined ? 1 : spec.fillOpacity);
    // The last paint is the top one.
    node.fills = spec.under ? [paint(spec.under), top] : [top];
  };

  // Bindings wait for the component set, which owns the properties.
  let bindings = [];

  const fontOf = (spec) => ({ family: spec.font || "Geist", style: spec.style || "Regular" });

  const collectFonts = (node, fonts) => {
    if (node.type === "text") fonts.set(JSON.stringify(fontOf(node)), fontOf(node));
    for (const child of node.children || []) collectFonts(child, fonts);
    return fonts;
  };

  // recolor swaps the colours an imported SVG carries for the ones its spec names.
  const recolor = (root, colors) => {
    root.fills = [];
    const swap = (node, field) => {
      node[field] = node[field].map((p) => {
        const to = p.type === "SOLID" ? colors[hexOf(p.color)] : undefined;
        return to ? paint(to, p.opacity) : p;
      });
    };
    for (const n of root.findAll(() => true)) {
      if ("fills" in n && Array.isArray(n.fills)) swap(n, "fills");
      if ("strokes" in n) swap(n, "strokes");
    }
  };

  const applyLayout = (node, spec) => {
    if (!spec.layout) return;
    node.layoutMode = spec.layout === "row" ? "HORIZONTAL" : "VERTICAL";
    node.itemSpacing = spec.gap || 0;
    const pad = spec.pad || [0];
    const [top, right = top, bottom = top, left = right] = pad;
    Object.assign(node, { paddingTop: top, paddingRight: right, paddingBottom: bottom, paddingLeft: left });
    const counter = { start: "MIN", center: "CENTER", end: "MAX", baseline: "BASELINE" };
    const primary = { start: "MIN", center: "CENTER", end: "MAX", between: "SPACE_BETWEEN" };
    node.counterAxisAlignItems = counter[spec.align || "start"];
    node.primaryAxisAlignItems = primary[spec.justify || "start"];
    if (spec.wrap) {
      node.layoutWrap = "WRAP";
      node.counterAxisSpacing = spec.gap || 0;
    }
  };

  const applySize = (node, spec, inLayout) => {
    if (spec.layout) {
      node.layoutSizingHorizontal = "HUG";
      node.layoutSizingVertical = "HUG";
    }
    if (spec.w || spec.h) {
      node.resize(spec.w || node.width, spec.h || node.height);
      if (spec.layout || inLayout) {
        if (spec.w) node.layoutSizingHorizontal = "FIXED";
        if (spec.h) node.layoutSizingVertical = "FIXED";
      }
    }
    if (spec.minH) node.minHeight = spec.minH;
    if (spec.minW) node.minWidth = spec.minW;
    if (inLayout && spec.fillW) node.layoutSizingHorizontal = "FILL";
    if (inLayout && spec.fillH) node.layoutSizingVertical = "FILL";
  };

  // The file's components by name. It loads only for a spec with instances.
  const library = new Map();
  const holders = new Map();
  // The file's number variables by name, for vars. They load only when a node binds one.
  const floats = new Map();
  const usesVars = (node) => Boolean(node.vars) || (node.children || []).some(usesVars);
  const VAR_FIELDS = {
    w: ["width"], h: ["height"], minW: ["minWidth"], minH: ["minHeight"], gap: ["itemSpacing"],
    padX: ["paddingLeft", "paddingRight"], padY: ["paddingTop", "paddingBottom"],
    padL: ["paddingLeft"], padR: ["paddingRight"], padT: ["paddingTop"], padB: ["paddingBottom"],
    radius: ["topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius"], stroke: ["strokeWeight"],
  };
  const bindVars = (node, spec) => {
    for (const [key, name] of Object.entries(spec.vars || {})) {
      const variable = floats.get(name);
      if (!variable) throw new Error(`node "${spec.name}": no number variable named "${name}"`);
      for (const field of VAR_FIELDS[key]) node.setBoundVariable(field, variable);
    }
  };
  // A property value that names a component, for an INSTANCE_SWAP property, is its id.
  const propValue = (value) => (value && typeof value === "object" ? componentOf(value.component, value.variant).id : value);
  const usesInstances = (node) => node.type === "instance" || (node.children || []).some(usesInstances);
  const loadLibrary = async () => {
    await f.loadAllPagesAsync();
    for (const found of f.root.findAllWithCriteria({ types: ["COMPONENT_SET", "COMPONENT"] })) {
      if (!library.has(found.name) || found.type === "COMPONENT_SET") library.set(found.name, found);
    }
    // A set or lone component whose name another page holds too: a write that names it refuses with both ids, instead of
    // picking one (ACE-1136). A NEW frame's shapes and Archive count not, as in check.
    for (const page of f.root.children) {
      const name = String(page.name).replace(/^\p{Extended_Pictographic}[\uFE0F\u200D\p{Extended_Pictographic}]*\s+/u, "");
      if (name === "Archive" || /^-+$/.test(name)) continue;
      const visit = (node) => {
        if (node.name.startsWith("NEW ")) return;
        if (node.type === "COMPONENT_SET" || (node.type === "COMPONENT" && node.parent.type !== "COMPONENT_SET")) {
          const held = holders.get(node.name) || [];
          held.push({ id: node.id, page: name });
          holders.set(node.name, held);
          return;
        }
        if ("children" in node && node.type !== "INSTANCE") for (const child of node.children) visit(child);
      };
      for (const child of page.children) visit(child);
    }
    const fonts = new Map();
    for (const text of f.root.findAllWithCriteria({ types: ["TEXT"] })) {
      if (typeof text.fontName === "object") fonts.set(JSON.stringify(text.fontName), text.fontName);
    }
    for (const font of fonts.values()) await f.loadFontAsync(font);
  };

  const componentOf = (name, variant) => {
    const held = holders.get(name) || [];
    if (new Set(held.map((h) => h.page)).size > 1) {
      throw new Error(`"${name}" names more than one component: ${held.map((h) => `${h.id} on ${h.page}`).join(", ")}; rename one (figmacli check -page all lists them)`);
    }
    const found = library.get(name);
    if (!found) throw new Error(`no component named "${name}"`);
    if (found.type === "COMPONENT") return found;
    if (!variant) return found.defaultVariant;
    const wanted = Object.entries(variant);
    const match = found.children.find((c) => wanted.every(([k, v]) => c.variantProperties[k] === v));
    if (!match) throw new Error(`"${name}" has no variant ${JSON.stringify(variant)}`);
    return match;
  };

  const override = (instance, spec) => {
    const props = {};
    const keyOf = (name) => {
      const key = Object.keys(instance.componentProperties).find((k) => k === name || k.startsWith(name + "#"));
      if (!key) throw new Error(`instance "${instance.name}" has no property "${name}"`);
      return key;
    };
    for (const [name, value] of Object.entries(spec.set || {})) props[keyOf(name)] = propValue(value);
    if (Object.keys(props).length > 0) instance.setProperties(props);
    for (const [name, value] of Object.entries(spec.texts || {})) {
      const text = instance.findOne((n) => n.type === "TEXT" && n.name === name);
      if (!text) throw new Error(`instance "${instance.name}" has no text "${name}"`);
      text.characters = value;
    }
    const SHAPES = ["VECTOR", "BOOLEAN_OPERATION", "ELLIPSE", "RECTANGLE", "LINE", "POLYGON", "STAR"];
    // A shape takes the colour on its fills and its strokes, each with its own opacity: a stroked icon has no fill.
    const tint = (shape, color) => {
      if (shape.fills.length > 0) shape.fills = shape.fills.map((p) => paint(color, p.opacity === undefined ? 1 : p.opacity));
      if (shape.strokes.length > 0) shape.strokes = shape.strokes.map((p) => paint(color, p.opacity === undefined ? 1 : p.opacity));
    };
    const shapesOf = (node) => node.findAll((n) => SHAPES.includes(n.type));
    for (const [name, color] of Object.entries(spec.paint || {})) {
      if (name === "*") {
        const shapes = shapesOf(instance);
        if (shapes.length === 0) throw new Error(`instance "${instance.name}" has no shape to paint`);
        for (const shape of shapes) tint(shape, color);
        continue;
      }
      const layer = instance.findOne((n) => n.name === name && "fills" in n);
      if (!layer) throw new Error(`instance "${instance.name}" has no layer "${name}"`);
      if (SHAPES.includes(layer.type) && (layer.fills.length > 0 || layer.strokes.length > 0)) tint(layer, color);
      else if (layer.type === "INSTANCE") {
        // A nested instance, such as an icon in a button, takes the colour on its shapes, not as a background.
        const shapes = shapesOf(layer);
        if (shapes.length === 0) throw new Error(`layer "${name}" of instance "${instance.name}" has no shape to paint`);
        for (const shape of shapes) tint(shape, color);
      } else layer.fills = [paint(color)];
    }
    for (const [name, inner] of Object.entries(spec.nested || {})) {
      const nested = instance.findOne((n) => n.type === "INSTANCE" && n.name === name);
      if (!nested) throw new Error(`instance "${instance.name}" has no instance "${name}"`);
      if (inner.component) nested.swapComponent(componentOf(inner.component, inner.variant));
      else if (inner.variant) {
        const variant = {};
        for (const [k, v] of Object.entries(inner.variant)) variant[k] = v;
        nested.setProperties(variant);
      }
      override(nested, inner);
    }
  };

  // Styles need an await, so they wait until the build ends.
  const styled = [];
  const effected = [];

  const build = (spec, parent) => {
    let node;
    if (spec.type === "instance") {
      node = componentOf(spec.component, spec.variant).createInstance();
      override(node, spec);
    } else if (spec.type === "text") {
      node = f.createText();
      node.fontName = fontOf(spec);
      node.characters = spec.text;
      node.fontSize = spec.size;
      if (spec.lineHeight) node.lineHeight = { unit: "PIXELS", value: spec.lineHeight };
      if (spec.fill) setFill(node, spec);
      if (spec.strike) node.textDecoration = "STRIKETHROUGH";
      if (spec.textStyle) styled.push({ node, name: spec.textStyle });
    } else if (spec.type === "svg") {
      node = f.createNodeFromSvg(spec.svg);
      recolor(node, spec.colors || {});
      if (spec.flatten) {
        const SHAPES = ["VECTOR", "BOOLEAN_OPERATION", "ELLIPSE", "RECTANGLE", "LINE", "POLYGON", "STAR"];
        const parts = [];
        for (const shape of node.findAll((n) => SHAPES.includes(n.type))) {
          if (shape.strokes.length > 0) {
            // Figma puts the outline on the page, at a place in the coordinates of the shape's group: put it in
            // the drawing where the stroke was drawn, which is the shape's render bounds (seen live, 2026-10-31).
            const bounds = shape.absoluteRenderBounds;
            const outline = shape.outlineStroke();
            if (outline && bounds) {
              node.appendChild(outline);
              outline.x = bounds.x - node.absoluteTransform[0][2];
              outline.y = bounds.y - node.absoluteTransform[1][2];
              parts.push(outline);
            }
          }
          if (shape.fills.length > 0) parts.push(shape);
          else shape.remove();
        }
        const vector = f.flatten(parts, node);
        vector.name = "Vector";
        vector.fills = [paint(Object.values(spec.colors)[0])];
        vector.strokes = [];
      }
      if (spec.scale) for (const shape of node.findAll(() => true)) if ("constraints" in shape) shape.constraints = { horizontal: "SCALE", vertical: "SCALE" };
    } else if (spec.type === "variants") {
      bindings = [];
      const parts = spec.children.map((child) => build(child, f.currentPage));
      node = f.combineAsVariants(parts, parent);
      setFill(node, spec);
      if (!spec.layout) {
        parts.forEach((part, i) => {
          part.x = spec.children[i].x || 0;
          part.y = spec.children[i].y || 0;
        });
      }
      const keys = {};
      const defaults = {};
      for (const prop of spec.props || []) {
        keys[prop.name] = node.addComponentProperty(prop.name, prop.type, propValue(prop.default));
        defaults[prop.name] = prop.default;
      }
      for (const { target, bind } of bindings) {
        if (bind.visible) target.visible = defaults[bind.visible];
        const refs = {};
        for (const [field, name] of Object.entries(bind)) refs[field] = keys[name];
        target.componentPropertyReferences = refs;
      }
    } else {
      node = spec.type === "component" ? f.createComponent() : f.createFrame();
      setFill(node, spec);
      node.clipsContent = Boolean(spec.clip);
    }
    if (spec.name) node.name = spec.name;
    if (spec.opacity !== undefined) node.opacity = spec.opacity;
    if (spec.stroke) {
      node.strokes = [paint(spec.stroke)];
      node.strokeWeight = spec.strokeWeight;
      node.strokeAlign = "OUTSIDE";
    }
    if (spec.bind) bindings.push({ target: node, bind: spec.bind });
    if (spec.effectStyle) effected.push({ node, name: spec.effectStyle });
    if (spec.type !== "variants") parent.appendChild(node);
    const onCanvas = parent.type === "PAGE" || parent.type === "SECTION";
    const inLayout = !onCanvas && parent.layoutMode !== "NONE";
    if (spec.type === "frame" || spec.type === "component" || spec.type === "variants") {
      if (spec.radius) node.cornerRadius = spec.radius;
      applyLayout(node, spec);
    }
    if (spec.type !== "variants") for (const child of spec.children || []) build(child, node);
    applySize(node, spec, inLayout);
    bindVars(node, spec);
    if (spec.type === "text" && spec.truncate) {
      node.textTruncation = "ENDING";
      node.maxLines = 1;
    }
    if (inLayout && spec.absolute) node.layoutPositioning = "ABSOLUTE";
    if (!inLayout || spec.absolute) {
      node.x = spec.x || 0;
      node.y = spec.y || 0;
    }
    return node;
  };

  const openSection = (page) => {
    if (!spec.section) return page;
    let section = page.children.find((n) => n.type === "SECTION" && n.name === spec.section.name);
    if (!section) {
      section = f.createSection();
      const made = section;
      undo.push(() => made.remove());
      page.appendChild(section);
      section.name = spec.section.name;
      section.fills = [];
      section.x = spec.section.x || 0;
      section.y = spec.section.y || 0;
    }
    return section;
  };

  // A section does not grow by itself, so it is cut to what it holds.
  const fitSection = (section) => {
    if (section.type !== "SECTION") return;
    const right = Math.max(...section.children.map((n) => n.x + n.width));
    const bottom = Math.max(...section.children.map((n) => n.y + n.height));
    section.resizeWithoutConstraints(right + 48, bottom + 48);
  };

  const openPage = async () => {
    const found = f.root.children.find((p) => bare(p.name) === bare(spec.page));
    if (found) {
      await found.loadAsync();
      return found;
    }
    // A new file has one empty page. Its name is the only thing to keep it for.
    const only = f.root.children.length === 1 ? f.root.children[0] : undefined;
    if (only) await only.loadAsync();
    if (only && only.children.length === 0) {
      const { name } = only;
      undo.push(() => {
        only.name = name;
      });
      only.name = spec.page;
      return only;
    }
    const page = f.createPage();
    undo.push(() => page.remove());
    page.name = spec.page;
    return page;
  };

  // planWrite holds the same search: a page function sees no other function.
  const staleNodes = (page, spec) => {
    const sections = page.children.filter((n) => n.type === "SECTION");
    const named = spec.section ? sections.filter((n) => n.name === spec.section.name) : sections;
    const pool = named.flatMap((n) => n.children).concat(spec.section ? [] : page.children);
    return pool.filter((old) => spec.nodes.some((n) => n.name === old.name && types[n.type] === old.type));
  };

  // The new nodes are built first and the old ones go last, so a build that
  // fails leaves the page as it was.
  const draw = async () => {
    const fonts = spec.nodes.reduce((all, node) => collectFonts(node, all), new Map());
    for (const font of fonts.values()) await f.loadFontAsync(font);
    if (spec.nodes.some(usesInstances)) await loadLibrary();
    if (spec.nodes.some(usesVars)) for (const v of await f.variables.getLocalVariablesAsync("FLOAT")) floats.set(v.name, v);
    if (spec.tokens) await writeTokens();
    const page = await openPage();
    await f.setCurrentPageAsync(page);
    const target = openSection(page);
    const before = new Set(target.children.map((n) => n.id));
    undo.push(() => {
      for (const node of [...target.children]) if (!before.has(node.id)) node.remove();
    });
    const stale = replace ? staleNodes(page, spec) : [];
    const staleIds = stale.map((n) => n.id);
    const created = spec.nodes.map((node) => build(node, target));
    if (styled.length > 0) {
      const styles = await f.getLocalTextStylesAsync();
      for (const { node, name } of styled) {
        const style = styles.find((s) => s.name === name);
        if (!style) throw new Error(`no text style named "${name}"`);
        await node.setTextStyleIdAsync(style.id);
      }
    }
    if (effected.length > 0) {
      const styles = await f.getLocalEffectStylesAsync();
      for (const { node, name } of effected) {
        const style = styles.find((s) => s.name === name);
        if (!style) throw new Error(`no effect style named "${name}"`);
        await node.setEffectStyleIdAsync(style.id);
      }
    }
    // An instance of an old variant moves to the new variant of the same name, with its property values, so a
    // redraw keeps every use. One whose variant is gone keeps the old main component, which counts as cut.
    let kept = 0;
    let cut = 0;
    for (const old of stale) {
      const fresh = created[spec.nodes.findIndex((n) => n.name === old.name && types[n.type] === old.type)];
      const parts = old.type === "COMPONENT_SET" ? old.children : old.type === "COMPONENT" ? [old] : [];
      for (const part of parts) {
        const next = fresh.type === "COMPONENT_SET" ? fresh.children.find((c) => c.name === part.name) : fresh.type === "COMPONENT" ? fresh : null;
        for (const instance of await part.getInstancesAsync()) {
          if (!next) {
            cut += 1;
            continue;
          }
          const values = {};
          for (const [key, prop] of Object.entries(instance.componentProperties || {})) if (prop.type !== "VARIANT") values[key.split("#")[0]] = prop;
          instance.swapComponent(next);
          undo.push(() => instance.swapComponent(part));
          const props = {};
          for (const key of Object.keys(instance.componentProperties || {})) {
            const name = key.split("#")[0];
            // A value moves only to a property of the same name and type.
            if (name in values && instance.componentProperties[key].type === values[name].type) props[key] = values[name].value;
          }
          if (Object.keys(props).length > 0) instance.setProperties(props);
          kept += 1;
        }
      }
    }
    for (const old of stale) old.remove();
    fitSection(target);
    return {
      page: page.name,
      tokens: variables.size,
      nodes: created.map((n) => ({ id: n.id, type: n.type, name: n.name, w: n.width, h: n.height, parts: n.findAll(() => true).length })),
      stale: staleIds,
      kept,
      cut,
    };
  };

  try {
    return await draw();
  } catch (error) {
    for (const step of undo.reverse()) step();
    throw error;
  }
}

// planWrite says what a write would remove or change, and changes nothing.
async function planWrite({ spec, replace, types }) {
  // A page may carry an emoji before its name ("🔘 Button"); a page is found by its name alone.
  const bare = (name) => String(name).replace(/^\p{Extended_Pictographic}[\uFE0F\u200D\p{Extended_Pictographic}]*\s+/u, "");
  const f = window.figma;
  const plan = { remove: [], tokens: [] };
  const page = f.root.children.find((p) => bare(p.name) === bare(spec.page));
  if (page && replace) {
    await page.loadAsync();
    // The same search as staleNodes: a page function sees no other function.
    const sections = page.children.filter((n) => n.type === "SECTION");
    const named = spec.section ? sections.filter((n) => n.name === spec.section.name) : sections;
    const pool = named.flatMap((n) => n.children).concat(spec.section ? [] : page.children);
    const stale = pool.filter((old) => spec.nodes.some((n) => n.name === old.name && types[n.type] === old.type));
    // An instance of a variant the new set keeps by name moves to it; the rest are cut.
    const count = async (node, spec) => {
      const parts = node.type === "COMPONENT_SET" ? node.children : node.type === "COMPONENT" ? [node] : [];
      const names = spec.type === "variants" ? (spec.children || []).map((c) => c.name) : [spec.name];
      let total = 0;
      let cut = 0;
      for (const part of parts) {
        const uses = (await part.getInstancesAsync()).length;
        total += uses;
        if (!names.includes(part.name)) cut += uses;
      }
      return { instances: total, cut };
    };
    for (const n of stale) plan.remove.push({ id: n.id, type: n.type, name: n.name, ...(await count(n, spec.nodes.find((s) => s.name === n.name && types[s.type] === n.type))) });
  }
  if (!spec.tokens) return plan;
  const collections = await f.variables.getLocalVariableCollectionsAsync();
  const collection = collections.find((c) => c.name === spec.tokens.collection);
  if (!collection) return plan;
  const hexOf = (c) =>
    "#" + [c.r, c.g, c.b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("");
  const mode = collection.modes[0].modeId;
  for (const variable of await f.variables.getLocalVariablesAsync("COLOR")) {
    const to = spec.tokens.colors[variable.name];
    if (variable.variableCollectionId !== collection.id || !to) continue;
    const from = hexOf(variable.valuesByMode[mode]);
    if (from !== to.toLowerCase()) plan.tokens.push({ name: variable.name, from, to });
  }
  return plan;
}

// savedState says what the file a tab loaded lacks, or nothing when it holds
// the write. Names would not do: a node of the same name may be the old one.
async function savedState({ page, nodes, stale }) {
  // A page may carry an emoji before its name ("🔘 Button"); a page is found by its name alone.
  const bare = (name) => String(name).replace(/^\p{Extended_Pictographic}[\uFE0F\u200D\p{Extended_Pictographic}]*\s+/u, "");
  const f = window.figma;
  await f.loadAllPagesAsync();
  for (const node of nodes) {
    const found = await f.getNodeByIdAsync(node.id);
    if (!found) return `node ${node.name} is missing`;
    const parts = found.findAll(() => true).length;
    if (parts !== node.parts) return `node ${node.name} has ${parts} parts of ${node.parts}`;
  }
  // The page's nodes decide this: Figma still answers by id for a removed node,
  // and without its removed flag (seen live, 2026-10-31).
  const target = f.root.children.find((p) => bare(p.name) === bare(page));
  const left = stale.length > 0 ? target.findOne((n) => stale.includes(n.id)) : null;
  if (left) return `old node ${left.id} is still there`;
  return "";
}

// A tab's editor can stop laying out auto layout while it still takes writes: a new frame then keeps its
// 100 by 100 default, and everything drawn saves unlaid. A hugging frame round a 7 by 5 child proves the
// layout runs; a reload brings it back.
async function layoutRuns(page) {
  return await page.evaluate(() => {
    const f = window.figma;
    const outer = f.createFrame();
    outer.layoutMode = "HORIZONTAL";
    outer.layoutSizingHorizontal = "HUG";
    outer.layoutSizingVertical = "HUG";
    const inner = f.createFrame();
    inner.resize(7, 5);
    outer.appendChild(inner);
    const runs = Math.round(outer.width) === 7 && Math.round(outer.height) === 5;
    outer.remove();
    return runs;
  });
}

async function ensureLayout(page) {
  if (await layoutRuns(page)) return;
  await page.goto(await page.url());
  await ready(page);
  if (!(await layoutRuns(page))) throw new Error("Figma's layout does not run in this tab, and figmacli could not bring it back: reload the file, then retry");
}

// proveSave asks Figma to save a version of the file, which resolves only once the server holds every change,
// then reads the write back in the same tab. It never reloads: a reload could drop changes still on their way.
// Only the save is tried again: the read-back is the tab's own state, which another try cannot change.
async function proveSave(task, page, state, arg) {
  let problem = "";
  for (let attempt = 0; attempt < SAVE_TRIES; attempt += 1) {
    problem = await page.evaluate(async (title) => {
      try {
        await window.figma.saveVersionHistoryAsync(title);
        return "";
      } catch (error) {
        return String((error && error.message) || error);
      }
    }, `figmacli ${INPUT.op}`);
    if (!problem) break;
    await page.waitForTimeout(SAVE_WAIT);
  }
  problem = problem || (await page.evaluate(state, arg));
  if (problem) throw new Error(`Figma did not save the write: ${problem}. Run figmacli read before you retry`);
}

async function write(task, page) {
  const drawn = await page.evaluate(drawSpec, { spec: INPUT.spec, replace: INPUT.replace, types: FIGMA_TYPES });
  await proveSave(task, page, savedState, { page: drawn.page, nodes: drawn.nodes, stale: drawn.stale });
  return { page: drawn.page, tokens: drawn.tokens, nodes: drawn.nodes, kept: drawn.kept, cut: drawn.cut, saved: true };
}

// pushTokens writes colours, numbers and styles, reusing each by name. With dry
// it only counts what would change.
async function pushTokens({ tokens, dry }) {
  const f = window.figma;
  const rgb = (value) => {
    const raw = value.replace("#", "");
    const full = raw.length === 3 ? [...raw].map((c) => c + c).join("") : raw;
    const part = (i) => parseInt(full.slice(i, i + 2), 16) / 255;
    return { r: part(0), g: part(2), b: part(4), a: full.length === 8 ? part(6) : 1 };
  };
  const hexOf = (c) => {
    const parts = [c.r, c.g, c.b].concat(c.a !== undefined && c.a < 1 ? [c.a] : []);
    return "#" + parts.map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("");
  };
  const out = { created: 0, changed: [], styles: 0, skipped: [], stale: [] };
  const collections = await f.variables.getLocalVariableCollectionsAsync();
  const openSet = (name, mode) => {
    let set = collections.find((c) => c.name === name);
    if (!set && !dry) {
      set = f.variables.createVariableCollection(name);
      collections.push(set);
      set.renameMode(set.modes[0].modeId, mode);
    }
    return set;
  };
  const existing = async (type) => f.variables.getLocalVariablesAsync(type);
  const colors = await existing("COLOR");
  for (const group of tokens.colors) {
    const set = openSet(group.name, group.mode);
    const mode = set ? set.modes[0].modeId : "";
    const held = new Map(set ? colors.filter((v) => v.variableCollectionId === set.id).map((v) => [v.name, v]) : []);
    const entries = Object.entries(group.colors);
    const fresh = new Set();
    for (const [name] of entries) {
      if (held.has(name)) continue;
      out.created += 1;
      fresh.add(name);
      if (!dry) held.set(name, f.variables.createVariable(name, set, "COLOR"));
    }
    const note = (name, old, to) => {
      if (!fresh.has(name)) out.changed.push({ name: `${group.name}/${name}`, from: old && old.r !== undefined ? hexOf(old) : "alias", to, id: held.get(name).id });
    };
    // A variable of the set that the file no longer holds: listed, never deleted (alpha variables follow their base).
    for (const name of held.keys()) if (!(name in group.colors) && !name.startsWith("alpha/")) out.stale.push(`${group.name}/${name}`);
    for (const [name, value] of entries) {
      const variable = held.get(name);
      if (!variable) continue;
      const old = variable.valuesByMode[mode];
      if (value.startsWith("{")) {
        const target = held.get(value.slice(1, -1));
        if (!target) {
          if (!(value.slice(1, -1) in group.colors)) out.skipped.push(`${group.name}/${name}: ${value} has no target`);
          continue;
        }
        if (!(old && old.type === "VARIABLE_ALIAS" && old.id === target.id)) {
          note(name, old, value);
          if (!dry) variable.setValueForMode(mode, f.variables.createVariableAlias(target));
        }
        continue;
      }
      if (!old || old.type === "VARIABLE_ALIAS" || hexOf(old) !== hexOf(rgb(value))) {
        note(name, old, value);
        if (!dry) variable.setValueForMode(mode, rgb(value));
      }
    }
  }
  // An alpha variable holds a copy of its base, so it follows here.
  if (!dry) {
    const all = await existing("COLOR");
    for (const group of tokens.colors) {
      const set = collections.find((c) => c.name === group.name);
      const mode = set.modes[0].modeId;
      const inSet = all.filter((v) => v.variableCollectionId === set.id);
      for (const variable of inSet) {
        const match = variable.name.match(/^alpha\/(.+)@(\d+)$/);
        const base = match && inSet.find((v) => v.name === match[1]);
        if (!base) continue;
        let value = base.valuesByMode[mode];
        while (value && value.type === "VARIABLE_ALIAS") value = (await f.variables.getVariableByIdAsync(value.id)).valuesByMode[mode];
        if (!value) continue;
        const faded = { r: value.r, g: value.g, b: value.b, a: (value.a === undefined ? 1 : value.a) * (Number(match[2]) / 100) };
        const old = variable.valuesByMode[mode];
        if (hexOf(old) !== hexOf(faded)) {
          out.changed.push({ name: `${group.name}/${variable.name}`, from: hexOf(old), to: hexOf(faded) });
          variable.setValueForMode(mode, faded);
        }
      }
    }
  }
  const sizes = openSet("Ace Size", "Value");
  const numbers = await existing("FLOAT");
  const sizeMode = sizes ? sizes.modes[0].modeId : "";
  for (const [name, value] of Object.entries(tokens.numbers || {})) {
    let variable = sizes ? numbers.find((v) => v.name === name && v.variableCollectionId === sizes.id) : undefined;
    if (!variable) {
      out.created += 1;
      if (dry) continue;
      variable = f.variables.createVariable(name, sizes, "FLOAT");
    } else if (Math.abs(variable.valuesByMode[sizeMode] - value) < 0.0001) continue;
    else out.changed.push({ name: `Ace Size/${name}`, from: String(variable.valuesByMode[sizeMode]), to: String(value), id: variable.id });
    if (!dry) variable.setValueForMode(sizeMode, value);
  }
  if (sizes) {
    const wanted = tokens.numbers || {};
    for (const v of numbers) if (v.variableCollectionId === sizes.id && !(v.name in wanted)) out.stale.push(`Ace Size/${v.name}`);
  }
  // The re-layout check: how many nodes are bound to each changed variable, and on which pages.
  const ids = new Map(out.changed.filter((c) => c.id).map((c) => [c.id, c]));
  if (ids.size) {
    await f.loadAllPagesAsync();
    const users = new Map([...ids.keys()].map((id) => [id, { count: 0, pages: new Map() }]));
    for (const pg of f.root.children) {
      for (const node of pg.findAll(() => true)) {
        const bound = node.boundVariables;
        if (!bound) continue;
        const found = new Set(JSON.stringify(bound).match(/VariableID:[0-9:]+/g) || []);
        for (const id of found) {
          const use = users.get(id);
          if (!use) continue;
          use.count += 1;
          use.pages.set(pg.name, (use.pages.get(pg.name) || 0) + 1);
        }
      }
    }
    for (const change of out.changed) {
      const use = change.id && users.get(change.id);
      change.bound = use ? use.count : 0;
      change.pages = use ? [...use.pages].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([name, n]) => `${name} ${n}`).join("; ") : "";
      delete change.id;
    }
  }
  const textStyles = await f.getLocalTextStylesAsync();
  const textWords = (s) => `${s.family} ${s.style} ${s.size}/${Math.round(s.lineHeight * 100) / 100}`;
  for (const style of tokens.text || []) {
    let local = textStyles.find((s) => s.name === style.name);
    if (local) {
      const was = { family: local.fontName.family, style: local.fontName.style, size: local.fontSize, lineHeight: local.lineHeight.value };
      if (textWords(was) !== textWords(style)) out.changed.push({ name: style.name, from: textWords(was), to: textWords(style) });
    }
    if (dry) {
      out.styles += local ? 0 : 1;
      continue;
    }
    const font = { family: style.family, style: style.style };
    try {
      await f.loadFontAsync(font);
    } catch {
      out.skipped.push(`${style.name}: Figma has no font ${style.family} ${style.style}`);
      continue;
    }
    if (!local) {
      local = f.createTextStyle();
      local.name = style.name;
      out.styles += 1;
    }
    local.fontName = font;
    local.fontSize = style.size;
    local.lineHeight = { unit: "PIXELS", value: style.lineHeight };
    local.letterSpacing = { unit: "PERCENT", value: style.letterPercent || 0 };
  }
  const effectStyles = await f.getLocalEffectStylesAsync();
  for (const style of tokens.effects || []) {
    let local = effectStyles.find((s) => s.name === style.name);
    if (dry) {
      out.styles += local ? 0 : 1;
      continue;
    }
    if (!local) {
      local = f.createEffectStyle();
      local.name = style.name;
      out.styles += 1;
    }
    local.effects = style.layers.map((l) => ({
      type: "DROP_SHADOW", visible: true, blendMode: "NORMAL", radius: l.blur, spread: l.spread,
      offset: { x: l.x, y: l.y }, color: { r: l.r, g: l.g, b: l.b, a: l.opacity },
    }));
  }
  return out;
}

// tokensSaved reads every colour that holds a value, plus the counts of what else
// the push wrote.
async function tokensSaved({ tokens }) {
  const f = window.figma;
  const collections = await f.variables.getLocalVariableCollectionsAsync();
  const colors = await f.variables.getLocalVariablesAsync("COLOR");
  const near = (a, b) => Math.abs(a - b) < 0.01;
  for (const group of tokens.colors) {
    const set = collections.find((c) => c.name === group.name);
    if (!set) return `collection ${group.name} is missing`;
    for (const [name, value] of Object.entries(group.colors)) {
      const variable = colors.find((v) => v.name === name && v.variableCollectionId === set.id);
      if (!variable) return `${group.name}/${name} is missing`;
      if (value.startsWith("{")) continue;
      const held = variable.valuesByMode[set.modes[0].modeId];
      const raw = value.replace("#", "");
      const full = raw.length === 3 ? [...raw].map((c) => c + c).join("") : raw;
      const part = (i) => parseInt(full.slice(i, i + 2), 16) / 255;
      const want = [part(0), part(2), part(4), full.length === 8 ? part(6) : 1];
      const have = [held.r, held.g, held.b, held.a === undefined ? 1 : held.a];
      if (!want.every((v, i) => near(v, have[i]))) return `${group.name}/${name} holds another value`;
    }
  }
  const numbers = await f.variables.getLocalVariablesAsync("FLOAT");
  const lost = Object.keys(tokens.numbers || {}).find((name) => !numbers.some((v) => v.name === name));
  if (lost) return `number ${lost} is missing`;
  const text = await f.getLocalTextStylesAsync();
  const missing = (tokens.text || []).find((s) => !text.some((t) => t.name === s.name));
  return missing ? `text style ${missing.name} is missing` : "";
}

async function arrangeFile({ rename, order, moves, sections, names }) {
  // A page may carry an emoji before its name ("🔘 Button"); a page is found by its name alone.
  const bare = (name) => String(name).replace(/^\p{Extended_Pictographic}[\uFE0F\u200D\p{Extended_Pictographic}]*\s+/u, "");
  const f = window.figma;
  await f.loadAllPagesAsync();
  // No order given: the pages keep the order they have (after the renames).
  if (!order || order.length === 0) order = f.root.children.map((p) => (rename || []).find((r) => bare(r.from) === bare(p.name))?.to || p.name);
  // Every name resolves before anything changes, so a bad spec changes nothing.
  const pageNames = new Set(f.root.children.map((p) => bare(p.name)));
  for (const { from, to } of rename || []) {
    if (!pageNames.has(bare(from)) && !pageNames.has(bare(to))) throw new Error(`no page named "${from}"`);
    pageNames.delete(bare(from));
    pageNames.add(bare(to));
  }
  const candidates = (name, id) => {
    const found = [];
    const same = (n) => (id ? n.id === id : n.name === name);
    for (const page of f.root.children) {
      for (const child of page.children) {
        if (child.type === "SECTION") found.push(...child.children.filter(same));
        else if (same(child)) found.push(child);
      }
    }
    return found;
  };
  const resolved = (moves || []).map((move) => {
    if (!order.map(bare).includes(bare(move.page)) && !pageNames.has(bare(move.page))) throw new Error(`no page named "${move.page}"`);
    // A node id ("271:40911") names exactly one node; a name may name several.
    const byId = /^\d+:\d+$/.test(move.node) ? candidates(null, move.node) : [];
    const found = byId.length ? byId : candidates(move.node);
    if (found.length === 0) throw new Error(`no node named "${move.node}"`);
    if (found.length > 1) throw new Error(`${found.length} nodes are named "${move.node}"`);
    return { move, node: found[0] };
  });
  // A node's new name: by node id, or by a name that names one node.
  const renamed = (names || []).map(({ node, name }) => {
    const byId = /^\d+:\d+$/.test(node) ? candidates(null, node) : [];
    const found = byId.length ? byId : candidates(node);
    if (found.length === 0) throw new Error(`no node named "${node}"`);
    if (found.length > 1) throw new Error(`${found.length} nodes are named "${node}"`);
    return { target: found[0], name };
  });
  for (const place of sections || []) {
    const held = f.root.children.some((p) => [p.name, ...(rename || []).filter((r) => bare(r.from) === bare(p.name)).map((r) => r.to)].map(bare).includes(bare(place.page)) &&
      p.children.some((n) => n.type === "SECTION" && n.name === place.name));
    const made = (moves || []).some((m) => bare(m.page) === bare(place.page) && m.section === place.name);
    if (!held && !made) throw new Error(`no section "${place.name}" on page "${place.page}"`);
  }
  for (const { from, to } of rename || []) {
    const page = f.root.children.find((p) => bare(p.name) === bare(from));
    if (page) page.name = to;
  }
  order.forEach((name, index) => {
    let page = f.root.children.find((p) => bare(p.name) === bare(name));
    if (!page) {
      page = f.createPage();
      page.name = name;
    }
    f.root.insertChild(index, page);
  });
  for (const { target, name } of renamed) target.name = name;
  const touched = new Set();
  for (const { move, node } of resolved) {
    const page = f.root.children.find((p) => bare(p.name) === bare(move.page));
    let section = page.children.find((n) => n.type === "SECTION" && n.name === move.section);
    if (!section) {
      section = f.createSection();
      page.appendChild(section);
      section.name = move.section;
      section.fills = [];
    }
    const from = node.parent;
    if (from !== section) section.appendChild(node);
    node.x = move.x;
    node.y = move.y;
    touched.add(section);
    if (from.type === "SECTION" && from !== section && from.children.length === 0) {
      touched.delete(from);
      from.remove();
    }
  }
  for (const section of touched) {
    const right = Math.max(...section.children.map((n) => n.x + n.width));
    const bottom = Math.max(...section.children.map((n) => n.y + n.height));
    section.resizeWithoutConstraints(right + 48, bottom + 48);
  }
  for (const place of sections || []) {
    const page = f.root.children.find((p) => bare(p.name) === bare(place.page));
    const section = page && page.children.find((n) => n.type === "SECTION" && n.name === place.name);
    if (!section) throw new Error(`no section "${place.name}" on page "${place.page}"`);
    section.x = place.x;
    section.y = place.y;
  }
  return f.root.children.map((p) => ({ id: p.id, name: p.name, nodes: p.children.length }));
}

async function arrangedState({ order, moves, sections }) {
  // A page may carry an emoji before its name ("🔘 Button"); a page is found by its name alone.
  const bare = (name) => String(name).replace(/^\p{Extended_Pictographic}[\uFE0F\u200D\p{Extended_Pictographic}]*\s+/u, "");
  const f = window.figma;
  await f.loadAllPagesAsync();
  order = order || [];
  const names = f.root.children.map((p) => p.name);
  if (!order.every((name, index) => bare(names[index]) === bare(name))) return `the pages read ${names.join(", ")}`;
  for (const move of moves || []) {
    const page = f.root.children.find((p) => bare(p.name) === bare(move.page));
    const section = page.children.find((n) => n.type === "SECTION" && n.name === move.section);
    // A move names its node by id or by name; a node keeps its id when it moves to another page.
    if (!section || !section.children.some((n) => n.id === move.node || n.name === move.node)) return `${move.node} is not in ${move.section}`;
  }
  for (const place of sections || []) {
    const page = f.root.children.find((p) => bare(p.name) === bare(place.page));
    const section = page.children.find((n) => n.type === "SECTION" && n.name === place.name);
    if (!section || section.x !== place.x || section.y !== place.y) return `section ${place.name} is not in its place`;
  }
  return "";
}

// labelSet lays a component set out and writes what each variant is, as text
// beside it. It only moves and renames variants, so instances stay linked. Text
// cannot live inside a set, so the labels stand in the section, over the set.
async function labelSet(spec) {
  // A page may carry an emoji before its name ("🔘 Button"); a page is found by its name alone.
  const bare = (name) => String(name).replace(/^\p{Extended_Pictographic}[\uFE0F\u200D\p{Extended_Pictographic}]*\s+/u, "");
  const f = window.figma;
  await f.loadAllPagesAsync();
  const page = f.root.children.find((p) => bare(p.name) === bare(spec.page));
  if (!page) throw new Error(`no page named "${spec.page}"`);
  const section = page.children.find((n) => n.type === "SECTION" && n.name === spec.section);
  if (!section) throw new Error(`no section named "${spec.section}" on page "${spec.page}"`);
  const set = section.children.find((n) => n.type === "COMPONENT_SET" && n.name === spec.set);
  if (!set) throw new Error(`no component set named "${spec.set}" in section "${spec.section}"`);
  const collections = await f.variables.getLocalVariableCollectionsAsync();
  const collection = collections.find((c) => c.name === spec.collection);
  if (!collection) throw new Error(`no collection named "${spec.collection}"`);
  const colors = await f.variables.getLocalVariablesAsync("COLOR");
  const muted = colors.find((v) => v.name === "muted" && v.variableCollectionId === collection.id);
  if (!muted) throw new Error(`collection "${collection.name}" has no colour "muted"`);
  const style = (await f.getLocalTextStylesAsync()).find((s) => s.name === "Ace/App/app-xs");
  if (!style) throw new Error('no text style named "Ace/App/app-xs"');
  await f.loadFontAsync(style.fontName);
  await f.setCurrentPageAsync(page);

  // The plan comes first: nothing below this block fails on a bad set or spec.
  const parse = (name) => name.split(", ").map((part) => part.split("="));
  const words = (pairs) => pairs.map(([k, v]) => `${k}=${v}`).join(", ");
  const plans = set.children.map((part) => {
    const pairs = parse(part.name);
    if (words(pairs) !== part.name || pairs.some((p) => p.length !== 2)) {
      throw new Error(`variant "${part.name}" holds a comma or an equals sign in a value, so label cannot read it`);
    }
    const renamed = pairs.map(([k, v]) => {
      const key = (spec.rename || {})[k] || k;
      return [key, (spec.values || {})[`${key}=${v}`] || v];
    });
    return { part, pairs: renamed, name: words(renamed), props: Object.fromEntries(renamed), x: 0, y: 0 };
  });
  if (new Set(plans.map((p) => p.name)).size !== plans.length) throw new Error("two variants would get one name");
  const labels = [];
  const label = (text, x, y) => labels.push({ text, x, y });
  const margin = 24;
  const distinct = (key) => [...new Set(plans.map((p) => p.props[key]))];
  const put = (plan, x, y) => {
    plan.x = x;
    plan.y = y;
  };
  if (spec.mode === "grid") {
    const named = [spec.rows, spec.cols, spec.blocks].filter(Boolean);
    const props = Object.keys(plans[0].props);
    for (const key of [...props, ...named]) {
      if (!named.includes(key)) throw new Error(`property "${key}" has no place in the grid`);
      if (!props.includes(key)) throw new Error(`the set has no property "${key}"`);
    }
    const cells = new Set(plans.map((p) => named.map((k) => p.props[k]).join("\u0000")));
    if (cells.size !== plans.length) throw new Error("two variants fall in one cell of the grid");
    const left = margin + spec.left;
    let y = margin;
    for (const block of spec.blocks ? distinct(spec.blocks) : [""]) {
      const inBlock = plans.filter((p) => !spec.blocks || p.props[spec.blocks] === block);
      if (spec.blocks) {
        label(`${spec.blocks}: ${block}`, margin, y);
        y += 24;
      }
      distinct(spec.cols).forEach((col, i) => label(`${spec.cols}: ${col}`, left + i * spec.colWidth, y));
      y += 22;
      for (const row of distinct(spec.rows)) {
        const inRow = inBlock.filter((p) => p.props[spec.rows] === row);
        if (inRow.length === 0) continue;
        const height = Math.max(...inRow.map((p) => p.part.height));
        label(`${spec.rows}: ${row}`, margin, y + (height - 16) / 2);
        for (const cell of inRow) put(cell, left + distinct(spec.cols).indexOf(cell.props[spec.cols]) * spec.colWidth, y);
        y += height + 12;
      }
      y += 20;
    }
  } else {
    const heights = new Array(spec.columns).fill(margin);
    for (const plan of plans) {
      const column = heights.indexOf(Math.min(...heights));
      const x = margin + column * spec.colWidth;
      label(plan.pairs.map(([k, v]) => `${k}: ${v}`).join("  ·  "), x, heights[column]);
      put(plan, x, heights[column] + 20);
      heights[column] += 20 + plan.part.height + 24;
    }
  }
  const right = Math.max(...plans.map((p) => p.x + p.part.width));
  const bottom = Math.max(...plans.map((p) => p.y + p.part.height));

  // New captions come before any change to the set, and old ones go last, so a
  // failure leaves the set and its old captions as they were.
  const prefix = `Label/${spec.set}/`;
  const mine = (n) => n.name.startsWith(prefix) && !n.name.slice(prefix.length).includes("/");
  const old = section.children.filter(mine);
  const made = [];
  try {
    for (const item of labels) {
      const text = f.createText();
      made.push(text);
      section.appendChild(text);
      text.fontName = style.fontName;
      text.characters = item.text;
      await text.setTextStyleIdAsync(style.id);
      text.fills = [f.variables.setBoundVariableForPaint({ type: "SOLID", color: { r: 0, g: 0, b: 0 } }, "color", muted)];
      text.name = `${prefix}${item.text}`;
      text.x = spec.x + item.x;
      text.y = spec.y + item.y;
    }
  } catch (error) {
    for (const text of made) text.remove();
    throw error;
  }
  set.layoutMode = "NONE";
  for (const plan of plans) {
    plan.part.name = plan.name;
    plan.part.x = plan.x;
    plan.part.y = plan.y;
  }
  set.resizeWithoutConstraints(Math.max(right + margin, spec.minWidth || 0), bottom + margin);
  set.x = spec.x;
  set.y = spec.y;
  for (const text of old) text.remove();
  const edge = Math.max(...section.children.map((n) => n.x + n.width));
  const foot = Math.max(...section.children.map((n) => n.y + n.height));
  section.resizeWithoutConstraints(edge + 48, foot + 48);
  return { set: set.name, variants: plans.length, labels: labels.length, w: set.width, h: set.height, names: plans.map((p) => p.name) };
}

async function labelsSaved({ page, section, prefix, count, setName, names }) {
  // A page may carry an emoji before its name ("🔘 Button"); a page is found by its name alone.
  const bare = (name) => String(name).replace(/^\p{Extended_Pictographic}[\uFE0F\u200D\p{Extended_Pictographic}]*\s+/u, "");
  const f = window.figma;
  await f.loadAllPagesAsync();
  const target = f.root.children.find((p) => bare(p.name) === bare(page));
  const holder = target && target.children.find((n) => n.type === "SECTION" && n.name === section);
  if (!holder) return `section ${section} is missing`;
  const found = holder.children.filter((n) => n.name.startsWith(prefix) && !n.name.slice(prefix.length).includes("/")).length;
  if (found !== count) return `${found} labels of ${count}`;
  const set = holder.children.find((n) => n.type === "COMPONENT_SET" && n.name === setName);
  const held = set ? set.children.map((n) => n.name) : [];
  const lost = names.find((name) => !held.includes(name));
  return lost ? `variant ${lost} is missing` : "";
}

// layGrid lays a mockup section out as a grid that reads at a glance: one frame
// per row, so Figma shows one name for the row and hides its cells' names; each
// column the same variant in every row, at one x; and the column names once, in
// a header frame above the first row. It moves cells and draws no instance, so
// instances stay linked. A rerun reuses the row frames and replaces the header.
async function layGrid(spec) {
  // A page may carry an emoji before its name ("🔘 Button"); a page is found by its name alone.
  const bare = (name) => String(name).replace(/^\p{Extended_Pictographic}[\uFE0F\u200D\p{Extended_Pictographic}]*\s+/u, "");
  const f = window.figma;
  await f.loadAllPagesAsync();
  const page = f.root.children.find((p) => bare(p.name) === bare(spec.page));
  if (!page) throw new Error(`no page named "${spec.page}"`);
  const section = page.children.find((n) => n.type === "SECTION" && n.name === spec.section);
  if (!section) throw new Error(`no section named "${spec.section}" on page "${spec.page}"`);
  // A cell can move only out of the section or a frame: not out of an instance or a set.
  const movable = (node) => {
    for (let at = node.parent; at; at = at.parent) {
      if (at === section) return true;
      if (["INSTANCE", "COMPONENT", "COMPONENT_SET"].includes(at.type)) return false;
    }
    return false;
  };
  const find = async (id) => {
    const node = await f.getNodeByIdAsync(id);
    if (!node || !node.parent || !movable(node)) throw new Error(`node ${id} is not a node the grid can move in section "${spec.section}"`);
    return node;
  };
  // Every node resolves and the whole plan holds before anything changes, so a bad spec changes nothing.
  const rows = [];
  for (const row of spec.rows) rows.push({ name: row.name, cells: await Promise.all(row.cells.map((id) => (id ? find(id) : null))) });
  const below = await Promise.all((spec.below || []).map(find));
  const placed = [...rows.flatMap((r) => r.cells.filter(Boolean)), ...below];
  for (const node of placed) {
    for (let at = node.parent; at !== section; at = at.parent) {
      if (placed.includes(at)) throw new Error(`node ${node.id} is inside node ${at.id}, which the grid also moves`);
    }
  }
  for (const row of rows) {
    if (!row.cells.some(Boolean)) throw new Error(`row ${row.name} has no cell`);
    row.frame = section.children.find((n) => n.type === "FRAME" && n.name === row.name) || null;
    if (row.frame && placed.includes(row.frame)) throw new Error(`row ${row.name} has the name of a node the grid moves`);
    const stray = row.frame && row.frame.children.find((n) => !placed.includes(n));
    if (stray) throw new Error(`frame ${row.name} holds ${stray.name}, which the grid does not name`);
  }
  const collections = await f.variables.getLocalVariableCollectionsAsync();
  const collection = collections.find((c) => c.name === spec.collection);
  if (!collection) throw new Error(`no collection named "${spec.collection}"`);
  const muted = (await f.variables.getLocalVariablesAsync("COLOR")).find((v) => v.name === "muted" && v.variableCollectionId === collection.id);
  if (!muted) throw new Error(`collection "${collection.name}" has no colour "muted"`);
  const style = (await f.getLocalTextStylesAsync()).find((s) => s.name === "Ace/App/app-xs");
  if (!style) throw new Error('no text style named "Ace/App/app-xs"');
  await f.loadFontAsync(style.fontName);
  await f.setCurrentPageAsync(page);

  const gap = spec.gap || 48; // 0 is "not given" on the Go side
  const margin = 48;
  const widths = spec.columns.map((_, c) => Math.max(...rows.map((r) => (r.cells[c] ? r.cells[c].width : 0))));
  const xs = widths.map((_, c) => widths.slice(0, c).reduce((sum, w) => sum + w + gap, 0));
  const blank = (frame, name) => {
    frame.name = name;
    frame.fills = [];
    frame.clipsContent = false;
    frame.layoutMode = "NONE";
    return frame;
  };

  // The new header comes first; the old one goes last, so a failure keeps the old one.
  const headName = "Label/Grid/columns";
  const oldHeads = section.children.filter((n) => n.name === headName);
  const head = blank(f.createFrame(), headName);
  section.appendChild(head);
  try {
    for (const [c, name] of spec.columns.entries()) {
      const text = f.createText();
      head.appendChild(text);
      text.fontName = style.fontName;
      text.characters = name;
      await text.setTextStyleIdAsync(style.id);
      text.fills = [f.variables.setBoundVariableForPaint({ type: "SOLID", color: { r: 0, g: 0, b: 0 } }, "color", muted)];
      text.name = `Label/Grid/${name}`;
      text.x = xs[c];
      text.y = 0;
    }
  } catch (error) {
    head.remove();
    throw error;
  }
  head.resizeWithoutConstraints(xs[xs.length - 1] + widths[widths.length - 1], 20);
  head.x = margin;
  head.y = margin;

  const emptied = new Set();
  const take = (node, parent, x, y) => {
    if (node.parent !== parent) {
      if (node.parent !== section) emptied.add(node.parent);
      parent.appendChild(node);
    }
    node.x = x;
    node.y = y;
  };
  let y = margin + 28;
  for (const row of rows) {
    let frame = row.frame;
    if (!frame) {
      frame = f.createFrame();
      section.appendChild(frame);
    }
    blank(frame, row.name);
    row.cells.forEach((cell, c) => cell && take(cell, frame, xs[c], 0));
    const height = Math.max(...row.cells.filter(Boolean).map((cell) => cell.height));
    frame.resizeWithoutConstraints(Math.max(...row.cells.map((cell, c) => (cell ? xs[c] + cell.width : 0))), height);
    frame.x = margin;
    frame.y = y;
    y += height + gap;
  }
  for (const node of below) {
    take(node, section, margin, y);
    y += node.height + gap;
  }
  for (const old of oldHeads) old.remove();
  // A frame that only held cells, such as the row frame of a row that has a new name, goes.
  for (const old of emptied) {
    if (old.parent === section && old.type === "FRAME" && old.children.length === 0 && !rows.some((r) => r.name === old.name)) old.remove();
  }
  const right = Math.max(...section.children.map((n) => n.x + n.width));
  const bottom = Math.max(...section.children.map((n) => n.y + n.height));
  section.resizeWithoutConstraints(right + margin, bottom + margin);
  return { rows: rows.length, columns: spec.columns.length, cells: rows.reduce((sum, r) => sum + r.cells.filter(Boolean).length, 0), w: section.width, h: section.height };
}

// gridSaved checks that each row frame holds its cells and the header has every column.
async function gridSaved(spec) {
  // A page may carry an emoji before its name ("🔘 Button"); a page is found by its name alone.
  const bare = (name) => String(name).replace(/^\p{Extended_Pictographic}[\uFE0F\u200D\p{Extended_Pictographic}]*\s+/u, "");
  const f = window.figma;
  await f.loadAllPagesAsync();
  const page = f.root.children.find((p) => bare(p.name) === bare(spec.page));
  const section = page && page.children.find((n) => n.type === "SECTION" && n.name === spec.section);
  if (!section) return `section ${spec.section} is missing`;
  const head = section.children.filter((n) => n.name === "Label/Grid/columns");
  if (head.length !== 1 || head[0].children.length !== spec.columns.length) return "the column header is not as written";
  for (const row of spec.rows) {
    const frame = section.children.find((n) => n.type === "FRAME" && n.name === row.name);
    if (!frame) return `row ${row.name} is missing`;
    const missing = row.cells.find((id) => id && !frame.children.some((n) => n.id === id));
    if (missing) return `node ${missing} is not in row ${row.name}`;
  }
  return "";
}

// checkPage walks a page. What lies inside an instance comes from its component,
// so an instance counts only for the overrides it holds. A frame named "NEW ..."
// is a shape a mockup invented, so it may hold anything; it only adds to the count.
async function checkPage({ page, shapes }) {
  // A page may carry an emoji before its name ("🔘 Button"); a page is found by its name alone.
  const bare = (name) => String(name).replace(/^\p{Extended_Pictographic}[\uFE0F\u200D\p{Extended_Pictographic}]*\s+/u, "");
  const f = window.figma;
  await f.loadAllPagesAsync();
  // A page of its own, or every page but the dividers and Archive, which keeps old work as it was.
  const targets = page === "all" ? f.root.children.filter((p) => bare(p.name) !== "Archive" && !/^-+$/.test(bare(p.name)) && p.children.length > 0) : [f.root.children.find((p) => bare(p.name) === bare(page))];
  if (!targets[0]) throw new Error(`no page named "${page}"`);
  const out = { page, instances: 0, new: 0, findings: [] };
  const report = (kind, node, path) => out.findings.push({ kind, id: node.id, name: node.name, path });
  const handSet = (paint) => {
    if (paint.visible === false) return false;
    if (paint.type === "SOLID") return !(paint.boundVariables && paint.boundVariables.color);
    if (paint.type.startsWith("GRADIENT")) return !paint.gradientStops.every((stop) => stop.boundVariables && stop.boundVariables.color);
    return false;
  };
  const painted = (paints, style) => Array.isArray(paints) && !style && paints.some(handSet);
  const hasHandPaint = (node) => painted(node.fills, node.fillStyleId) || painted(node.strokes, node.strokeStyleId);
  const VECTORS = ["VECTOR", "RECTANGLE", "ELLIPSE", "LINE", "POLYGON", "STAR", "BOOLEAN_OPERATION"];
  // The base sets: a variant's fixed width or height that a size token holds must be bound to it, so a token change
  // reaches every use. A size no token holds, such as a code constant, stays a number.
  const SIZED = ["Button", "Icon button", "Icon", "Mark"];
  // A size token can hold an alias of another number: follow it to the value.
  const valueOf = async (value, depth = 0) => {
    if (!value || value.type !== "VARIABLE_ALIAS" || depth > 8) return value;
    const next = await f.variables.getVariableByIdAsync(value.id);
    return next ? valueOf(Object.values(next.valuesByMode)[0], depth + 1) : undefined;
  };
  const sizes = (await f.variables.getLocalVariablesAsync("FLOAT")).filter((v) => v.name.startsWith("ui/size/"));
  const held = new Set(await Promise.all(sizes.map((v) => valueOf(Object.values(v.valuesByMode)[0]))));
  const base = (name) => name.replace(/ Light$/, "");
  const instances = [];
  // A caption that `label` or `grid` wrote is named Label/... and takes a bound colour.
  const caption = (node) => node.name.startsWith("Label/") && node.fills.length > 0 && !hasHandPaint(node);
  const walk = (node, path, ctx) => {
    const here = path ? `${path} / ${node.name}` : node.name;
    if (node.name.startsWith("NEW ")) {
      out.new += 1;
      return;
    }
    if (node.type === "INSTANCE") {
      out.instances += 1;
      instances.push({ node, here });
      return;
    }
    if (node.detachedInfo) {
      report("detached", node, here);
      return;
    }
    let set = ctx.set;
    if (node.type === "COMPONENT_SET") set = base(node.name);
    if (node.type === "COMPONENT" && node.parent.type !== "COMPONENT_SET") set = base(node.name);
    if (node.type === "COMPONENT" && SIZED.includes(set)) {
      const fixed = (axis) => node[axis === "width" ? "layoutSizingHorizontal" : "layoutSizingVertical"] === "FIXED" || !node.layoutMode || node.layoutMode === "NONE";
      for (const axis of ["width", "height"]) if (fixed(axis) && held.has(node[axis]) && !(node.boundVariables && node.boundVariables[axis])) report("unbound size", node, `${here} (${axis} ${Math.round(node[axis])})`);
    }
    if (VECTORS.includes(node.type)) {
      if (!set || !shapes.includes(set)) report("stray vector", node, here);
    } else if (node.type === "TEXT" && ctx.strict && !set && !caption(node)) {
      report("loose text", node, here);
    }
    // A section's background only groups a canvas; it is not part of a design.
    if (node.type !== "SECTION" && hasHandPaint(node) && !(VECTORS.includes(node.type) && set && shapes.includes(set) && ctx.page === "Foundations")) report("hand-set colour", node, here);
    if ("children" in node) for (const child of node.children) walk(child, here, { ...ctx, set });
  };
  for (const target of targets) {
    await target.loadAsync();
    // A task's own mockups page, named with its key ("ACE-436 Errors"), is as strict as Mockups.
    const strict = ["Mockups", "Patterns"].includes(bare(target.name)) || /^[A-Z]+-\d+ /.test(bare(target.name));
    for (const child of target.children) walk(child, page === "all" ? target.name : "", { set: null, strict, page: target.name });
  }
  // A set or lone component whose name another page holds too: a write that names it cannot tell which (ACE-1136).
  const holders = new Map();
  for (const p of f.root.children) {
    const name = bare(p.name);
    if (name === "Archive" || /^-+$/.test(name)) continue;
    const visit = (node) => {
      if (node.name.startsWith("NEW ")) return;
      if (node.type === "COMPONENT_SET" || (node.type === "COMPONENT" && node.parent.type !== "COMPONENT_SET")) {
        holders.set(node.name, [...(holders.get(node.name) || []), { node, page: name }]);
        return;
      }
      if ("children" in node && node.type !== "INSTANCE") for (const child of node.children) visit(child);
    };
    for (const child of p.children) visit(child);
  }
  for (const target of targets) {
    for (const held of holders.values()) {
      for (const { node, page: on } of held) {
        if (on !== bare(target.name)) continue;
        const others = held.filter((h) => h.page !== on);
        if (others.length === 0) continue;
        const where = others.map((h) => `${h.page}, ${h.node.id}`).join("; ");
        report("duplicate name", node, `${page === "all" ? on + " / " : ""}${node.name} (also on ${where})`);
      }
    }
  }
  for (const { node, here } of instances) {
    const own = (node.overrides || []).find((o) => o.id === node.id);
    if (own && own.overriddenFields.some((field) => field === "fills" || field === "strokes") && hasHandPaint(node)) report("hand-set colour", node, here);
    for (const { id, overriddenFields } of node.overrides || []) {
      if (id === node.id || !overriddenFields.some((field) => field === "fills" || field === "strokes")) continue;
      const inner = await f.getNodeByIdAsync(id);
      if (inner && hasHandPaint(inner)) report("hand-set colour", inner, `${here} / ${inner.name}`);
    }
  }
  return out;
}

async function rename(page) {
  await openFile(page, INPUT.key);
  const res = await page.fetch(`/api/files/${INPUT.key}`, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-csrf-bypass": "yes" },
    body: JSON.stringify({ name: INPUT.name }),
    timeout: 15000,
  });
  if (res.status !== 200) throw new Error(`Figma answered HTTP ${res.status} to the rename`);
  return { name: (await metadata(page, INPUT.key)).name };
}

async function tokens(task, page) {
  const result = await page.evaluate(pushTokens, { tokens: INPUT.tokens, dry: Boolean(INPUT.dry) });
  if (INPUT.dry) return result;
  await proveSave(task, page, tokensSaved, { tokens: INPUT.tokens });
  return { ...result, saved: true };
}

// swapInstances moves each instance of a mapped variant of `from` to the variant of `to` with the mapped and kept values.
async function swapInstances({ from, to, map, keep, dry }) {
  const f = window.figma;
  await f.loadAllPagesAsync();
  const sets = f.root.findAllWithCriteria({ types: ["COMPONENT_SET"] });
  const out = { moved: 0, missing: [], swapped: [] };
  // Every pick is made before any instance moves, so a target it cannot pick alone stops the swap whole.
  const plan = [];
  for (const suffix of ["", " Light"]) {
    const source = sets.find((s) => s.name === from + suffix);
    if (!source) continue;
    const target = sets.find((s) => s.name === to + suffix);
    if (!target) throw new Error(`no set named "${to + suffix}"`);
    for (const variant of source.children) {
      const props = variant.variantProperties || {};
      if (!Object.entries(map).every(([key, values]) => props[key] in values)) continue;
      const want = {};
      for (const key of keep) want[key] = props[key];
      for (const [key, values] of Object.entries(map)) want[key] = values[props[key]];
      const matches = target.children.filter((c) => Object.entries(want).every(([k, v]) => (c.variantProperties || {})[k] === v));
      if (matches.length > 1) throw new Error(`${source.name} ${variant.name} matches ${matches.length} variants of ${target.name}: name one more property in keep`);
      const instances = await variant.getInstancesAsync();
      if (matches.length === 0) {
        if (instances.length > 0) out.missing.push(`${source.name} ${variant.name}`);
        continue;
      }
      plan.push({ variant, next: matches[0], instances });
    }
  }
  for (const { variant, next, instances } of plan) {
    if (!dry) for (const instance of instances) instance.swapComponent(next);
    out.moved += instances.length;
    out.swapped.push(variant.id);
  }
  return out;
}

// swappedState says which swapped variant still has instances, or nothing. A variant with no target keeps its
// instances by design, so only the ones the swap moved count.
async function swappedState({ ids }) {
  const f = window.figma;
  for (const id of ids) {
    const variant = await f.getNodeByIdAsync(id);
    if (variant && (await variant.getInstancesAsync()).length > 0) return `${variant.parent.name} ${variant.name} still has instances`;
  }
  return "";
}

async function swap(task, page) {
  const { swapped, ...result } = await page.evaluate(swapInstances, { ...INPUT.swap, dry: Boolean(INPUT.dry) });
  if (INPUT.dry || result.moved === 0) return { ...result, saved: !INPUT.dry };
  await proveSave(task, page, swappedState, { ids: swapped });
  return { ...result, saved: true };
}

async function arrange(task, page) {
  const pages = await page.evaluate(arrangeFile, INPUT.arrange);
  await proveSave(task, page, arrangedState, INPUT.arrange);
  return { pages, saved: true };
}

async function label(task, page) {
  const result = await page.evaluate(labelSet, INPUT.label);
  const { page: name, section } = INPUT.label;
  const { names, ...summary } = result;
  await proveSave(task, page, labelsSaved, { page: name, section, prefix: `Label/${INPUT.label.set}/`, count: result.labels, setName: INPUT.label.set, names });
  return { ...summary, saved: true };
}

async function grid(task, page) {
  const result = await page.evaluate(layGrid, INPUT.grid);
  await proveSave(task, page, gridSaved, INPUT.grid);
  return { ...result, saved: true };
}

async function run(task, page) {
  if (INPUT.op === "doctor") {
    await onFigma(page);
    const res = await page.fetch("/api/user/state", { timeout: 15000 });
    if (res.status !== 200) throw new Error("not signed in");
    return { signed_in: true, tabs: await figmaTabs(task) };
  }
  if (INPUT.op === "rename") return await rename(page);
  const kind = await openFile(page, INPUT.key);
  const meta = await metadata(page, INPUT.key);
  if (INPUT.op === "file") {
    const pages = kind === "design" ? await page.evaluate(listPages) : [];
    return { key: INPUT.key, name: meta.name, kind, can_edit: meta.can_edit, url: await page.url(), pages };
  }
  requireDesign(kind);
  if (INPUT.op === "eval") return await evalInPage(page);
  if (INPUT.op === "pages") return { pages: await page.evaluate(listPages) };
  if (INPUT.op === "read") return await page.evaluate(readTree, { page: INPUT.page, depth: INPUT.depth });
  if (INPUT.op === "export") return await page.evaluate(exportNode, { node: INPUT.node, scale: INPUT.scale });
  if (INPUT.op === "check") return await page.evaluate(checkPage, { page: INPUT.page, shapes: INPUT.shapes || ["Icon", "Mark"] });
  if (["plan", "write", "tokens", "arrange", "label", "swap", "grid"].includes(INPUT.op)) {
    if (!meta.can_edit) throw new Error("this account cannot edit the file");
  }
  // The probe draws a frame and removes it: only the ops that lay out, in a file this account may edit.
  if (["write", "label", "swap"].includes(INPUT.op)) await ensureLayout(page);
  if (INPUT.op === "tokens") return await tokens(task, page);
  if (INPUT.op === "arrange") return await arrange(task, page);
  if (INPUT.op === "swap") return await swap(task, page);
  if (INPUT.op === "label") return await label(task, page);
  if (INPUT.op === "grid") return await grid(task, page);
  if (INPUT.op === "plan") {
    return await page.evaluate(planWrite, { spec: INPUT.spec, replace: INPUT.replace, types: FIGMA_TYPES });
  }
  if (INPUT.op === "write") return await write(task, page);
  throw new Error(`unknown op ${INPUT.op}`);
}

try {
  if (INPUT.op === "close") emit(await closeSpace());
  else {
    const task = await space();
    emit(await run(task, await firstPage(task)));
  }
} catch (error) {
  emit({ error: String((error && error.message) || error) });
}
