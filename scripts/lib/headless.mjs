/**
 * headless.mjs — a tiny, dependency-free headless-browser driver.
 *
 * The smoke suite is an HTTP sweep: it proves a rule is *served*, never that it
 * *applies*. That gap is exactly where T8's bug lived — the phone override was
 * present and correct in the stylesheet and still lost the cascade, so the field
 * stayed 112px on a 390px phone with no other symptom. This module closes it by
 * measuring the laid-out page in a real browser.
 *
 * It adds NO dependency and does NOT touch package.json. It drives whatever
 * Chrome/Edge is already installed over the DevTools Protocol, using two
 * globals Bun (and Node 22+) already ship: `fetch` and `WebSocket`.
 *
 * Flow: launch the browser on an ephemeral debugging port → read the port from
 * its own DevToolsActivePort file → open a target → attach (flattened) → send
 * Page/Runtime/Emulation/Network commands scoped to that session.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Candidate browser executables, most-preferred first. SMOKE_BROWSER wins. */
function candidates() {
  const pf = process.env["ProgramFiles"] || "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const local = process.env.LOCALAPPDATA || "";
  return [
    process.env.SMOKE_BROWSER,
    join(pf, "Google", "Chrome", "Application", "chrome.exe"),
    join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
    local && join(local, "Google", "Chrome", "Application", "chrome.exe"),
    join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
    join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter(Boolean);
}

/** The first installed browser we know how to drive, or null. */
export function findBrowser() {
  for (const p of candidates()) {
    try {
      if (existsSync(p)) return p;
    } catch {
      /* unusable candidate — keep looking */
    }
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A promise-based client for one CDP websocket (browser- or page-level). */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || "CDP error"));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.listeners.get(msg.method) || []) fn(msg.params, msg.sessionId);
      }
    });
  }

  send(method, params, sessionId) {
    const id = ++this.seq;
    const payload = { id, method, params: params || {} };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  /** Resolve on the next `method` event (optionally only for `sessionId`). */
  once(method, sessionId, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), timeoutMs);
      const fn = (params, sid) => {
        if (sessionId && sid !== sessionId) return;
        clearTimeout(timer);
        resolve(params);
      };
      const arr = this.listeners.get(method) || [];
      arr.push(fn);
      this.listeners.set(method, arr);
    });
  }
}

/** One attached page: viewport, cookies, navigation and measurement. */
class Page {
  constructor(conn, sessionId) {
    this.conn = conn;
    this.sessionId = sessionId;
  }

  send(method, params) {
    return this.conn.send(method, params, this.sessionId);
  }

  /** Emulate a viewport. `mobile: true` also switches on the mobile layout. */
  async setViewport({ width, height, mobile }) {
    await this.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: !!mobile,
    });
  }

  /** Set a host-only cookie for `url` (the login cookie the HTTP sweep uses). */
  async setCookie({ name, value, url }) {
    await this.send("Network.setCookie", { name, value, url, path: "/" });
  }

  /**
   * Inject `source` into every document before any page script runs, and return
   * its identifier so it can be removed again. This is how a check renders a
   * data-driven screen without writing a row: stub `fetch` for one endpoint
   * and the page lays out the payload as if the server had sent it.
   */
  async addInitScript(source) {
    const { identifier } = await this.send("Page.addScriptToEvaluateOnNewDocument", { source });
    return identifier;
  }

  /** Remove a script installed by addInitScript (future navigations only). */
  async removeInitScript(identifier) {
    await this.send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
  }

  /** Navigate and wait for the load event. */
  async goto(url) {
    const loaded = this.conn.once("Page.loadEventFired", this.sessionId);
    await this.send("Page.navigate", { url });
    return loaded;
  }

  /** Evaluate an expression in the page and return its value. */
  async evaluate(expression) {
    const res = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text || "evaluate threw");
    }
    return res.result?.value;
  }

  /** Poll a truthy expression until it holds (or time out). */
  async waitFor(expression, timeoutMs = 10000, intervalMs = 100) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      try {
        if (await this.evaluate(`!!(${expression})`)) return true;
      } catch {
        /* page mid-navigation — try again */
      }
      await sleep(intervalMs);
    }
    return false;
  }
}

