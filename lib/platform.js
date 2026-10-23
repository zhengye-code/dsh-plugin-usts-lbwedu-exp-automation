/**
 * Bridge to `scripts/platform.ps1`: Windows UI Automation + screen input for the
 * Ibwedu platform page. The PowerShell helper prints exactly one JSON object and
 * uses a base64 payload so Chinese arguments and quotes never cross a shell.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../scripts/platform.ps1", import.meta.url));

function decodeOutput(stdout) {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.startsWith("{")) continue;
    try {
      return JSON.parse(line);
    } catch {
      /* keep looking for the payload line */
    }
  }
  return undefined;
}

/**
 * Run one platform action.
 * @param {string} action action name understood by platform.ps1
 * @param {Record<string, unknown>} options action options (serialized as JSON)
 * @param {{timeoutMs?: number, executable?: string}} [runtime]
 * @returns {Promise<Record<string, any>>} parsed JSON result
 */
export function runPlatform(action, options = {}, runtime = {}) {
  const executable = runtime.executable ?? process.env.IBWEDU_POWERSHELL ?? "powershell.exe";
  const timeoutMs = runtime.timeoutMs ?? 90000;
  const payload = Buffer.from(JSON.stringify(options), "utf8").toString("base64");
  const args = [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    SCRIPT,
    "-Action",
    action,
    "-Payload",
    payload,
  ];
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      reject(new Error(`cannot start ${executable}: ${error.message}`));
      return;
    }
    const stdout = [];
    const stderr = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      reject(new Error(`platform.ps1 "${action}" did not finish within ${timeoutMs} ms`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const hint = error.code === "ENOENT"
        ? " (Windows PowerShell/pwsh is not on PATH; set IBWEDU_POWERSHELL to the executable)"
        : "";
      reject(new Error(`cannot run Windows PowerShell for platform.ps1: ${error.message}${hint}`));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const parsed = decodeOutput(stdout.join(""));
      if (parsed !== undefined && parsed.ok === false) {
        reject(new Error(`platform.ps1 "${action}" failed: ${parsed.error ?? "unknown error"}`));
        return;
      }
      if (code !== 0) {
        const detail = stderr.join("").trim() || stdout.join("").trim();
        reject(new Error(`platform.ps1 "${action}" exited with code ${code}${detail ? `: ${detail.slice(0, 2000)}` : ""}`));
        return;
      }
      if (parsed === undefined) {
        reject(new Error(`platform.ps1 "${action}" produced no JSON result`));
        return;
      }
      resolve(parsed);
    });
  });
}
