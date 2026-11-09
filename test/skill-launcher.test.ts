import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const execute = promisify(execFile);
const launcher = resolve("skills/peach/scripts/run.mjs");

async function withCli(version: string, run: (directory: string, binary: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "peach-skill-launcher-"));
  const binary = join(directory, "fixture-cli.mjs");
  await writeFile(binary, `#!/usr/bin/env node\nconst args=process.argv.slice(2); console.log(args[0]==="--version" ? ${JSON.stringify(version)} : JSON.stringify(args));\n`);
  await chmod(binary, 0o755);
  try { await run(directory, binary); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test("skill launcher runs from another directory and preserves arguments without shell expansion", async () => {
  await withCli("0.6.0", async (directory, binary) => {
    const args = ["benchmark", "USDT", "WBNB", "100", "--chain", "bsc", "literal;$(ignored)"];
    const result = await execute(process.execPath, [launcher, ...args], { cwd: directory,
      env: { ...process.env, PEACH_AGG_TOOL_BIN: binary } });
    assert.deepEqual(JSON.parse(result.stdout), args);
  });
});

test("explicit CLI override with a wrong version fails without fetching another package", async () => {
  await withCli("0.5.5", async (directory, binary) => {
    await assert.rejects(execute(process.execPath, [launcher, "benchmark"], { cwd: directory,
      env: { ...process.env, PEACH_AGG_TOOL_BIN: binary } }), (error: any) => {
      assert.equal(error.code, 1); assert.match(error.stderr, /must point to.*0\.6\.0/); return true;
    });
  });
});
