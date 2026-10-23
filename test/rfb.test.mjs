import assert from "node:assert/strict";
import { createRequire } from "node:module";
import zlib from "node:zlib";
import { LabSession, RfbClient } from "../lib/rfb.js";
import { vncAuthResponse } from "../lib/des.js";

/**
 * End-to-end RFB test against a local mock websockify + VNC server.
 *
 * The mock speaks RFB 003.008, offers VNC authentication (table 2), answers a
 * FramebufferUpdateRequest with one Raw rect of a known gradient, and records
 * pointer/key messages. This exercises transport reassembly, handshake, pixel
 * format negotiation, Raw decoding and the PNG writer without the lab network.
 */

const requireFromApp = createRequire("D:/deepseekharness/DSH Desktop/resources/app/package.json");
const { WebSocketServer } = requireFromApp("ws");

const PASSWORD = "testpass";
const WIDTH = 64;
const HEIGHT = 48;

function expectedPixel(x, y) {
  return { r: (x + y) % 256, g: (y * 5) % 256, b: (x * 3) % 256 };
}

function serverInit() {
  const width = Buffer.alloc(2);
  width.writeUInt16BE(WIDTH);
  const height = Buffer.alloc(2);
  height.writeUInt16BE(HEIGHT);
  const pixelFormat = Buffer.from([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0]);
  const nameBytes = Buffer.from("mock-vnc", "latin1");
  const nameLength = Buffer.alloc(4);
  nameLength.writeUInt32BE(nameBytes.length);
  return Buffer.concat([width, height, pixelFormat, nameLength, nameBytes]);
}

function rawUpdate() {
  const header = Buffer.alloc(16);
  header[0] = 0;
  header.writeUInt16BE(1, 2);
  header.writeUInt16BE(0, 4);
  header.writeUInt16BE(0, 6);
  header.writeUInt16BE(WIDTH, 8);
  header.writeUInt16BE(HEIGHT, 10);
  header.writeInt32BE(0, 12);
  const pixels = Buffer.alloc(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const offset = (y * WIDTH + x) * 4;
      const pixel = expectedPixel(x, y);
      pixels[offset] = pixel.b;
      pixels[offset + 1] = pixel.g;
      pixels[offset + 2] = pixel.r;
      pixels[offset + 3] = 0;
    }
  }
  return Buffer.concat([header, pixels]);
}

function makeServer() {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const events = [];
  wss.on("connection", (socket) => {
    let buffer = Buffer.alloc(0);
    const waiters = [];
    const pump = () => {
      while (waiters.length > 0 && buffer.length >= waiters[0].n) {
        const waiter = waiters.shift();
        const chunk = buffer.subarray(0, waiter.n);
        buffer = buffer.subarray(waiter.n);
        waiter.resolve(Buffer.from(chunk));
      }
    };
    const recv = (n) => new Promise((resolve, reject) => {
      waiters.push({ n, resolve, reject });
      pump();
    });
    socket.on("message", (data) => {
      buffer = Buffer.concat([buffer, Buffer.from(data)]);
      pump();
    });
    const socketClosed = new Promise((resolve) => socket.on("close", resolve));
    (async () => {
      try {
        socket.send(Buffer.from("RFB 003.008\n", "latin1"));
        const greeting = await recv(12);
        assert.equal(greeting.toString("latin1"), "RFB 003.008\n");
        socket.send(Buffer.from([1, 2]));
        const chosen = await recv(1);
        assert.equal(chosen[0], 2);
        const challenge = Buffer.from("0123456789abcdef", "latin1");
        socket.send(challenge);
        const response = await recv(16);
        assert.equal(response.toString("hex"), vncAuthResponse(challenge, PASSWORD).toString("hex"));
        const result = Buffer.alloc(4);
        socket.send(result);
        const clientInit = await recv(1);
        assert.equal(clientInit[0], 1);
        socket.send(serverInit());
        assert.equal((await recv(20)).length, 20);
        assert.equal((await recv(4)).length, 4);
        while (true) {
          const header = await recv(1);
          const type = header[0];
          if (type === 3) {
            const rest = await recv(9);
            events.push({ type: "framebuffer", incremental: rest[0] });
            socket.send(rawUpdate());
          } else if (type === 4) {
            const rest = await recv(7);
            events.push({ type: "key", down: rest[0] === 1, keysym: rest.readUInt32BE(3) });
          } else if (type === 5) {
            const rest = await recv(5);
            events.push({ type: "pointer", mask: rest[0], x: rest.readUInt16BE(1), y: rest.readUInt16BE(3) });
          } else if (type === 6) {
            const rest = await recv(7);
            const length = rest.readUInt32BE(3);
            const text = await recv(length);
            events.push({ type: "clipboard", text: text.toString("latin1") });
          } else {
            throw new Error(`mock server saw unknown message type ${type}`);
          }
        }
      } catch (error) {
        events.push({ type: "server-error", error: String(error) });
        socket.close();
      }
    })();
    socket.on("error", () => {});
    socket.on("close", () => socketClosed);
  });
  return new Promise((resolve) => {
    wss.once("listening", () => resolve({ wss, port: wss.address().port, events }));
  });
}

