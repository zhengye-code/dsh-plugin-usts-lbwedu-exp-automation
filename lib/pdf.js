/**
 * Bridge to `scripts/pdf.py`: PDF text extraction and page rendering through
 * PyMuPDF, the same library the original `tools/readpdf.py` used.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../scripts/pdf.py", import.meta.url));

/**
 * @param {{path: string, pages?: string, render?: boolean, renderDir?: string, dpi?: number}} options
 * @param {{timeoutMs?: number, executable?: string}} [runtime]
 */
export function runPdf(options, runtime = {}) {
  const executable = runtime.executable ?? process.env.IBWEDU_PYTHON ?? "python";
  const timeoutMs = runtime.timeoutMs ?? 120000;
  const payload = Buffer.from(JSON.stringify(options), "utf8").toString("base64");
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(executable, ["-X", "utf8", SCRIPT, payload], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      });
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
      reject(new Error(`pdf.py did not finish within ${timeoutMs} ms`));
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
        ? ` (the "${executable}" executable was not found; set IBWEDU_PYTHON to a Python with PyMuPDF installed)`
        : "";
      reject(new Error(`cannot run Python for pdf.py: ${error.message}${hint}`));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const text = stdout.join("").trim();
      let parsed;
      try {
        parsed = text.length > 0 ? JSON.parse(text) : undefined;
      } catch {
        parsed = undefined;
      }
      if (parsed !== undefined && parsed.ok === false) {
        reject(new Error(`pdf.py failed: ${parsed.error ?? "unknown error"}`));
        return;
      }
      if (code !== 0) {
        const detail = stderr.join("").trim() || text;
        reject(new Error(`pdf.py exited with code ${code}${detail ? `: ${detail.slice(0, 2000)}` : ""}`));
        return;
      }
      if (parsed === undefined) {
        reject(new Error("pdf.py produced no JSON result"));
        return;
      }
      resolve(parsed);
    });
  });
}
