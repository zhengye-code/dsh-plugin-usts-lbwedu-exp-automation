/**
 * Ibwedu lab automation as DSH Host tools.
 *
 * The original project drove the lab VM with `tools/vnclib.py` + `tools/vdo.py`
 * and the platform page with `tools/ui.ps1`. This plugin turns all three into
 * first-class agent tools:
 *
 *   lab_session  - connect / status / disconnect the RFB-over-WebSocket link
 *   lab_shot     - screenshot with crop, scale and diff against the last frame
 *   lab_act      - batch pointer/keyboard actions, screenshot included
 *   lab_platform - Windows UI Automation for the platform page (load/complete)
 *   lab_pdf      - PyMuPDF text extraction and page rendering
 *
 * Screenshots come back as image blocks, so "look at the screen" is one call
 * instead of write-file + read_image.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { LabSession, RfbError } from "./rfb.js";
import {
  compareFramebuffers,
  cropFramebuffer,
  cropRgb,
  diffRgb,
  downscaleRgb,
  encodePng,
  framebufferToRgb,
} from "./png.js";
import { runPlatform } from "./platform.js";
import { runPdf } from "./pdf.js";
import { CdpPage, CdpError, listPages, openPage } from "./cdp.js";

/** The tool registry must exist before apply() runs. */
export const inject = ["tools"];

const IMAGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    attachmentId: { type: "string", required: true },
    mediaType: { type: "string", enum: ["image/png"], required: true },
    bytes: { type: "integer", required: true },
    width: { type: "integer", required: true },
    height: { type: "integer", required: true },
    name: { type: "string" },
    originalDimensions: {
      type: "object",
      additionalProperties: false,
      properties: {
        width: { type: "integer", required: true },
        height: { type: "integer", required: true },
      },
    },
  },
};

const DEFAULT_MAX_SIDE = 1568;
const DEFAULT_PDF_CHARS = 60000;

function text(value) {
  return { type: "text", text: value };
}

function imageBlock(image) {
  return {
    type: "image",
    attachment: {
      attachmentId: image.attachmentId,
      mediaType: image.mediaType,
      bytes: image.bytes,
      width: image.width,
      height: image.height,
      ...(image.name === undefined ? {} : { name: image.name }),
      ...(image.originalDimensions === undefined ? {} : { originalDimensions: { ...image.originalDimensions } }),
    },
  };
}

async function attachPng(ctx, png, name) {
  const attachments = ctx.get("attachments");
  if (attachments === undefined) {
    throw new Error("no attachment service is mounted, so screenshots cannot be returned as images");
  }
  const ref = await attachments.saveImage({ data: png, mediaType: "image/png", name });
  return {
    attachmentId: ref.attachmentId,
    mediaType: ref.mediaType,
    bytes: ref.bytes,
    width: ref.width,
    height: ref.height,
    ...(ref.name === undefined ? {} : { name: ref.name }),
    ...(ref.originalDimensions === undefined
      ? {}
      : { originalDimensions: { width: ref.originalDimensions.width, height: ref.originalDimensions.height } }),
  };
}

/** Encode a BGRA frame (optionally cropped, diff-highlighted and scaled) into a PNG. */
function frameToPng({ framebuffer, previous, width, height, crop, diff, maxSide }) {
  const region = crop === undefined
    ? { x: 0, y: 0, width, height }
    : (() => {
        const result = cropFramebuffer(framebuffer, width, height, crop);
        return { x: result.x, y: result.y, width: result.width, height: result.height };
      })();
  let rgb;
  if (diff) {
    const full = diffRgb(framebuffer, previous, width, height);
    rgb = region.x === 0 && region.y === 0 && region.width === width && region.height === height
      ? full
      : cropRgb(full, width, region);
  } else {
    const bgra = region.x === 0 && region.y === 0 && region.width === width && region.height === height
      ? framebuffer
      : cropFramebuffer(framebuffer, width, height, crop).bgra;
    rgb = framebufferToRgb(bgra, region.width, region.height);
  }
  const scaled = downscaleRgb(rgb, region.width, region.height, maxSide ?? DEFAULT_MAX_SIDE);
  return {
    png: encodePng(scaled.rgb, scaled.width, scaled.height),
    width: scaled.width,
    height: scaled.height,
    scaled: scaled.scaled,
    region,
  };
}

async function writePngFile(filePath, png) {
  const absolute = resolve(filePath);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, png);
  return absolute;
}

function formatPercent(ratio) {
  return `${(ratio * 100).toFixed(2)}%`;
}

function describeDiff(diff) {
  if (diff === undefined) return "";
  if (diff.firstFrame) return "; first frame (no diff baseline)";
  if (diff.changedPixels === 0) return "; screen unchanged";
  const box = diff.box === null ? "" : ` bbox ${diff.box.x},${diff.box.y} ${diff.box.width}x${diff.box.height}`;
  return `; changed ${diff.changedPixels} px (${formatPercent(diff.ratio)})${box}`;
}

