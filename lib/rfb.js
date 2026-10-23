/**
 * RFB 3.8 client over WebSocket (websockify), mirroring the original
 * `tools/vnclib.py` behaviour: negotiate Raw encoding only, keep one
 * connection alive, and turn input into pointer/key events.
 *
 * The transport is Node's built-in `WebSocket` (undici), so the plugin needs no
 * npm dependency. websockify relays the server's TCP stream in chunks, so this
 * client reassembles RFB messages from arbitrarily sized WebSocket messages.
 */
import { vncAuthResponse } from "./des.js";
import { connect as netConnect } from "node:net";

const SPECIAL_KEYS = {
  enter: 0xff0d,
  return: 0xff0d,
  tab: 0xff09,
  esc: 0xff1b,
  escape: 0xff1b,
  backspace: 0xff08,
  delete: 0xffff,
  home: 0xff50,
  end: 0xff57,
  left: 0xff51,
  up: 0xff52,
  right: 0xff53,
  down: 0xff54,
  pageup: 0xff55,
  pagedown: 0xff56,
  insert: 0xff63,
  ctrl: 0xffe3,
  control: 0xffe3,
  alt: 0xffe9,
  shift: 0xffe1,
  super: 0xffeb,
  win: 0xffeb,
  space: 0x20,
  f1: 0xffbe,
  f2: 0xffbf,
  f3: 0xffc0,
  f4: 0xffc1,
  f5: 0xffc2,
  f6: 0xffc3,
  f7: 0xffc4,
  f8: 0xffc5,
  f9: 0xffc6,
  f10: 0xffc7,
  f11: 0xffc8,
  f12: 0xffc9,
};

/** The lab VM endpoint changes per experiment session; parse it from whatever the user copied. */
export function parseVncEndpoint(input, defaults = {}) {
  const fallback = {
    host: defaults.host ?? "",
    port: defaults.port ?? 30505,
    path: defaults.path ?? "/websockify",
  };
  if (typeof input !== "string" || input.trim().length === 0) return null;
  let raw = input.trim();
  if (/^\d{2,5}$/.test(raw)) return { host: fallback.host, port: Number(raw), path: fallback.path, source: "port" };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `http://${raw}`;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new RfbError(`cannot parse the VNC endpoint from "${input}"`);
  }
  const secure = url.protocol === "https:" || url.protocol === "wss:";
  const port = Number(url.port || (secure ? 443 : 80));
  const isWebSocket = url.protocol === "ws:" || url.protocol === "wss:";
  const path = isWebSocket ? (url.pathname === "" ? fallback.path : url.pathname) : fallback.path;
  return { host: url.hostname, port, path, source: "url" };
}

/** Recognize a Sangfor web-VPN gateway host, which Node cannot authenticate to on its own. */
export function isVpnGatewayHost(host) {
  return /\.vpn\.[a-z0-9.-]+$/i.test(host) || /^\d+-\d+-\d+-\d+-\d+-p\./i.test(host);
}

/** One TCP reachability probe used by endpoint discovery. */
function probePort(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = netConnect({ host, port });
    let settled = false;
    const finish = (reachable) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

/** Run `worker` over `items` with a bounded number of concurrent tasks, preserving order. */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

/** Turn a transport failure into an actionable message (changing port, VPN mode, bad password). */
function connectionError(error, host, port) {
  const base = error instanceof Error && error.message.length > 0 ? error.message : String(error);
  let hint = "";
  if (isVpnGatewayHost(host)) {
    hint = " — this is a Sangfor web-VPN gateway address, and the gateway redirects unauthenticated clients to the login page; Node cannot open the VNC WebSocket through it. Use an L3 VPN client so the VM's internal IP is routable, or drive the VM through the browser with lab_platform.";
  } else if (/timed out|cannot connect|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|network error|non-101/i.test(base)) {
    hint = ` — ${host}:${port} is not reachable: the USTS VPN (L3 tunnel) is probably not connected, or the lab VM is not started. The VM port changes per session: pass the current internal URL as lab_session.url instead of relying on the default port.`;
  } else if (/authentication failed|security result/i.test(base)) {
    hint = " — the VNC password was rejected; check the lab's VNC password (the platform URL's vncpassword may be a decoy).";
  }
  return new RfbError(`${base}${hint}`, { cause: error });
}

/** RFB protocol or transport failure. */
export class RfbError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "RfbError";
  }
}