function pngChunks(png) {
  const chunks = [];
  let offset = 8;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    chunks.push({ type, data });
    offset += 12 + length;
  }
  return chunks;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

const { wss, port, events } = await makeServer();
try {
  const client = await RfbClient.connect({ host: "127.0.0.1", port, path: "/websockify", password: PASSWORD });
  assert.equal(client.width, WIDTH);
  assert.equal(client.height, HEIGHT);
  assert.equal(client.name, "mock-vnc");

  await client.click(10, 20);
  await settle();
  const pointerEvents = events.filter((event) => event.type === "pointer");
  assert.equal(pointerEvents.length, 3, JSON.stringify(pointerEvents));
  assert.deepEqual(pointerEvents[0], { type: "pointer", mask: 0, x: 10, y: 20 });
  assert.equal(pointerEvents[1].mask, 1);
  assert.equal(pointerEvents[2].mask, 0);

  await client.typeText("A_", { intervalMs: 0 });
  await settle();
  const keysyms = events.filter((event) => event.type === "key" && event.down).map((event) => event.keysym);
  assert.deepEqual(keysyms, [0x41, 0x5f], "uppercase and underscore must be sent as final keysyms");

  await client.keyCombo(["ctrl", "shift", "v"]);
  await settle();
  const comboDown = events.filter((event) => event.type === "key" && event.down).slice(2).map((event) => event.keysym);
  assert.deepEqual(comboDown, [0xffe3, 0xffe1, 0x76]);

  client.clipboard("hello");
  await settle();
  assert.equal(events.filter((event) => event.type === "clipboard").at(-1).text, "hello");

  client.requestFrame(0);
  const { framebuffer, received } = await client.readUpdate(3000);
  assert.equal(received, true);
  for (const [x, y] of [[0, 0], [5, 7], [63, 47]]) {
    const offset = (y * WIDTH + x) * 4;
    const pixel = expectedPixel(x, y);
    assert.equal(framebuffer[offset], pixel.b);
    assert.equal(framebuffer[offset + 1], pixel.g);
    assert.equal(framebuffer[offset + 2], pixel.r);
  }
  client.close();

  // Session-level: reconnect, screenshot, PNG encoding round-trip.
  const session = new LabSession({ host: "127.0.0.1", port, path: "/websockify", password: PASSWORD, timeoutMs: 5000 });
  const info = await session.connect();
  assert.equal(info.width, WIDTH);
  const shot = await session.screenshot({ timeoutMs: 3000 });
  assert.equal(shot.width, WIDTH);
  assert.equal(shot.height, HEIGHT);

  const { encodePng } = await import("../lib/png.js");
  const { framebufferToRgb } = await import("../lib/png.js");
  const png = encodePng(framebufferToRgb(shot.framebuffer, WIDTH, HEIGHT), WIDTH, HEIGHT);
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  const chunks = pngChunks(png);
  const ihdr = chunks.find((chunk) => chunk.type === "IHDR").data;
  assert.equal(ihdr.readUInt32BE(0), WIDTH);
  assert.equal(ihdr.readUInt32BE(4), HEIGHT);
  assert.equal(ihdr[8], 8);
  assert.equal(ihdr[9], 2);
  const raw = zlib.inflateSync(chunks.find((chunk) => chunk.type === "IDAT").data);
  assert.equal(raw.length, (WIDTH * 3 + 1) * HEIGHT);
  assert.equal(raw[0], 0, "first scanline uses filter 0");
  const first = expectedPixel(0, 0);
  assert.deepEqual([...raw.subarray(1, 4)], [first.r, first.g, first.b]);
  const last = expectedPixel(63, 47);
  const lastRowOffset = (HEIGHT - 1) * (WIDTH * 3 + 1) + 1 + 63 * 3;
  assert.deepEqual([...raw.subarray(lastRowOffset, lastRowOffset + 3)], [last.r, last.g, last.b]);

  await session.disconnect();
  assert.equal(session.connected, false);

  // Endpoint discovery: scan a one-port range that only the mock VNC answers.
  const discovery = new LabSession({ host: "127.0.0.1", port: 1, path: "/websockify", password: PASSWORD, timeoutMs: 5000 });
  const found = await discovery.discover({ from: port, to: port, concurrency: 1, probeTimeoutMs: 2000 });
  assert.deepEqual(found.candidates.map((candidate) => candidate.port), [port]);
  assert.equal(found.connected, true);
  assert.equal(discovery.info().width, WIDTH);
  await discovery.disconnect();

  assert.equal(events.find((event) => event.type === "server-error"), undefined, JSON.stringify(events.filter((event) => event.type === "server-error")));
} finally {
  wss.close();
}

console.log("rfb: mock handshake, input, raw framebuffer, session and PNG OK");

