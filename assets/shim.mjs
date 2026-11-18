// The desktop transport: the page API figma.mjs expects, over CDP to the real Figma app. The app runs with
// --remote-debugging-pipe under a holder that relays the pipe on a unix socket, one JSON message a line; the
// holder sends every reply and event to every client, so each call takes an id of its own.
//
// The app's tabs are Alex's: this shim never opens, reloads by itself, or closes one. A run works in the tab
// that already holds the file; a run for a file no tab holds stops and says so.
import { createConnection as figmacliDesktopConnect } from "node:net";

// Everything else stays in this block, so no name meets one of the page script.
{

const SOCKET_PATH = SOCKET;
const POLL = 250;
const socket = figmacliDesktopConnect(SOCKET_PATH);
const pending = new Map();
const listeners = [];
let buffer = "";
// Chromium reads an id as a 32-bit int and drops a call whose id is larger, with no reply to match.
let next = 100000000 + Math.floor(Math.random() * 1.8e9);
const KEY = INPUT.key || "";

socket.setEncoding("utf8");
socket.on("data", (chunk) => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, end).trim();
    buffer = buffer.slice(end + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.id !== undefined && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message || JSON.stringify(message.error)));
      else resolve(message.result || {});
    } else if (message.method) {
      for (const listener of listeners) listener(message);
    }
  }
});
await new Promise((resolve, reject) => {
  socket.once("connect", resolve);
  socket.once("error", (error) => reject(new Error(`the Figma app's CDP holder does not answer at ${SOCKET_PATH}: ${error.message}`)));
});
// A holder that goes away ends every call at once, not at its time limit.
const hangUp = () => {
  for (const { reject } of pending.values()) reject(new Error("the Figma app's CDP holder closed the connection"));
  pending.clear();
};
socket.on("close", hangUp);
socket.on("error", hangUp);

function send(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    next += 1;
    const id = next;
    // A page expression can be a whole write that takes minutes: only Go's limit on the run stops it.
    const timer = method === "Runtime.evaluate" ? undefined : setTimeout(() => {
      pending.delete(id);
      reject(new Error(`the Figma app did not answer ${method} within ${CALL_LIMIT / 1000} s`));
    }, CALL_LIMIT);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
    socket.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\n");
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// fileKey is the file a Figma URL holds: a branch path (/design/MAIN/branch/KEY) holds the branch.
const fileKey = (url) => {
  try {
    const parts = new URL(url).pathname.split("/");
    return parts[3] === "branch" ? parts[4] || "" : parts[2] || "";
  } catch {
    return "";
  }
};
const onFigmaFile = (url, key) => /^https:\/\/www\.figma\.com\/(design|file)\//.test(url) && (!key || fileKey(url) === key);
// Each page expression first checks that the tab still holds the file: the user can switch it mid-run.
const guarded = (expression) =>
  KEY
    ? `(() => { const p = location.pathname.split("/"); if ((p[3] === "branch" ? p[4] : p[2]) !== ${JSON.stringify(KEY)}) throw new Error("the Figma app tab left file " + ${JSON.stringify(KEY)} + " during the run"); return ${expression}; })()`
    : expression;

async function attach() {
  const { targetInfos = [] } = await send("Target.getTargets", {});
  const pages = targetInfos.filter((t) => t.type === "page");
  const target = pages.find((t) => onFigmaFile(t.url, KEY)) || (KEY ? null : pages.find((t) => t.url.startsWith("https://www.figma.com/")));
  if (!target) throw new Error(`no tab of the Figma app holds file ${KEY}: open it in the app, then retry`);
  const { sessionId } = await send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
  await send("Page.enable", {}, sessionId);
  return sessionId;
}

async function makePage() {
  const sessionId = await attach();
  let dialog = null;
  listeners.push((message) => {
    if (message.sessionId !== sessionId) return;
    if (message.method === "Page.javascriptDialogOpening") dialog = message.params;
    if (message.method === "Page.javascriptDialogClosed") dialog = null;
  });
  const evaluate = async (fn, arg) => {
    const expression = typeof fn === "function" ? `(${fn.toString()})(${arg === undefined ? "" : JSON.stringify(arg)})` : String(fn);
    const answer = await send("Runtime.evaluate", { expression: guarded(expression), awaitPromise: true, returnByValue: true }, sessionId);
    if (answer.exceptionDetails) {
      const details = answer.exceptionDetails;
      // An Error carries a description; a plain value, as Figma's plugin API rejects with, carries only its value.
      const thrown = details.exception || {};
      const value = thrown.value === undefined ? "" : typeof thrown.value === "string" ? thrown.value : JSON.stringify(thrown.value);
      throw new Error(thrown.description || (value && `${details.text || "the page threw"}: ${value}`) || details.text || "the page threw");
    }
    return answer.result ? answer.result.value : undefined;
  };
  return {
    url: () => evaluate("location.href"),
    evaluate,
    async waitForFunction(fn, arg, options = {}) {
      const stop = Date.now() + (options.timeout || 30000);
      for (;;) {
        const value = await evaluate(fn, arg);
        if (value) return value;
        if (Date.now() > stop) throw new Error("timed out waiting for the page");
        await sleep(POLL);
      }
    },
    waitForTimeout: (ms) => sleep(ms),
    // The tab is the user's: goto stays when the tab holds that file already, and moves it never.
    async goto(url) {
      const target = new URL(url, "https://www.figma.com/").href;
      if (fileKey(target) && fileKey(target) === fileKey(await evaluate("location.href"))) return;
      throw new Error(`the desktop transport moves no tab of the Figma app: open ${target} in the app, then retry`);
    },
    async fetch(url, options = {}) {
      return await evaluate(
        async ({ url, method, headers, body }) => {
          const res = await fetch(url, { method: method || "GET", headers: headers || {}, body, credentials: "include" });
          return { status: res.status, body: await res.text() };
        },
        { url, method: options.method, headers: options.headers, body: options.body },
      );
    },
    info: async () => (dialog ? { dialog } : {}),
    async dismissDialog() {
      await send("Page.handleJavaScriptDialog", { accept: false }, sessionId);
      dialog = null;
    },
    // The app's tabs belong to its user: a run never closes one.
    async close() {},
    cdp: (method, params = {}) => send(method, params, sessionId),
    sessionId,
  };
}

const page = await makePage();
const task = {
  pages: async () => [page],
  async newPage() {
    throw new Error("the desktop transport opens no tab: open the file in the Figma app");
  },
  cdp: (method, params = {}) => send(method, params),
  // Closing would quit the user's app: an idle close does nothing here.
  async finish() {},
};
globalThis.listTaskSpaces = async () => [];
globalThis.taskSpace = async () => task;
globalThis.claimTaskSpace = async () => task;
globalThis.takeOverTaskSpace = async () => task;
globalThis.endDesktop = async () => {
  await send("Target.detachFromTarget", { sessionId: page.sessionId }).catch(() => {});
  socket.end();
};
}