/** Truncate log text so one bad batch cannot flood the transcript. */
function summarizeText(value, max = 80) {
  const flat = String(value).replace(/\s+/g, " ");
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function sessionOutput(info, message) {
  return {
    summary: message,
    connected: info !== null,
    ...(info === null
      ? {}
      : {
          host: info.host,
          port: info.port,
          width: info.width,
          height: info.height,
          vncName: info.name,
        }),
  };
}

const cropSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    x: { type: "integer", required: true, description: "Left edge in framebuffer pixels." },
    y: { type: "integer", required: true, description: "Top edge in framebuffer pixels." },
    width: { type: "integer", required: true, description: "Crop width in pixels." },
    height: { type: "integer", required: true, description: "Crop height in pixels." },
  },
};

const actionSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    a: {
      type: "string",
      enum: ["click", "dblclick", "move", "drag", "type", "key", "paste", "wheel", "sleep", "wait"],
      required: true,
      description: "Action name.",
    },
    x: { type: "integer", description: "X for click/dblclick/move/wheel." },
    y: { type: "integer", description: "Y for click/dblclick/move/wheel." },
    fromX: { type: "integer", description: "Drag start X." },
    fromY: { type: "integer", description: "Drag start Y." },
    toX: { type: "integer", description: "Drag end X." },
    toY: { type: "integer", description: "Drag end Y." },
    button: { type: "integer", description: "Mouse button 1=left, 2=middle, 3=right (default 1)." },
    text: { type: "string", description: "Text for type/paste." },
    keys: { type: "array", items: { type: "string" }, description: "Key names for key, e.g. [\"ctrl\",\"alt\",\"t\"]." },
    target: {
      type: "string",
      enum: ["ctrl+v", "ctrl+shift+v", "none"],
      description: "Paste chord; terminals need ctrl+shift+v (default ctrl+shift+v).",
    },
    delta: { type: "integer", description: "Wheel notches; positive scrolls down." },
    seconds: { type: "number", description: "Seconds for sleep." },
    ms: { type: "integer", description: "Milliseconds for wait." },
    intervalMs: { type: "integer", description: "Per-character delay for type (default 12)." },
    durationMs: { type: "integer", description: "Drag duration in milliseconds (default 400)." },
  },
};