/** A receive deadline expired while waiting for server data. */
export class RfbTimeoutError extends RfbError {
  constructor(message) {
    super(message);
    this.name = "RfbTimeoutError";
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Byte-exact receive buffer over one WebSocket, with per-read deadlines.
 * A timed-out read rejects only its own waiter; bytes that arrive later stay
 * buffered for the next read.
 */
class WsTransport {
  #socket;
  #buffer = Buffer.alloc(0);
  #waiters = [];
  #failure = null;

  constructor(socket) {
    this.#socket = socket;
    socket.binaryType = "arraybuffer";
    socket.addEventListener("message", (event) => {
      const data = event.data;
      if (typeof data === "string") this.#push(Buffer.from(data, "latin1"));
      else if (data instanceof ArrayBuffer) this.#push(Buffer.from(data));
      else if (ArrayBuffer.isView(data)) this.#push(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
      else if (data && typeof data.arrayBuffer === "function") {
        data.arrayBuffer().then((buffer) => this.#push(Buffer.from(buffer)), (error) => this.#fail(error));
      }
    });
    socket.addEventListener("close", () => this.#fail(new RfbError("VNC connection closed by the server")));
    socket.addEventListener("error", (event) => {
      const reason = event?.error?.message ?? event?.message ?? "handshake rejected (HTTP non-101, or the gateway redirected to a login page)";
      this.#fail(new RfbError(`VNC WebSocket error: ${reason}`));
    });
  }

  static async open(url, protocols, timeoutMs) {
    const socket = new WebSocket(url, protocols);
    const transport = new WsTransport(socket);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        try {
          socket.close();
        } catch {
          /* ignore */
        }
        reject(new RfbError(`timed out after ${timeoutMs} ms connecting to ${url}`));
      }, timeoutMs);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      socket.addEventListener("error", (event) => {
        clearTimeout(timer);
        reject(new RfbError(`cannot connect to ${url}: ${event?.error?.message ?? "handshake rejected (HTTP non-101, or a login redirect)"}`, {
          cause: event?.error,
        }));
      }, { once: true });
    });
    return transport;
  }

  #push(chunk) {
    if (chunk.length === 0) return;
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    this.#pump();
  }

  #fail(error) {
    if (this.#failure === null) this.#failure = error;
    for (const waiter of this.#waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(this.#failure);
    }
  }

  #pump() {
    while (this.#waiters.length > 0) {
      const waiter = this.#waiters[0];
      if (this.#buffer.length < waiter.length) break;
      this.#waiters.shift();
      clearTimeout(waiter.timer);
      const chunk = this.#buffer.subarray(0, waiter.length);
      this.#buffer = this.#buffer.subarray(waiter.length);
      waiter.resolve(Buffer.from(chunk));
    }
  }

  /** Resolve with exactly `length` bytes or reject with RfbTimeoutError. */
  recv(length, timeoutMs) {
    if (this.#failure !== null) return Promise.reject(this.#failure);
    return new Promise((resolve, reject) => {
      const waiter = { length, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) this.#waiters.splice(index, 1);
        reject(new RfbTimeoutError(`timed out after ${timeoutMs} ms waiting for ${length} byte(s) from the VNC server`));
      }, Math.max(1, timeoutMs));
      this.#waiters.push(waiter);
      this.#pump();
    });
  }

  send(bytes) {
    if (this.#failure !== null) throw this.#failure;
    this.#socket.send(bytes);
  }

  close() {
    try {
      this.#socket.close();
    } catch {
      /* already closing */
    }
  }
}

/** One RFB 3.8 session with a pixel format of 32bpp true colour, Raw encoding. */
export class RfbClient {
  constructor(transport, options = {}) {
    this.transport = transport;
    this.timeoutMs = options.timeoutMs ?? 15000;
    this.width = 0;
    this.height = 0;
    this.name = "";
  }

