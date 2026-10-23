import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { apply, inject } from "../lib/plugin.js";

/**
 * Load the plugin through the real Cordis runtime (the same copy DSH uses) with
 * a stub `tools` service, to prove that the exported `inject` map satisfies the
 * fiber before apply() touches ctx.tools. This is the check an in-process
 * reinstall cannot prove: a running Host caches modules by specifier.
 *
 * Set DSH_APP_DIR to the DSH app directory when it is not in the default
 * Desktop location.
 */
const appDir = process.env.DSH_APP_DIR ?? "D:/deepseekharness/DSH Desktop/resources/app";
const cordisEntry = `${appDir}/node_modules/@deepseek-ai/cordis/lib/index.js`;
if (!existsSync(cordisEntry)) {
  console.log(`cordis: skipped (no Cordis runtime at ${cordisEntry}; set DSH_APP_DIR)`);
  process.exit(0);
}
const { Context } = await import(pathToFileURL(cordisEntry).href);

assert.deepEqual(inject, ["tools"]);

const tools = [];
const ctx = new Context();
ctx.provide("tools");
ctx.set("tools", {
  register: (definition) => {
    tools.push(definition);
    return () => {};
  },
});

const namespace = { apply, inject };
await ctx.plugin(namespace, {});
assert.deepEqual(
  tools.map((tool) => tool.name),
  ["lab_session", "lab_shot", "lab_act", "lab_platform", "lab_browser", "lab_pdf"],
);

await ctx.dispose?.();
console.log("cordis: apply() ran with inject=['tools'] and registered all six tools");
