import assert from "node:assert/strict";
import { isVpnGatewayHost, parseVncEndpoint } from "../lib/rfb.js";

/**
 * The lab VM's websockify port changes per experiment session, so the endpoint
 * must be derived from whatever URL the user copied off the platform page.
 */
const defaults = { host: "192.0.2.10", port: 30505, path: "/websockify" };

const internal = parseVncEndpoint(
  "http://192.0.2.10:12345/index.html?password=vncpassword&resize=scale",
  defaults,
);
assert.deepEqual(internal, { host: "192.0.2.10", port: 12345, path: "/websockify", source: "url" });

assert.deepEqual(parseVncEndpoint("12345", defaults), {
  host: "192.0.2.10",
  port: 12345,
  path: "/websockify",
  source: "port",
});

assert.deepEqual(parseVncEndpoint("ws://192.168.1.9:5900/custom", defaults), {
  host: "192.168.1.9",
  port: 5900,
  path: "/custom",
  source: "url",
});

assert.equal(parseVncEndpoint("192.0.2.10:12345", defaults).port, 12345);
assert.equal(parseVncEndpoint("https://example.org", defaults).port, 443);
assert.equal(parseVncEndpoint("", defaults), null);
assert.equal(parseVncEndpoint(undefined, defaults), null);
assert.throws(() => parseVncEndpoint("::::", defaults), /cannot parse/);

const gateway = parseVncEndpoint("http://192-0-2-10-12345-p.vpn.example.com:8118/index.html", defaults);
assert.equal(gateway.host, "192-0-2-10-12345-p.vpn.example.com");
assert.equal(gateway.port, 8118);
assert.equal(isVpnGatewayHost(gateway.host), true);
assert.equal(isVpnGatewayHost("192.0.2.10"), false);

console.log("endpoint: URL/port parsing and gateway detection OK");