  /**
   * Open a connection to a websockify endpoint and complete the RFB handshake.
   * @param {{host: string, port: number, path?: string, password?: string, timeoutMs?: number, frameTimeoutMs?: number}} options
   */
  static async connect(options) {
    const {
      host,
      port,
      path: webSocketPath = "/websockify",
      password = "",
      timeoutMs = 15000,
      frameTimeoutMs = 10000,
    } = options;
    const url = `ws://${host}:${port}${webSocketPath}`;
    const transport = await WsTransport.open(url, ["binary"], timeoutMs);
    const client = new RfbClient(transport, { timeoutMs });
    client.frameTimeoutMs = frameTimeoutMs;
    try {
      await client.#handshake(password);
    } catch (error) {
      transport.close();
      throw error;
    }
    return client;
  }

  async #handshake(password) {
    const version = (await this.transport.recv(12, this.timeoutMs)).toString("latin1").trim();
    if (!/^RFB \d{3}\.\d{3}$/.test(version)) {
      throw new RfbError(`unexpected RFB greeting: ${JSON.stringify(version)}`);
    }
    this.transport.send(Buffer.from("RFB 003.008\n", "latin1"));
    const count = (await this.transport.recv(1, this.timeoutMs))[0];
    if (count === 0) {
      const length = (await this.transport.recv(4, this.timeoutMs)).readUInt32BE(0);
      const reason = (await this.transport.recv(length, this.timeoutMs)).toString("latin1");
      throw new RfbError(`VNC server refused the connection: ${reason}`);
    }
    const securityTypes = [...(await this.transport.recv(count, this.timeoutMs))];
    if (securityTypes.includes(2)) {
      this.transport.send(Buffer.from([2]));
      const challenge = await this.transport.recv(16, this.timeoutMs);
      this.transport.send(vncAuthResponse(challenge, password));
      const result = (await this.transport.recv(4, this.timeoutMs)).readUInt32BE(0);
      if (result !== 0) {
        throw new RfbError(`VNC authentication failed (security result ${result}); check the VNC password`);
      }
    } else if (securityTypes.includes(1)) {
      this.transport.send(Buffer.from([1]));
      const result = (await this.transport.recv(4, this.timeoutMs)).readUInt32BE(0);
      if (result !== 0) throw new RfbError(`VNC security result ${result}`);
    } else {
      throw new RfbError(`VNC server offered no supported security type: ${securityTypes.join(",")}`);
    }
    this.transport.send(Buffer.from([1]));
    const size = await this.transport.recv(4, this.timeoutMs);
    this.width = size.readUInt16BE(0);
    this.height = size.readUInt16BE(2);
    await this.transport.recv(16, this.timeoutMs);
    const nameLength = (await this.transport.recv(4, this.timeoutMs)).readUInt32BE(0);
    this.name = (await this.transport.recv(nameLength, this.timeoutMs)).toString("latin1");
    this.#setPixelFormat();
    this.#setEncodings();
  }

  #setPixelFormat() {
    const message = Buffer.from([0, 0, 0, 0, 32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0]);
    this.transport.send(message);
  }

  #setEncodings() {
    this.transport.send(Buffer.from([2, 0, 0, 0]));
  }

  /** Request a framebuffer update: full (`incremental=0`) or changed regions only. */
  requestFrame(incremental = 0) {
    const message = Buffer.alloc(10);
    message[0] = 3;
    message[1] = incremental ? 1 : 0;
    message.writeUInt16BE(0, 2);
    message.writeUInt16BE(0, 4);
    message.writeUInt16BE(this.width, 6);
    message.writeUInt16BE(this.height, 8);
    this.transport.send(message);
  }

  /**
   * Read messages until at least one FramebufferUpdate has been consumed.
   * Server messages other than raw rects are consumed and ignored.
   * @param {number} timeoutMs overall deadline
   * @param {Buffer} [framebuffer] existing BGRA frame to patch in place
   * @returns {Promise<{framebuffer: Buffer, received: boolean}>}
   */
  async readUpdate(timeoutMs, framebuffer) {
    let frame = framebuffer ?? Buffer.alloc(this.width * this.height * 4);
    const deadline = Date.now() + timeoutMs;
    let received = false;
    while (Date.now() < deadline) {
      const remaining = Math.max(20, deadline - Date.now());
      let type;
      try {
        type = (await this.transport.recv(1, received ? Math.min(remaining, 350) : remaining))[0];
      } catch (error) {
        if (error instanceof RfbTimeoutError) break;
        throw error;
      }
      if (type === 0) {
        await this.transport.recv(1, Math.max(20, deadline - Date.now()));
        const count = (await this.transport.recv(2, Math.max(20, deadline - Date.now()))).readUInt16BE(0);
        for (let index = 0; index < count; index += 1) {
          const header = await this.transport.recv(12, Math.max(20, deadline - Date.now()));
          const x = header.readUInt16BE(0);
          const y = header.readUInt16BE(2);
          const width = header.readUInt16BE(4);
          const height = header.readUInt16BE(6);
          const encoding = header.readInt32BE(8);
          if (encoding === 0) {
            const bytes = await this.transport.recv(width * height * 4, Math.max(20, deadline - Date.now()));
            for (let row = 0; row < height; row += 1) {
              bytes.copy(frame, ((y + row) * this.width + x) * 4, row * width * 4, (row + 1) * width * 4);
            }
          } else if (encoding === -239 || encoding === -258 || encoding === -223) {
            // Cursor / DesktopSize / DesktopName pseudo-encodings carry no raw pixels here.
            throw new RfbError(`unexpected RFB encoding ${encoding}; this client negotiates Raw only`);
          } else {
            throw new RfbError(`unsupported RFB encoding ${encoding}`);
          }
        }
        received = true;
      } else if (type === 1) {
        const header = await this.transport.recv(5, Math.max(20, deadline - Date.now()));
        const entries = header.readUInt16BE(3);
        await this.transport.recv(entries * 6, Math.max(20, deadline - Date.now()));
      } else if (type === 2) {
        // Bell: ignore.
      } else if (type === 3) {
        const header = await this.transport.recv(7, Math.max(20, deadline - Date.now()));
        const length = header.readUInt32BE(3);
        await this.transport.recv(length, Math.max(20, deadline - Date.now()));
      } else {
        throw new RfbError(`unknown RFB message type ${type}`);
      }
    }
    return { framebuffer: frame, received };
  }

  /** Queue one key event. `keysym` is already the X11 keysym to deliver. */
  key(keysym, down = true) {
    const message = Buffer.alloc(8);
    message[0] = 4;
    message[1] = down ? 1 : 0;
    message.writeUInt32BE(keysym >>> 0, 4);
    this.transport.send(message);
  }

  /** Queue one pointer event at framebuffer coordinates. */
  pointer(x, y, mask = 0) {
    const message = Buffer.alloc(6);
    message[0] = 5;
    message[1] = mask;
    message.writeUInt16BE(x, 2);
    message.writeUInt16BE(y, 4);
    this.transport.send(message);
  }

  async click(x, y, button = 1) {
    const mask = { 1: 1, 2: 2, 3: 4 }[button] ?? 1;
    this.pointer(x, y, 0);
    await delay(50);
    this.pointer(x, y, mask);
    await delay(60);
    this.pointer(x, y, 0);
  }

  async doubleClick(x, y, button = 1) {
    await this.click(x, y, button);
    await delay(80);
    await this.click(x, y, button);
  }

  async drag(fromX, fromY, toX, toY, durationMs = 400, button = 1) {
    const mask = { 1: 1, 2: 2, 3: 4 }[button] ?? 1;
    this.pointer(fromX, fromY, 0);
    await delay(60);
    this.pointer(fromX, fromY, mask);
    const steps = Math.max(4, Math.min(30, Math.round(durationMs / 25)));
    for (let step = 1; step <= steps; step += 1) {
      const x = Math.round(fromX + ((toX - fromX) * step) / steps);
      const y = Math.round(fromY + ((toY - fromY) * step) / steps);
      this.pointer(x, y, mask);
      await delay(Math.max(8, Math.round(durationMs / steps)));
    }
    this.pointer(toX, toY, 0);
  }

  /**
   * Send text one keysym at a time.
   *
   * This QEMU VNC does not process Shift modifiers, so shifted characters must
   * be sent as their final keysym (`A` -> 0x41, `_` -> 0x5F), exactly like
   * `vnclib.type_text`. Non-ASCII characters use the Unicode keysym form.
   */
  async typeText(text, { intervalMs = 12 } = {}) {
    for (const character of text) {
      let keysym;
      const code = character.codePointAt(0);
      if (character === "\n" || character === "\r") keysym = 0xff0d;
      else if (character === "\t") keysym = 0xff09;
      else if (character === "\b") keysym = 0xff08;
      else if (code < 256) keysym = code;
      else keysym = 0x01000000 + code;
      this.key(keysym, true);
      await delay(intervalMs);
      this.key(keysym, false);
      await delay(intervalMs);
    }
  }

  /** Press a key combination such as `["ctrl","shift","v"]`. */
  async keyCombo(names) {
    const codes = names.map((name) => {
      const normalized = name.toLowerCase();
      if (Object.hasOwn(SPECIAL_KEYS, normalized)) return SPECIAL_KEYS[normalized];
      if (name.length === 1) return name.charCodeAt(0);
      throw new RfbError(`unknown key name "${name}"`);
    });
    for (const code of codes) {
      this.key(code, true);
      await delay(20);
    }
    for (const code of codes.slice().reverse()) {
      this.key(code, false);
      await delay(20);
    }
  }

  /** Set the remote clipboard (RFB ClientCutText is latin-1 only). */
  clipboard(text) {
    const bytes = Buffer.from(text, "latin1");
    const message = Buffer.alloc(8 + bytes.length);
    message[0] = 6;
    message.writeUInt32BE(bytes.length, 4);
    bytes.copy(message, 8);
    this.transport.send(message);
  }

  close() {
    this.transport.close();
  }
}

