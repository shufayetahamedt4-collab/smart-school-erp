/**
 * hostfetch.mjs — make `Host:` actually arrive at the server.
 *
 * The verify/smoke suites reach the app's sector apps by asking for a subdomain
 * host while connecting to loopback: `fetch("http://127.0.0.1:3000/parent")` with
 * `headers: { Host: "school.localhost:3000" }`. That never worked. `Host` is a
 * **forbidden header name** in the Fetch standard, so undici (Node's fetch)
 * silently drops it: the request arrived as `127.0.0.1:3000`, `resolveSector()`
 * returned null and the host-agnostic **hub** answered instead. Every
 * host-scoped check therefore ran against the hub — the one host that is
 * deliberately permissive — and passed without ever exercising sector routing.
 *
 * `installHostFetch()` replaces `globalThis.fetch` with a shim that behaves like
 * fetch for every request **except** one that carries a `Host` header: those are
 * sent with `node:http`, which has no forbidden-header list, so the hostname the
 * caller asked for really is the hostname the server sees. Everything else
 * (method, body, headers, cookies, redirect mode, response status/headers/body)
 * is preserved, and the response is a real `Response`.
 *
 * Scope: request *delivery* only. No assertion, expectation or fixture changed.
 *
 * Usage (once, before the first request):
 *   import { installHostFetch } from "./lib/hostfetch.mjs";
 *   installHostFetch();
 */
import http from "node:http";
import https from "node:https";

const INSTALLED = Symbol.for("smart-school-erp.hostfetch");
const REAL_FETCH = globalThis.fetch;
const MAX_REDIRECTS = 20;
/** Statuses a Response may not carry a body for. */
const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);
/** Methods that turn into GET after a 301/302/303. */
const REDIRECT_TO_GET = new Set([301, 302, 303]);

/** Read one header out of Headers | array | plain object, case-insensitively. */
function readHeader(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name);
  const want = name.toLowerCase();
  const entries = Array.isArray(headers) ? headers : Object.entries(headers);
  for (const [k, v] of entries) {
    if (String(k).toLowerCase() === want) return Array.isArray(v) ? v.join(", ") : v;
  }
  return null;
}

/** Collect any accepted header shape into a lowercase-keyed plain object. */
function toPlainHeaders(headers) {
  const out = {};
  if (!headers) return out;
  const entries = typeof headers.entries === "function" ? [...headers.entries()] : Array.isArray(headers) ? headers : Object.entries(headers);
  for (const [k, v] of entries) {
    if (v === undefined || v === null) continue;
    out[String(k).toLowerCase()] = Array.isArray(v) ? v.map(String) : String(v);
  }
  return out;
}

/** The URL of whatever fetch was handed (string | URL | Request). */
function urlOf(input) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  if (input && typeof input.url === "string") return input.url;
  throw new TypeError("hostfetch: unsupported request input");
}

/** Body bytes for node:http, or null. Only the shapes the suites actually send. */
function bodyBuffer(body) {
  if (body === undefined || body === null) return null;
  if (typeof body === "string") return Buffer.from(body, "utf8");
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  return null;
}

/**
 * A hostname that, on a dev machine, means "this same server" — the suites ask
 * for `school.localhost`, `parents.localhost`, … while connecting to loopback.
 * Those are the only hosts a follow can safely keep pointing at the local port.
 */
function isLocalSiblingHost(hostname) {
  const h = String(hostname || "").toLowerCase();
  return h === "localhost" || h.endsWith(".localhost") || h === "127.0.0.1" || h === "::1";
}

/**
 * Perform one request over node:http(s), delivering `hostOverride` as the Host
 * header while connecting to the URL's own address.
 */
