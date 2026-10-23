/**
 * Minimal Chrome DevTools Protocol (CDP) client over the local debugging port.
 *
 * The browser channel previously had to drive the foreground Edge window with
 * screen coordinates and SendKeys, which stole focus and needed one tool call
 * per click. CDP talks to the renderer directly: screenshots, DOM evaluation and
 * synthetic input all work while Edge is in the background.
 *
 * Start Edge once with `--remote-debugging-port=9222` (same profile keeps the
 * WebVPN session).
 */

const DEFAULT_PORT = 9222;

export class CdpError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "CdpError";
  }
}

async function readJson(url, init) {
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(8000), ...init });
  } catch (error) {
    throw new CdpError(
      `cannot reach the Edge debugging endpoint at ${url}: ${error.message} — start Edge with --remote-debugging-port=${DEFAULT_PORT}`,
      { cause: error },
    );
  }
  if (!response.ok) throw new CdpError(`${url} returned HTTP ${response.status}`);
  return response.json();
}

/** List page targets (tabs) exposed by the debugging endpoint. */
export function listPages(port = DEFAULT_PORT) {
  return readJson(`http://127.0.0.1:${port}/json/list`).then((targets) =>
    targets.filter((target) => target.type === "page"),
  );
}

/** Create a new tab and return its target; Chrome 111+ requires PUT. */
export async function openPage(url, port = DEFAULT_PORT) {
  const targets = await readJson(
    `http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`,
    { method: "PUT" },
  );
  return targets;
}

let nextId = 1;

/** One CDP session bound to a page target. */
export class CdpPage {
  #socket;
  #pending = new Map();
  #events = [];

  constructor(socket) {
    this.#socket = socket;
    socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf8"));
      } catch {
        return;
      }
      if (message.id !== undefined) {
        const pending = this.#pending.get(message.id);
        if (pending === undefined) return;
        this.#pending.delete(message.id);
        if (message.error !== undefined) pending.reject(new CdpError(`${message.error.message} (${message.error.code})`));
        else pending.resolve(message.result ?? {});
        return;
      }
      this.#events.push(message);
      if (this.#events.length > 200) this.#events.shift();
    });
    socket.addEventListener("close", () => {
      for (const pending of this.#pending.values()) pending.reject(new CdpError("CDP socket closed"));
      this.#pending.clear();
    });
  }

  static async connect(wsUrl) {
    const socket = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new CdpError(`timed out connecting to ${wsUrl}`)), 10000);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new CdpError(`cannot connect to ${wsUrl}`));
      }, { once: true });
    });
    const page = new CdpPage(socket);
    await page.send("Runtime.enable");
    await page.send("Page.enable");
    return page;
  }

  send(method, params = {}, timeoutMs = 15000) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.#pending.delete(id)) {
          reject(new CdpError(`${method} timed out after ${timeoutMs} ms (renderer busy or Edge unresponsive)`));
        }
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        this.#socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(new CdpError(`cannot send ${method}: ${error.message}`, { cause: error }));
      }
    });
  }

  close() {
    try {
      this.#socket.close();
    } catch {
      /* ignore */
    }
  }

  /** Evaluate an expression in the page and return its JSON value. */
  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails !== undefined) {
      const detail = result.exceptionDetails;
      throw new CdpError(`page evaluation failed: ${detail.exception?.description ?? detail.text ?? "unknown error"}`);
    }
    return result.result?.value;
  }

  /** Full-page (viewport) PNG screenshot. */
  async screenshot() {
    const { data } = await this.send("Page.captureScreenshot", { format: "png", fromSurface: true });
    return Buffer.from(data, "base64");
  }

  async navigate(url) {
    const result = await this.send("Page.navigate", { url });
    if (result.errorText !== undefined) throw new CdpError(`navigation failed: ${result.errorText}`);
    return result;
  }

  async mouseClick(x, y, clickCount = 1) {
    const base = { x, y, button: "left", clickCount };
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", ...base });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...base });
  }

  /** Dispatch a keydown/keypress/keyup sequence with the given key/code/vk/text. */
  async keyStroke(key, code, virtualKeyCode, text = "", modifiers = 0) {
    await this.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key,
      code,
      windowsVirtualKeyCode: virtualKeyCode,
      nativeVirtualKeyCode: virtualKeyCode,
      text,
      unmodifiedText: text,
      modifiers,
    });
    if (text.length > 0) {
      // noVNC (and some canvas apps) translate the keypress rather than keydown.
      await this.send("Input.dispatchKeyEvent", {
        type: "char",
        key,
        code,
        windowsVirtualKeyCode: virtualKeyCode,
        nativeVirtualKeyCode: virtualKeyCode,
        text,
        unmodifiedText: text,
        modifiers,
      });
    }
    await this.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key,
      code,
      windowsVirtualKeyCode: virtualKeyCode,
      nativeVirtualKeyCode: virtualKeyCode,
      modifiers,
    });
  }

  /** Type text character by character (works for the noVNC canvas too). */
  async typeText(text, delayMs = 0) {
    for (const character of text) {
      const spec = charKeySpec(character);
      await this.keyStroke(spec.key, spec.code, spec.vk, spec.text, spec.modifiers);
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  async pressKey(name) {
    const spec = namedKeySpec(name);
    await this.keyStroke(spec.key, spec.code, spec.vk, spec.text ?? "", spec.modifiers ?? 0);
  }

  async pressCombo(names) {
    const specs = names.map(namedKeySpec);
    for (const spec of specs) {
      await this.send("Input.dispatchKeyEvent", {
        type: "keyDown", key: spec.key, code: spec.code,
        windowsVirtualKeyCode: spec.vk, nativeVirtualKeyCode: spec.vk, modifiers: spec.modifiers ?? 0,
      });
    }
    for (const spec of specs.slice().reverse()) {
      await this.send("Input.dispatchKeyEvent", {
        type: "keyUp", key: spec.key, code: spec.code,
        windowsVirtualKeyCode: spec.vk, nativeVirtualKeyCode: spec.vk, modifiers: spec.modifiers ?? 0,
      });
    }
  }

  /** Poll an expression until it is truthy; returns the last value. */
  async waitFor(expression, timeoutMs, intervalMs = 300) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      last = await this.evaluate(expression);
      if (last) return last;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return last;
  }
}