/**
 * Long-lived VNC connection owned by the plugin: reconnects on demand, caches
 * the last full frame for diffing, and serializes every operation so parallel
 * tool calls cannot interleave partial RFB messages.
 */
export class LabSession {
  constructor(defaults = {}) {
    this.defaults = {
      host: "",
      port: 30505,
      path: "/websockify",
      password: "",
      timeoutMs: 15000,
      frameTimeoutMs: 10000,
      ...defaults,
    };
    this.client = null;
    this.lastFrame = null;
    this.lastFrameAt = 0;
    this.queue = Promise.resolve();
    // The VM port changes per experiment session, so remember what actually worked.
    this.endpoint = null;
  }

  /** Serialize an operation against the shared connection. */
  exclusive(operation) {
    const run = this.queue.then(operation, operation);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  get connected() {
    return this.client !== null;
  }

  info() {
    if (this.client === null) return null;
    const endpoint = this.endpoint ?? this.defaults;
    return {
      host: endpoint.host,
      port: endpoint.port,
      path: endpoint.path,
      width: this.client.width,
      height: this.client.height,
      name: this.client.name,
    };
  }

  /** Drop a broken socket so the next operation reconnects. */
  #reset() {
    if (this.client !== null) {
      try {
        this.client.close();
      } catch {
        /* ignore */
      }
    }
    this.client = null;
    this.lastFrame = null;
  }

