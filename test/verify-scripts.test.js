// Runs the three verify scripts as part of `node --test`, so they're never forgotten. Each runs in
// its own Node process on this folder (all three at once) and must exit 0 with
// "N passed, 0 failed" as its last line. A failure shows the script's FAIL lines, or how it crashed.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const path = require("node:path");

const dir = path.join(__dirname, "..");
const SCRIPTS = ["verify-wiring.js", "verify-band.js", "verify-worker.js"];

const run = (script) =>
  new Promise((resolve) => {
    const options = { cwd: dir, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 };
    execFile(process.execPath, [path.join(dir, script), dir], options, (error, stdout, stderr) =>
      resolve({ code: error ? (error.killed ? `killed after ${options.timeout / 1000} s` : error.code) : 0, stdout, stderr })
    );
  });
const runs = Object.fromEntries(SCRIPTS.map((script) => [script, run(script)])); // started together

for (const script of SCRIPTS) {
  test(`${script} passes`, async () => {
    const { code, stdout, stderr } = await runs[script];
    const last = stdout.trim().split("\n").at(-1) ?? "";
    const fails = stdout.split("\n").filter((line) => line.startsWith("FAIL")).join("\n");
    const why = fails || stderr.trim().split("\n").slice(0, 6).join("\n") || "(no output)";
    assert.equal(code, 0, `${script} exited with ${code}\n${why}\nlast line: ${last}`);
    assert.match(last, /^[1-9]\d* passed, 0 failed$/, `${script} ended with: ${last}`);
  });
}