/** A launched browser plus its control connection. */
class Browser {
  constructor(proc, conn, ws, dir) {
    this.proc = proc;
    this.conn = conn;
    this.ws = ws;
    this.dir = dir;
  }

  async newPage() {
    const { targetId } = await this.conn.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await this.conn.send("Target.attachToTarget", { targetId, flatten: true });
    const page = new Page(this.conn, sessionId);
    await page.send("Page.enable");
    await page.send("Runtime.enable");
    await page.send("Network.enable");
    return page;
  }

  async close() {
    try {
      await this.conn.send("Browser.close");
    } catch {
      /* already gone */
    }
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }

    // Wait for the process to REALLY exit before touching its profile dir. On
    // Windows the browser keeps the profile locked for a moment after
    // Browser.close, and a remove that races it throws — which used to leave a
    // temp dir behind on every run. So: wait, escalate to kill, wait again.
    const exited = async (ms) => {
      const end = Date.now() + ms;
      while (Date.now() < end && this.proc && this.proc.exitCode === null) await sleep(100);
      return !this.proc || this.proc.exitCode !== null;
    };
    if (!(await exited(3000))) {
      try {
        this.proc.kill();
      } catch {
        /* ignore */
      }
      await exited(2000);
    }

    for (let i = 0; i < 3; i++) {
      try {
        await rm(this.dir, { recursive: true, force: true });
        return;
      } catch {
        await sleep(150);
      }
    }
  }
}

/** Try one launch with a given headless flag; returns the browser or null. */
async function attempt(exe, headlessFlag) {
  const dir = await mkdtemp(join(tmpdir(), "ss-headless-"));
  const args = [
    headlessFlag,
    "--disable-gpu",
    "--no-sandbox",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-sync",
    "--hide-scrollbars",
    "--remote-debugging-port=0",
    `--user-data-dir=${dir}`,
    "about:blank",
  ];
  const proc = spawn(exe, args, { stdio: ["ignore", "ignore", "ignore"], windowsHide: true });

  // The browser writes the ephemeral port and its websocket path here once the
  // DevTools endpoint is up — no fixed port, so concurrent runs cannot collide.
  const portFile = join(dir, "DevToolsActivePort");
  const deadline = Date.now() + 20000;
  let port = 0;
  let wsPath = "";
  while (Date.now() < deadline) {
    try {
      const txt = await readFile(portFile, "utf8");
      const [p, w] = txt.split("\n");
      if (p && w) {
        port = Number(p);
        wsPath = w.trim();
        break;
      }
    } catch {
      /* not written yet */
    }
    if (proc.exitCode !== null) break; // the browser died — stop waiting
    await sleep(150);
  }
  if (!port || !wsPath) {
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    return null;
  }

  const ws = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`);
  const conn = new Cdp(ws);
  const opened = new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", () => reject(new Error("CDP websocket failed")));
  });
  try {
    await Promise.race([opened, sleep(10000).then(() => Promise.reject(new Error("CDP connect timed out")))]);
  } catch {
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    return null;
  }
  return new Browser(proc, conn, ws, dir);
}

/**
 * Launch a headless browser, or return null when none can be driven (no binary
 * found, all launch attempts failed). Never throws — a caller should skip.
 * `--headless=new` is tried first, then the older `--headless` for old builds.
 */
export async function launch() {
  const exe = findBrowser();
  if (!exe) return null;
  for (const flag of ["--headless=new", "--headless"]) {
    const browser = await attempt(exe, flag);
    if (browser) return browser;
  }
  return null;
}

export { sleep };