function requestOnce(urlString, { method, headers, hostOverride, body, signal }) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const lib = url.protocol === "https:" ? https : http;
    const headersOut = { ...headers, host: hostOverride || url.host };
    const payload = bodyBuffer(body);

    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method,
        headers: headersOut,
        // The connection target may be a loopback IP while Host says otherwise,
        // so never let a proxy env var redirect this: it is a local call.
        setHost: false,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode || 0,
            statusText: res.statusMessage || "",
            rawHeaders: res.headers,
            buffer: Buffer.concat(chunks),
          });
        });
      }
    );

    req.on("error", reject);

    if (signal) {
      const onAbort = () => {
        const err = new Error("The operation was aborted.");
        err.name = "AbortError";
        req.destroy(err);
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
      req.on("close", () => signal.removeEventListener("abort", onAbort));
    }

    if (payload && method !== "GET" && method !== "HEAD") {
      if (headersOut["content-length"] === undefined) headersOut["content-length"] = payload.length;
      req.end(payload);
    } else {
      req.end();
    }
  });
}

/** Turn a node:http result into a real Response, set-cookie and all. */
function toResponse(result) {
  const headers = new Headers();
  for (const [k, v] of Object.entries(result.rawHeaders)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const one of v) headers.append(k, String(one));
    else headers.set(k, String(v));
  }
  const status = result.status;
  const body = NULL_BODY_STATUS.has(status) ? null : result.buffer;
  return new Response(body, { status, statusText: result.statusText, headers });
}

/**
 * Install the shim. Idempotent: repeated calls (one per script) are no-ops.
 * Returns the fetch function now installed.
 */
export function installHostFetch({ quiet = false } = {}) {
  if (globalThis[INSTALLED]) return globalThis.fetch;
  globalThis[INSTALLED] = true;

  globalThis.fetch = async (input, init = {}) => {
    const headers = init.headers ?? (typeof input === "object" && input !== null ? input.headers : undefined);
    const hostOverride = readHeader(headers, "host");
    // Anything without an explicit Host is left to the real fetch, untouched.
    if (!hostOverride) return REAL_FETCH(input, init);

    const startUrl = urlOf(input);
    const mode = init.redirect || "follow";
    const headersPlain = toPlainHeaders(headers);
    delete headersPlain.host;

    let url = startUrl;
    let method = String(init.method || (typeof input === "object" && input.method) || "GET").toUpperCase();
    let body = init.body ?? null;
    // The caller's Host applies to the first hop; a follow updates it (see below).
    let useHost = hostOverride;

    for (let hop = 0; ; hop++) {
      const target = new URL(url);
      // Keep connecting where the caller pointed the request at: those .localhost
      // names are how the suites name a sector app on the local dev server.
      const connectUrl = isLocalSiblingHost(target.hostname)
        ? `${new URL(startUrl).protocol}//${new URL(startUrl).host}${target.pathname}${target.search}`
        : url;

      const result = await requestOnce(connectUrl, {
        method,
        headers: headersPlain,
        hostOverride: useHost,
        body,
        signal: init.signal,
      });

      const location = result.rawHeaders.location;
      const isRedirect = result.status >= 300 && result.status < 400 && location;
      if (!isRedirect || mode === "manual" || hop >= MAX_REDIRECTS) {
        if (mode === "error" && isRedirect) throw new TypeError("hostfetch: redirect mode is set to error");
        return toResponse(result);
      }

      // Follow, the way fetch would.
      const next = new URL(location, url);
      // A redirect to the very same authority keeps the caller's Host override; a
      // redirect to another `<app>.localhost` becomes a request for that app; a
      // redirect anywhere else speaks for itself.
      if (next.host !== target.host) useHost = isLocalSiblingHost(next.hostname) ? next.host : null;
      if (REDIRECT_TO_GET.has(result.status) && method !== "GET" && method !== "HEAD") {
        method = "GET";
        body = null;
        delete headersPlain["content-type"];
        delete headersPlain["content-length"];
      }
      url = next.href;
    }
  };

  if (!quiet) {
    // One line, on stderr, so it never lands in a suite's parsed stdout.
    process.stderr.write("[hostfetch] Host header delivery enabled (requests with Host: go through node:http)\n");
  }
  return globalThis.fetch;
}