const NAMED_KEYS = {
  enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", vk: 9 },
  esc: { key: "Escape", code: "Escape", vk: 27 },
  backspace: { key: "Backspace", code: "Backspace", vk: 8 },
  delete: { key: "Delete", code: "Delete", vk: 46 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  ctrl: { key: "Control", code: "ControlLeft", vk: 17, modifiers: 2 },
  control: { key: "Control", code: "ControlLeft", vk: 17, modifiers: 2 },
  shift: { key: "Shift", code: "ShiftLeft", vk: 16, modifiers: 8 },
  alt: { key: "Alt", code: "AltLeft", vk: 18, modifiers: 1 },
};

function namedKeySpec(name) {
  const normalized = name.toLowerCase();
  if (Object.hasOwn(NAMED_KEYS, normalized)) return { ...NAMED_KEYS[normalized] };
  if (name.length === 1) return charKeySpec(name);
  throw new CdpError(`unknown key "${name}"`);
}

const PUNCTUATION = {
  " ": { key: " ", code: "Space", vk: 32 },
  "-": { key: "-", code: "Minus", vk: 189 },
  "_": { key: "_", code: "Minus", vk: 189 },
  "=": { key: "=", code: "Equal", vk: 187 },
  "+": { key: "+", code: "Equal", vk: 187 },
  "[": { key: "[", code: "BracketLeft", vk: 219 },
  "]": { key: "]", code: "BracketRight", vk: 221 },
  "\\": { key: "\\", code: "Backslash", vk: 220 },
  ";": { key: ";", code: "Semicolon", vk: 186 },
  ":": { key: ":", code: "Semicolon", vk: 186 },
  "'": { key: "'", code: "Quote", vk: 222 },
  '"': { key: '"', code: "Quote", vk: 222 },
  ",": { key: ",", code: "Comma", vk: 188 },
  ".": { key: ".", code: "Period", vk: 190 },
  "/": { key: "/", code: "Slash", vk: 191 },
  "<": { key: "<", code: "Comma", vk: 188 },
  ">": { key: ">", code: "Period", vk: 190 },
  "?": { key: "?", code: "Slash", vk: 191 },
  "!": { key: "!", code: "Digit1", vk: 49 },
  "@": { key: "@", code: "Digit2", vk: 50 },
  "#": { key: "#", code: "Digit3", vk: 51 },
  "$": { key: "$", code: "Digit4", vk: 52 },
  "%": { key: "%", code: "Digit5", vk: 53 },
  "^": { key: "^", code: "Digit6", vk: 54 },
  "&": { key: "&", code: "Digit7", vk: 55 },
  "*": { key: "*", code: "Digit8", vk: 56 },
  "(": { key: "(", code: "Digit9", vk: 57 },
  ")": { key: ")", code: "Digit0", vk: 48 },
  "{": { key: "{", code: "BracketLeft", vk: 219 },
  "}": { key: "}", code: "BracketRight", vk: 221 },
  "|": { key: "|", code: "Backslash", vk: 220 },
  "~": { key: "~", code: "Backquote", vk: 192 },
  "`": { key: "`", code: "Backquote", vk: 192 },
};

function charKeySpec(character) {
  if (/[a-z]/.test(character)) {
    const upper = character.toUpperCase();
    return { key: character, code: `Key${upper}`, vk: upper.charCodeAt(0), text: character };
  }
  if (/[A-Z]/.test(character)) {
    return { key: character, code: `Key${character}`, vk: character.charCodeAt(0), text: character, modifiers: 8 };
  }
  if (/[0-9]/.test(character)) {
    return { key: character, code: `Digit${character}`, vk: character.charCodeAt(0), text: character };
  }
  if (Object.hasOwn(PUNCTUATION, character)) {
    const spec = PUNCTUATION[character];
    return { ...spec, text: character };
  }
  return { key: character, code: "", vk: 0, text: character };
}
