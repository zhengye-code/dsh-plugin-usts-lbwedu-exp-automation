import { apply } from "../lib/plugin.js";

/**
 * Registration smoke test: runs the plugin's apply() against a stub context and
 * asserts that defineTool accepts every parameter/output schema. This catches
 * schema-dialect mistakes before the bundle is installed into a profile.
 */
const tools = [];
const disposers = [];
const ctx = {
  tools: {
    register: (definition) => {
      tools.push(definition);
      const dispose = () => {};
      disposers.push(dispose);
      return dispose;
    },
  },
  effect: (callback) => {
    const result = callback();
    return () => {
      if (typeof result === "function") result();
    };
  },
  get: () => undefined,
};

apply(ctx, {});

const names = tools.map((tool) => tool.name);
const expected = ["lab_session", "lab_shot", "lab_act", "lab_platform", "lab_pdf"];
for (const name of expected) {
  if (!names.includes(name)) throw new Error(`missing tool ${name}; got ${names.join(",")}`);
}
for (const tool of tools) {
  if (typeof tool.description !== "string" || tool.description.length < 40) {
    throw new Error(`${tool.name}: description is too short`);
  }
  if (!tool.output || typeof tool.output.render !== "function") throw new Error(`${tool.name}: missing output.render`);
  if (tool.parameters === undefined || tool.parameters.type !== "object") throw new Error(`${tool.name}: missing parameters schema`);
}
const labAct = tools.find((tool) => tool.name === "lab_act");
const actionItems = labAct.parameters.properties.actions.items;
if (actionItems.properties.a.enum.length < 8) throw new Error("lab_act action enum is incomplete");
const labSession = tools.find((tool) => tool.name === "lab_session");
if (labSession.parameters.required?.[0] !== "action") throw new Error("lab_session action must be required");

for (const dispose of disposers) dispose();
console.log(`apply: registered ${names.join(", ")}`);