export function apply(ctx, config = {}) {
  const session = new LabSession({
    host: config.host ?? process.env.IBWEDU_VNC_HOST ?? "",
    port: config.port ?? Number(process.env.IBWEDU_VNC_PORT ?? 30505),
    path: config.path ?? process.env.IBWEDU_VNC_PATH ?? "/websockify",
    password: config.password ?? process.env.IBWEDU_VNC_PASSWORD ?? "",
    timeoutMs: config.timeoutMs ?? 15000,
    frameTimeoutMs: config.frameTimeoutMs ?? 10000,
  });

  const tool = (definition) => ctx.effect(() => ctx.tools.register(defineTool(definition)));

  tool({
    name: "lab_session",
    description:
      "Manage the direct RFB/VNC connection to the Ibwedu lab virtual machine (bypasses the platform's flaky noVNC iframe). " +
      "The VM port changes per experiment session, so pass url = the internal VM URL the platform shows (http://<vm-host>:<port>/index.html?...); a bare port or ws:// URL also works. " +
      "action=connect opens ws://<host>:<port>/websockify, authenticates with the VNC password, and reports width/height; " +
      "action=discover scans a port range and connects to the first verified RFB endpoint; action=status reports the live connection; action=disconnect closes it. " +
      "Only the VM's internal IP works when an L3 VPN tunnel is up. A Sangfor web-VPN gateway address (…-p.vpn.usts.edu.cn) rejects Node clients; drive the browser with lab_platform instead.",
    parameters: {
      action: {
        type: "string",
        enum: ["connect", "status", "disconnect", "discover"],
        required: true,
        description: "Connection operation to perform.",
      },
      url: {
        type: "string",
        description: "Current VM URL or port, e.g. http://<vm-host>:12345/index.html?password=<vnc-password>&resize=scale, 12345, or ws://host:port/websockify.",
      },
      host: { type: "string", description: "VNC host (default from config/env IBWEDU_VNC_HOST)." },
      port: { type: "integer", description: "VNC websockify port (default 30505, but it changes per session)." },
      path: { type: "string", description: "WebSocket path (default /websockify)." },
      password: { type: "string", description: "VNC password (config/env IBWEDU_VNC_PASSWORD; the platform URL's vncpassword may be a decoy)." },
      timeoutMs: { type: "integer", description: "Connect timeout in milliseconds (default 15000)." },
      from: { type: "integer", description: "discover: first port (default 30000)." },
      to: { type: "integer", description: "discover: last port (default 33000, at most 20000 ports)." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          summary: { type: "string", required: true },
          connected: { type: "boolean", required: true },
          host: { type: "string" },
          port: { type: "integer" },
          width: { type: "integer" },
          height: { type: "integer" },
          vncName: { type: "string" },
          candidates: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                port: { type: "integer", required: true },
                width: { type: "integer", required: true },
                height: { type: "integer", required: true },
                name: { type: "string" },
              },
            },
          },
        },
      },
      render: (_args, value) => [text(value.summary)],
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      if (args.action === "connect") {
        const overrides = {};
        if (args.url !== undefined) overrides.url = args.url;
        if (args.host !== undefined) overrides.host = args.host;
        if (args.port !== undefined) overrides.port = args.port;
        if (args.path !== undefined) overrides.path = args.path;
        if (args.password !== undefined) overrides.password = args.password;
        if (args.timeoutMs !== undefined) overrides.timeoutMs = args.timeoutMs;
        const info = await session.connect(overrides);
        return sessionOutput(info, `connected to ${info.host}:${info.port}${info.path} — ${info.width}x${info.height}, server "${info.name}"`);
      }
      if (args.action === "discover") {
        const result = await session.discover({ from: args.from, to: args.to, password: args.password });
        const info = session.info();
        const summary = result.candidates.length === 0
          ? `scanned ${result.scanned} port(s) on ${result.host}; ${result.reachablePorts.length} reachable, none spoke RFB`
          : `scanned ${result.scanned} port(s) on ${result.host}; found ${result.candidates.map((candidate) => `${candidate.port} (${candidate.width}x${candidate.height})`).join(", ")}${info === null ? "" : `, connected to ${info.port}`}`;
        return {
          ...sessionOutput(info, summary),
          candidates: result.candidates,
        };
      }
      if (args.action === "disconnect") {
        await session.disconnect();
        return sessionOutput(null, "VNC connection closed");
      }
      const info = session.info();
      if (info === null) return sessionOutput(null, "not connected — pass url with the current VM port");
      const age = session.lastFrameAt === 0 ? "none" : `${Date.now() - session.lastFrameAt} ms ago`;
      return sessionOutput(info, `connected to ${info.host}:${info.port}${info.path} — ${info.width}x${info.height}, server "${info.name}", last full frame ${age}`);
    },
  });

  tool({
    name: "lab_shot",
    description:
      "Capture the lab VM screen over the direct VNC link and return it as an image. Coordinates are framebuffer pixels (1:1 with the VM display), so measure them on the returned image. " +
      "Optional crop returns one region, maxSide downscales (default 1568 px), save writes a PNG, and diff highlights pixels that changed since the previous lab_shot/lab_act. " +
      "Large full-screen images are downscaled; the summary reports the scale factor to map coordinates back.",
    parameters: {
      crop: cropSchema,
      maxSide: { type: "integer", description: "Longest output side in pixels (default 1568; 0 keeps full size)." },
      save: { type: "string", description: "Optional PNG path to write (relative paths resolve against the session working directory)." },
      diff: { type: "boolean", description: "Highlight changed pixels against the previous captured frame." },
      timeoutMs: { type: "integer", description: "Frame wait timeout in milliseconds (default 10000)." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          summary: { type: "string", required: true },
          width: { type: "integer", required: true },
          height: { type: "integer", required: true },
          frameWidth: { type: "integer", required: true },
          frameHeight: { type: "integer", required: true },
          scale: { type: "number", required: true },
          saved: { type: "string" },
          changedPixels: { type: "integer" },
          changedRatio: { type: "number" },
          image: IMAGE_SCHEMA,
        },
      },
      render: (_args, value) => (value.image === undefined ? [text(value.summary)] : [text(value.summary), imageBlock(value.image)]),
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const shot = await session.screenshot({ timeoutMs: args.timeoutMs });
      const diff = args.diff ? compareFramebuffers(shot.previous, shot.framebuffer, shot.width, shot.height) : undefined;
      const encoded = frameToPng({ ...shot, crop: args.crop, diff: args.diff === true, maxSide: args.maxSide });
      const saved = args.save === undefined ? undefined : await writePngFile(args.save, encoded.png);
      const image = await attachPng(ctx, encoded.png, `lab-shot-${Date.now()}.png`);
      const scale = encoded.width / encoded.region.width;
      const summaryParts = [
        `${shot.width}x${shot.height} framebuffer`,
        args.crop === undefined
          ? `full frame -> ${encoded.width}x${encoded.height} PNG`
          : `crop ${encoded.region.x},${encoded.region.y} ${encoded.region.width}x${encoded.region.height} -> ${encoded.width}x${encoded.height} PNG`,
      ];
      if (encoded.scaled) {
        const mapping = args.crop === undefined
          ? `multiply measured coordinates by ${(1 / scale).toFixed(2)}`
          : `framebuffer = (${encoded.region.x},${encoded.region.y}) + image coordinate * ${(1 / scale).toFixed(2)}`;
        summaryParts.push(`downscaled (${mapping})`);
      }
      if (saved !== undefined) summaryParts.push(`saved ${saved}`);
      return {
        summary: summaryParts.join("; ") + describeDiff(diff),
        width: encoded.width,
        height: encoded.height,
        frameWidth: shot.width,
        frameHeight: shot.height,
        scale,
        ...(saved === undefined ? {} : { saved }),
        ...(diff === undefined
          ? {}
          : {
              changedPixels: diff.changedPixels,
              changedRatio: diff.ratio,
            }),
        image,
      };
    },
  });

  tool({
    name: "lab_act",
    description:
      "Run a batch of input actions on the lab VM over the direct VNC link, then return a screenshot. " +
      "Actions: click/dblclick/move {x,y}, drag {fromX,fromY,toX,toY}, type {text}, key {keys:[...]}, paste {text,target}, wheel {x,y,delta}, sleep {seconds}, wait {ms}. " +
      "Coordinates are framebuffer pixels; take a lab_shot first and measure on it. " +
      "Typed characters are sent as final keysyms (this VNC ignores Shift, so uppercase and '_' still work); paste uses the remote clipboard (latin-1 only). " +
      "Set screenshot=false to skip the trailing capture.",
    parameters: {
      actions: { type: "array", items: actionSchema, required: true, description: "Ordered actions to perform." },
      screenshot: { type: "boolean", description: "Capture a screenshot after the batch (default true)." },
      save: { type: "string", description: "Optional PNG path for the trailing screenshot." },
      maxSide: { type: "integer", description: "Longest screenshot side in pixels (default 1568)." },
      timeoutMs: { type: "integer", description: "Frame wait timeout after the batch in milliseconds (default 10000)." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          summary: { type: "string", required: true },
          log: { type: "array", items: { type: "string" }, required: true },
          width: { type: "integer" },
          height: { type: "integer" },
          saved: { type: "string" },
          changedPixels: { type: "integer" },
          changedRatio: { type: "number" },
          image: IMAGE_SCHEMA,
        },
      },
      render: (_args, value) => (value.image === undefined
        ? [text(value.summary), text(value.log.join("\n"))]
        : [text(value.summary), text(value.log.join("\n")), imageBlock(value.image)]),
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const log = [];
      const wantShot = args.screenshot !== false;
      await session.run(async (client) => {
        let index = 0;
        for (const action of args.actions) {
          index += 1;
          switch (action.a) {
            case "click":
              if (!Number.isInteger(action.x) || !Number.isInteger(action.y)) throw new RfbError(`action ${index}: click needs integer x and y`);
              await client.click(action.x, action.y, action.button ?? 1);
              log.push(`click(${action.x},${action.y}${action.button === undefined ? "" : `,button=${action.button}`})`);
              break;
            case "dblclick":
              if (!Number.isInteger(action.x) || !Number.isInteger(action.y)) throw new RfbError(`action ${index}: dblclick needs integer x and y`);
              await client.doubleClick(action.x, action.y, action.button ?? 1);
              log.push(`dblclick(${action.x},${action.y})`);
              break;
            case "move":
              await client.pointer(action.x ?? 0, action.y ?? 0, 0);
              log.push(`move(${action.x ?? 0},${action.y ?? 0})`);
              break;
            case "drag":
              await client.drag(
                action.fromX ?? 0,
                action.fromY ?? 0,
                action.toX ?? 0,
                action.toY ?? 0,
                action.durationMs ?? 400,
                action.button ?? 1,
              );
              log.push(`drag(${action.fromX ?? 0},${action.fromY ?? 0} -> ${action.toX ?? 0},${action.toY ?? 0})`);
              break;
            case "type":
              if (typeof action.text !== "string") throw new RfbError(`action ${index}: type needs a text string`);
              await client.typeText(action.text, { intervalMs: action.intervalMs ?? 12 });
              log.push(`type("${summarizeText(action.text)}")`);
              break;
            case "key":
              if (!Array.isArray(action.keys) || action.keys.length === 0) throw new RfbError(`action ${index}: key needs a non-empty keys array`);
              await client.keyCombo(action.keys);
              log.push(`key(${action.keys.join("+")})`);
              break;
            case "paste": {
              if (typeof action.text !== "string") throw new RfbError(`action ${index}: paste needs a text string`);
              const target = action.target ?? "ctrl+shift+v";
              client.clipboard(action.text);
              await new Promise((resolvePause) => setTimeout(resolvePause, 300));
              if (target !== "none") await client.keyCombo(target === "ctrl+v" ? ["ctrl", "v"] : ["ctrl", "shift", "v"]);
              log.push(`paste("${summarizeText(action.text)}", ${target})`);
              break;
            }
            case "wheel": {
              const delta = action.delta ?? 3;
              for (let step = 0; step < Math.abs(delta); step += 1) {
                client.pointer(action.x ?? 0, action.y ?? 0, delta > 0 ? 16 : 8);
                await new Promise((resolvePause) => setTimeout(resolvePause, 50));
                client.pointer(action.x ?? 0, action.y ?? 0, 0);
                await new Promise((resolvePause) => setTimeout(resolvePause, 50));
              }
              log.push(`wheel(${action.x ?? 0},${action.y ?? 0},${delta})`);
              break;
            }
            case "sleep": {
              const seconds = Math.max(0, action.seconds ?? 1);
              await new Promise((resolvePause) => setTimeout(resolvePause, seconds * 1000));
              log.push(`sleep(${seconds}s)`);
              break;
            }
            case "wait": {
              const milliseconds = Math.max(0, action.ms ?? 300);
              await new Promise((resolvePause) => setTimeout(resolvePause, milliseconds));
              log.push(`wait(${milliseconds}ms)`);
              break;
            }
            default:
              throw new RfbError(`action ${index}: unknown action "${action.a}"`);
          }
          await new Promise((resolvePause) => setTimeout(resolvePause, 120));
        }
      });

      if (!wantShot) {
        return { summary: `${log.length} action(s) sent`, log };
      }
      const shot = await session.screenshot({ timeoutMs: args.timeoutMs });
      const diff = compareFramebuffers(shot.previous, shot.framebuffer, shot.width, shot.height);
      const encoded = frameToPng({ ...shot, maxSide: args.maxSide });
      const saved = args.save === undefined ? undefined : await writePngFile(args.save, encoded.png);
      const image = await attachPng(ctx, encoded.png, `lab-act-${Date.now()}.png`);
      const scale = encoded.width / shot.width;
      const summary = `${log.length} action(s) sent; ${shot.width}x${shot.height} framebuffer -> ${encoded.width}x${encoded.height} PNG${encoded.scaled ? ` (multiply measured coordinates by ${(1 / scale).toFixed(2)})` : ""}${saved === undefined ? "" : `; saved ${saved}`}${describeDiff(diff)}`;
      return {
        summary,
        log,
        width: encoded.width,
        height: encoded.height,
        ...(saved === undefined ? {} : { saved }),
        changedPixels: diff.changedPixels,
        changedRatio: diff.ratio,
        image,
      };
    },
  });

  tool({
    name: "lab_platform",
    description:
      "Drive the Ibwedu platform page in Microsoft Edge through Windows UI Automation (no mouse focus stealing), and use the same screen path to drive the lab VM when a direct VNC connection is impossible (for example a Sangfor web-VPN gateway). " +
      "window actions: windows (list), focus {title,process?}, shot {path?,crop?} (returns the screen image; no path needed), click/dblclick/move {x,y}, wheel {x,y,delta}, paste {text,chord?}, type {text}, key {keys}, open-url {url}. " +
      "UI Automation actions: uia-find {name}, uia-click {name,controlType?}, uia-texts, select-tab {name}, wait-text {text,timeoutMs}, complete-experiment. " +
      "Browser-channel tip: when the platform's embedded iframe shows Disconnected, open the VM through the gateway host in a normal tab — http://<ip-dashed>-<port>-p.vpn.usts.edu.cn:8118/index.html?password=vncpassword&resize=scale — the logged-in WebVPN session authenticates it and noVNC connects; then click/type on that tab's canvas. " +
      "Window/UIA actions default to the msedge process, so the EasyConnect client cannot shadow Edge; pass process:'' to search every process. " +
      "The Edge window title contains \"Ibwedu\" while the platform page is open; complete-experiment clicks the 完成实验 button, confirms the dialog, and waits for the success toast. " +
      "Screen coordinates are desktop pixels (shot reports the virtual-screen origin); a sleeping/discarded Edge tab answers with a stale tree — select it first and wait ~10 s.",
    parameters: {
      action: {
        type: "string",
        enum: [
          "windows",
          "focus",
          "shot",
          "click",
          "dblclick",
          "move",
          "wheel",
          "paste",
          "type",
          "key",
          "open-url",
          "uia-find",
          "uia-click",
          "uia-texts",
          "select-tab",
          "wait-text",
          "complete-experiment",
        ],
        required: true,
        description: "Platform action to run.",
      },
      title: { type: "string", description: "Window title substring (default: any window of the target process)." },
      process: {
        type: "string",
        description: "Process name filter for window/UIA actions (default msedge, so the EasyConnect window cannot shadow Edge; pass an empty string to disable).",
      },
      name: { type: "string", description: "UI Automation element name, exact or (for uia-*/select-tab) substring." },
      controlType: { type: "string", description: "Optional UIA control type filter for name fallback, e.g. Button or TabItem." },
      x: { type: "integer", description: "Screen X for click/dblclick/move/wheel." },
      y: { type: "integer", description: "Screen Y for click/dblclick/move/wheel." },
      delta: { type: "integer", description: "Wheel notches; positive scrolls down (default 3)." },
      crop: cropSchema,
      url: { type: "string", description: "URL to open in a new Edge tab (open-url)." },
      text: { type: "string", description: "Text for paste/type, or needle for wait-text." },
      keys: { type: "string", description: "SendKeys expression for key, e.g. ^j or {ENTER}." },
      chord: { type: "string", description: "Paste chord as a SendKeys expression (default ^v; terminals need ^+v)." },
      path: { type: "string", description: "Optional PNG path for shot; a temp file is used when omitted." },
      limit: { type: "integer", description: "Maximum results for uia-find/uia-texts (default 20/200)." },
      timeoutMs: { type: "integer", description: "Action timeout in milliseconds (default 90000)." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          summary: { type: "string", required: true },
          texts: { type: "array", items: { type: "string" } },
          path: { type: "string" },
          image: IMAGE_SCHEMA,
        },
      },
      render: (_args, value) => {
        const blocks = [text(value.summary)];
        if (value.texts !== undefined && value.texts.length > 0) blocks.push(text(value.texts.join("\n")));
        if (value.image !== undefined) blocks.push(imageBlock(value.image));
        return blocks;
      },
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const options = {};
      for (const key of ["title", "process", "name", "controlType", "x", "y", "delta", "text", "keys", "chord", "url", "path", "limit", "crop", "timeoutMs"]) {
        if (args[key] !== undefined) options[key] = args[key];
      }
      if (args.action === "shot" && options.path === undefined) {
        options.path = join(tmpdir(), `lab-platform-${Date.now()}.png`);
      }
      const actionTimeoutMs = args.timeoutMs ?? (args.action === "complete-experiment" ? 120000 : 90000);
      // wait-text spends its own timeout inside PowerShell, so the process deadline must exceed it.
      const processTimeoutMs = args.action === "wait-text" ? actionTimeoutMs + 15000 : actionTimeoutMs;
      const result = await runPlatform(args.action, options, { timeoutMs: processTimeoutMs });

      if (args.action === "windows") {
        const windows = Array.isArray(result.windows) ? result.windows : [];
        const lines = windows.map((entry) => {
          const bounds = entry.bounds;
          const rect = bounds === undefined || bounds === null ? "" : ` @ ${bounds.x},${bounds.y} ${bounds.width}x${bounds.height}`;
          return `${entry.process} (pid ${entry.pid})${rect}: ${entry.title}`;
        });
        return { summary: `${windows.length} window(s) with a title`, texts: lines };
      }
      if (args.action === "uia-texts" || args.action === "texts-after") {
        const texts = Array.isArray(result.texts) ? result.texts : [];
        return { summary: `${texts.length} text element(s) in "${result.window ?? options.title ?? ""}"`, texts };
      }
      if (args.action === "uia-find") {
        const matches = Array.isArray(result.matches) ? result.matches : [];
        const lines = matches.map((match) => `${match.type.replace("ControlType.", "")} "${match.name}" @ ${match.rect.x},${match.rect.y} ${match.rect.width}x${match.rect.height}${match.enabled ? "" : " (disabled)"}`);
        return { summary: `${matches.length} match(es) for "${options.name}" in "${result.window ?? ""}"`, texts: lines };
      }
      if (args.action === "complete-experiment") {
        const steps = Array.isArray(result.steps) ? result.steps : [];
        return {
          summary: result.completed === true
            ? `experiment completed — the success toast appeared in "${result.window ?? ""}"`
            : `completion not confirmed — no 你已成功完成此实验 toast within 20 s in "${result.window ?? ""}"`,
          texts: steps,
        };
      }
      if (args.action === "wait-text") {
        return {
          summary: result.found === true ? `found "${result.text}"` : `"${options.text}" did not appear within the timeout`,
        };
      }
      if (args.action === "wheel") {
        return { summary: `wheel ${options.delta ?? 3} notch(es) at ${options.x ?? 0},${options.y ?? 0}` };
      }
      if (args.action === "open-url") {
        return { summary: `opened ${options.url} in a new tab of "${result.window ?? ""}"` };
      }
      if (args.action === "shot") {
        const shot = result.screenshot ?? {};
        if (typeof shot.path !== "string") throw new Error("platform.ps1 did not report a screenshot path");
        const png = await readFile(shot.path);
        const image = await attachPng(ctx, png, `lab-platform-${Date.now()}.png`);
        return {
          summary: `${shot.cropped === true ? "cropped screen" : "screen"} ${shot.width}x${shot.height} from ${shot.x},${shot.y} saved to ${shot.path}`,
          path: shot.path,
          image,
        };
      }
      if (result.element !== undefined) {
        const element = result.element;
        return {
          summary: `${args.action} ok (${result.invoked ?? "done"}) on ${element.type.replace("ControlType.", "")} "${element.name}" at ${element.rect.x},${element.rect.y} ${element.rect.width}x${element.rect.height}`,
        };
      }
      return { summary: `${args.action} ok: ${JSON.stringify(result).slice(0, 1500)}` };
    },
  });

  let cdpPage = null;

  const ensureCdpPage = async (match) => {
    if (cdpPage !== null && match === undefined) return cdpPage;
    const pages = await listPages();
    if (pages.length === 0) throw new Error("no Edge page target is available; is Edge running with --remote-debugging-port=9222?");
    const needle = (match ?? "").toLowerCase();
    const target = needle.length > 0
      ? pages.find((page) => `${page.url} ${page.title}`.toLowerCase().includes(needle))
      : pages.find((page) => `${page.url} ${page.title}`.includes("vpn.usts.edu.cn")) ?? pages[0];
    if (target === undefined) throw new Error(`no Edge tab matches "${match}"`);
    if (cdpPage !== null) cdpPage.close();
    cdpPage = await CdpPage.connect(target.webSocketDebuggerUrl);
    return cdpPage;
  };

  tool({
    name: "lab_browser",
    description:
      "Drive the logged-in Edge tab through the Chrome DevTools Protocol (background mode): screenshots, DOM evaluation and synthetic input work without focusing or touching the Edge window, so the user can keep using the computer. " +
      "Requires Edge started once with --remote-debugging-port=9222 (the same profile keeps the WebVPN session). " +
      "actions: pages (list tabs), open {url} (new tab), attach {match} (select tab by url/title), navigate {url}, shot (returns a PNG), texts (page text), eval {expression}, click {text|selector} (DOM click by visible text or CSS selector), click {x,y} (canvas coordinates), type {text}, key {keys: \"enter\" | \"ctrl+shift+v\"}, wait-text {text,timeoutMs}, complete (click 完成实验 → 确定 → wait for the success toast). " +
      "For the noVNC VM: attach to the noVNC tab, click {x,y} on the canvas to focus it, then type/key.",
    parameters: {
      action: {
        type: "string",
        enum: ["pages", "open", "attach", "navigate", "shot", "texts", "eval", "click", "type", "key", "wait-text", "complete"],
        required: true,
        description: "Browser action to run.",
      },
      url: { type: "string", description: "URL for open/navigate." },
      match: { type: "string", description: "Tab URL/title substring for attach." },
      text: { type: "string", description: "Visible text for click, text for type, or needle for wait-text." },
      selector: { type: "string", description: "CSS selector for click." },
      expression: { type: "string", description: "JavaScript expression for eval." },
      x: { type: "integer", description: "Viewport X for a canvas click." },
      y: { type: "integer", description: "Viewport Y for a canvas click." },
      keys: { type: "string", description: "Key or combo, e.g. enter, ctrl+shift+v." },
      timeoutMs: { type: "integer", description: "wait-text/complete wait in milliseconds." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          summary: { type: "string", required: true },
          texts: { type: "array", items: { type: "string" } },
          image: IMAGE_SCHEMA,
        },
      },
      render: (_args, value) => {
        const blocks = [text(value.summary)];
        if (value.texts !== undefined && value.texts.length > 0) blocks.push(text(value.texts.join("\n")));
        if (value.image !== undefined) blocks.push(imageBlock(value.image));
        return blocks;
      },
    },
    isConcurrencySafe: () => false,
    timeoutMs: 90000,
    async execute(args) {
      try {
        if (args.action === "pages") {
          const pages = await listPages();
          return { summary: `${pages.length} page target(s)`, texts: pages.map((page) => `${page.title} — ${page.url}`) };
        }
        if (args.action === "open") {
          if (args.url === undefined) throw new Error("open requires url");
          if (cdpPage !== null) cdpPage.close();
          cdpPage = null;
          const target = await openPage(args.url);
          cdpPage = await CdpPage.connect(target.webSocketDebuggerUrl);
          return { summary: `opened ${target.title || target.url}` };
        }
        if (args.action === "attach") {
          const pages = await listPages();
          if (args.match !== undefined) {
            const needle = args.match.toLowerCase();
            const matched = pages.filter((page) => `${page.url} ${page.title}`.toLowerCase().includes(needle));
            if (matched.length === 0) throw new Error(`no Edge tab matches "${args.match}"`);
          }
          const page = await ensureCdpPage(args.match);
          const title = pages.find((candidate) => candidate.webSocketDebuggerUrl === page.webSocketDebuggerUrl)?.title;
          return { summary: `attached to ${pages.find((candidate) => candidate.webSocketDebuggerUrl === page.webSocketDebuggerUrl)?.url ?? title ?? "tab"}` };
        }
        const page = await ensureCdpPage();
        if (args.action === "navigate") {
          if (args.url === undefined) throw new Error("navigate requires url");
          await page.navigate(args.url);
          return { summary: `navigating to ${args.url}` };
        }
        if (args.action === "shot") {
          const png = await page.screenshot();
          const image = await attachPng(ctx, png, `lab-browser-${Date.now()}.png`);
          return { summary: `page screenshot ${image.width}x${image.height}`, image };
        }
        if (args.action === "texts") {
          const body = await page.evaluate("document.body ? document.body.innerText : ''");
          const lines = String(body ?? "").split("\n").map((line) => line.trim()).filter((line) => line.length > 0).slice(0, 200);
          return { summary: `${lines.length} text line(s)`, texts: lines };
        }
        if (args.action === "eval") {
          if (args.expression === undefined) throw new Error("eval requires expression");
          const value = await page.evaluate(args.expression);
          return { summary: JSON.stringify(value).slice(0, 4000) };
        }
        if (args.action === "click") {
          if (Number.isInteger(args.x) && Number.isInteger(args.y)) {
            await page.mouseClick(args.x, args.y);
            return { summary: `clicked canvas at ${args.x},${args.y}` };
          }
          const textLiteral = JSON.stringify(args.text ?? "");
          const selectorLiteral = args.selector === undefined ? "null" : JSON.stringify(args.selector);
          const clicked = await page.evaluate(`(() => {
            const text = ${textLiteral};
            const selector = ${selectorLiteral};
            let element = null;
            if (selector !== null) element = document.querySelector(selector);
            else {
              const candidates = [...document.querySelectorAll('button,a,span,div,li,label')]
                .filter((node) => node.offsetParent !== null && (node.innerText || '').trim().length > 0);
              element = candidates.find((node) => node.innerText.trim() === text)
                ?? candidates.find((node) => node.innerText.includes(text));
            }
            if (element === null) return null;
            element.scrollIntoView({ block: 'center' });
            element.click();
            return (element.innerText || element.tagName).trim().slice(0, 80);
          })()`);
          if (clicked === null) throw new Error(`no visible element matches ${args.selector ?? args.text}`);
          return { summary: `clicked "${clicked}"` };
        }
        if (args.action === "type") {
          if (args.text === undefined) throw new Error("type requires text");
          await page.typeText(args.text);
          return { summary: `typed ${args.text.length} character(s)` };
        }
        if (args.action === "key") {
          if (args.keys === undefined) throw new Error("key requires keys");
          const keys = args.keys.trim().toLowerCase();
          if (keys.includes("+")) await page.pressCombo(keys.split("+"));
          else await page.pressKey(keys);
          return { summary: `pressed ${keys}` };
        }
        if (args.action === "wait-text") {
          if (args.text === undefined) throw new Error("wait-text requires text");
          const timeoutMs = args.timeoutMs ?? 20000;
          const found = await page.waitFor(`document.body.innerText.includes(${JSON.stringify(args.text)})`, timeoutMs);
          return { summary: found ? `found "${args.text}"` : `"${args.text}" did not appear within ${timeoutMs} ms` };
        }
        if (args.action === "complete") {
          const clicked = await page.evaluate(`(() => {
            const all = [...document.querySelectorAll('button,a,div,span')]
              .filter((node) => node.offsetParent !== null && /完成实验/.test(node.innerText || ''));
            const element = all.find((node) => node.tagName === 'BUTTON') ?? all[0];
            if (element === undefined) return null;
            element.click();
            return (element.innerText || element.tagName).trim().slice(0, 80);
          })()`);
          if (clicked === null) throw new Error("the 完成实验 button was not found in the page");
          const confirmReady = await page.waitFor(
            `(() => [...document.querySelectorAll('button,span,div')].some((node) => node.offsetParent !== null && (node.innerText || '').trim() === '确定'))()`,
            args.timeoutMs ?? 25000,
          );
          if (confirmReady) {
            await page.evaluate(`(() => {
              const node = [...document.querySelectorAll('button,span,div')]
                .find((candidate) => candidate.offsetParent !== null && (candidate.innerText || '').trim() === '确定');
              if (node !== undefined) node.click();
            })()`);
          }
          const success = await page.waitFor("document.body.innerText.includes('你已成功完成此实验')", args.timeoutMs ?? 25000);
          return {
            summary: success
              ? `experiment completed (clicked "${clicked}"${confirmReady ? ", confirmed 确定" : ""})`
              : `completion not confirmed — no success toast after ${args.timeoutMs ?? 25000} ms`,
          };
        }
        throw new Error(`unknown action ${args.action}`);
      } catch (error) {
        if (error instanceof CdpError) {
          cdpPage?.close();
          cdpPage = null;
        }
        throw error;
      }
    },
  });

  tool({
    name: "lab_pdf",
    description:
      "Extract text from an experiment PDF with PyMuPDF and optionally render pages to PNG. " +
      "Use it after downloading the experiment PDF through Edge DevTools (PowerShell/VPN fetches return portal HTML, blob downloads are blocked). " +
      "pages uses 1-based ranges like \"1-3,7\"; renderPages renders up to four selected pages as images for scanned or layout-sensitive content.",
    parameters: {
      path: { type: "string", required: true, description: "PDF path to read." },
      pages: { type: "string", description: "Page selection such as \"1-3,7\" (default: all pages, first 40)." },
      maxChars: { type: "integer", description: `Text budget before truncation (default ${DEFAULT_PDF_CHARS}).` },
      renderPages: { type: "array", items: { type: "integer" }, description: "1-based page numbers to render as PNG (max 4)." },
      dpi: { type: "integer", description: "Render resolution for rendered pages (default 150)." },
      renderDir: { type: "string", description: "Directory for rendered PNGs (default: beside the PDF, <name>_pages)." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          summary: { type: "string", required: true },
          text: { type: "string", required: true },
          pageCount: { type: "integer", required: true },
          truncated: { type: "boolean", required: true },
          images: { type: "array", items: IMAGE_SCHEMA },
        },
      },
      render: (_args, value) => {
        const blocks = [text(value.summary), text(value.text)];
        for (const image of value.images ?? []) blocks.push(imageBlock(image));
        return blocks;
      },
    },
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const pdfPath = resolve(args.path);
      const renderPages = Array.isArray(args.renderPages) ? args.renderPages.slice(0, 4) : [];
      const renderDir = args.renderDir === undefined ? `${pdfPath}_pages` : resolve(args.renderDir);
      const renderSelection = renderPages.length > 0 ? renderPages.join(",") : undefined;
      const first = await runPdf({
        path: pdfPath,
        pages: renderSelection ?? args.pages,
        render: renderPages.length > 0,
        renderDir,
        dpi: args.dpi ?? 150,
      });
      let textOut = first.pages.map((page) => `\n===== page ${page.page} =====\n${page.text}`).join("\n");
      const maxChars = args.maxChars ?? DEFAULT_PDF_CHARS;
      let truncated = first.truncated === true;
      if (textOut.length > maxChars) {
        textOut = `${textOut.slice(0, maxChars)}\n…[truncated at ${maxChars} characters]`;
        truncated = true;
      }
      const images = [];
      for (const rendered of first.rendered ?? []) {
        const png = await readFile(rendered.path);
        images.push(await attachPng(ctx, png, `lab-pdf-p${rendered.page}-${Date.now()}.png`));
      }
      const selected = Array.isArray(first.selected) ? first.selected : [];
      const summary = `PDF ${first.pageCount} page(s); read ${selected.length} (${selected.join(",") || "none"})${first.truncated ? "; selection truncated to 40 pages" : ""}${images.length > 0 ? `; rendered ${images.length} page image(s) into ${renderDir}` : ""}${truncated ? "; text truncated" : ""}`;
      return {
        summary,
        text: textOut.trim().length === 0 ? "(no extractable text; this may be a scanned PDF — use renderPages)" : textOut,
        pageCount: first.pageCount,
        truncated,
        ...(images.length === 0 ? {} : { images }),
      };
    },
  });
}