  /**
   * Connect to the lab VM.
   *
   * `overrides.url` accepts anything the user copied: the platform's internal VM
   * URL (`http://<vm-host>:<port>/index.html?...`), a bare port, or a full
   * `ws://host:port/websockify` URL. The port changes per experiment session, so
   * explicit endpoint data always wins over the defaults.
   */
  async connect(overrides = {}) {
    return this.exclusive(async () => {
      const { url, ...rest } = overrides;
      if (this.client !== null && url === undefined && Object.keys(rest).length === 0) return this.info();
      const parsed = url === undefined ? null : parseVncEndpoint(url, this.defaults);
      const merged = { ...this.defaults, ...rest };
      if (parsed !== null) {
        merged.host = parsed.host;
        merged.port = parsed.port;
        merged.path = parsed.path;
      } else if (this.endpoint !== null && rest.host === undefined && rest.port === undefined && rest.path === undefined) {
        merged.host = this.endpoint.host;
        merged.port = this.endpoint.port;
        merged.path = this.endpoint.path;
      }
      this.defaults = merged;
      if (this.client !== null) this.#reset();
      const { host, port, path: webSocketPath, password, timeoutMs } = merged;
      try {
        this.client = await RfbClient.connect({ host, port, path: webSocketPath, password, timeoutMs });
      } catch (error) {
        throw connectionError(error, host, port);
      }
      this.endpoint = { host, port, path: webSocketPath };
      const frame = await this.captureFrame();
      this.lastFrame = frame.framebuffer;
      this.lastFrameAt = Date.now();
      return this.info();
    });
  }

  /**
   * Scan a port range for RFB endpoints (the VM port changes per session).
   * Reachable ports are verified with a real handshake, so only VNC endpoints
   * are reported. Connects to the first verified candidate.
   */
  async discover({ from, to, concurrency = 128, probeTimeoutMs = 400, password } = {}) {
    return this.exclusive(async () => {
      if (this.client !== null) this.#reset();
      const host = this.endpoint?.host ?? this.defaults.host;
      const start = from ?? 30000;
      const end = to ?? 33000;
      if (end - start < 0 || end - start > 20000) {
        throw new RfbError(`discover range ${start}-${end} is invalid (maximum 20000 ports)`);
      }
      const ports = [];
      for (let port = start; port <= end; port += 1) ports.push(port);
      const reachable = [];
      await mapLimit(ports, Math.max(8, Math.min(256, concurrency)), async (port) => {
        if (await probePort(host, port, probeTimeoutMs)) reachable.push(port);
      });
      reachable.sort((left, right) => left - right);
      const candidates = [];
      for (const port of reachable) {
        try {
          const client = await RfbClient.connect({
            host,
            port,
            path: this.defaults.path,
            password: password ?? this.defaults.password,
            timeoutMs: 5000,
          });
          candidates.push({ port, width: client.width, height: client.height, name: client.name });
          if (candidates.length === 1) {
            this.client = client;
            this.endpoint = { host, port, path: this.defaults.path };
            this.defaults = { ...this.defaults, host, port };
            const frame = await this.captureFrame();
            this.lastFrame = frame.framebuffer;
            this.lastFrameAt = Date.now();
          } else {
            client.close();
          }
        } catch {
          /* reachable but not RFB */
        }
      }
      return { host, scanned: ports.length, reachablePorts: reachable, candidates, connected: this.client !== null };
    });
  }

  /** Connect when needed, then run `operation` with the live client while holding the connection lock. */
  async run(operation) {
    if (this.client === null) await this.connect();
    return this.exclusive(async () => {
      if (this.client === null) throw new RfbError("the VNC session is not connected");
      return operation(this.client);
    });
  }

  async ensureConnected() {
    if (this.client !== null) return this.info();
    return this.connect();
  }

  /** Request a full frame and wait for it. Call only while holding the lock. */
  async captureFrame(timeoutMs) {
    const client = this.client;
    if (client === null) throw new RfbError("not connected");
    client.requestFrame(0);
    return client.readUpdate(timeoutMs ?? this.defaults.frameTimeoutMs, Buffer.alloc(client.width * client.height * 4));
  }

  /** Capture a frame, update the cached frame, and return the previous frame for diffing. */
  async screenshot({ timeoutMs } = {}) {
    return this.run(async () => {
      const { framebuffer } = await this.captureFrame(timeoutMs);
      const previous = this.lastFrame;
      this.lastFrame = Buffer.from(framebuffer);
      this.lastFrameAt = Date.now();
      return { framebuffer, width: this.client.width, height: this.client.height, previous };
    });
  }

  async disconnect() {
    return this.exclusive(async () => {
      this.#reset();
      return { connected: false };
    });
  }
}
