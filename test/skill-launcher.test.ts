import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, chmod, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const execute = promisify(execFile);
const launcher = resolve("skills/peach/scripts/run.mjs");
const version = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version;

async function withCli(version: string, run: (directory: string, binary: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "peach-skill-launcher-"));
  const binary = join(directory, "fixture-cli.mjs");
  await writeFile(binary, `#!/usr/bin/env node\nconst args=process.argv.slice(2); console.log(args[0]==="--version" ? ${JSON.stringify(version)} : JSON.stringify(args));\n`);
  await chmod(binary, 0o755);
  try { await run(directory, binary); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test("skill launcher runs from another directory and preserves arguments without shell expansion", async () => {
  await withCli(version, async (directory, binary) => {
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
      assert.equal(error.code, 1); assert.ok(error.stderr.includes(`must point to an executable peach-agg-tool ${version}`)); return true;
    });
  });
});

test("a fresh user's launcher installs the tagged GitHub asset without a registry release", async () => {
  const directory = await mkdtemp(join(tmpdir(), "peach-skill-fresh-user-"));
  try {
    const npx = join(directory, "npx");
    await writeFile(npx, `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)));\n`);
    await chmod(npx, 0o755);
    const result = await execute(process.execPath, [launcher, "benchmark", "--help"], {
      cwd: directory, env: { ...process.env, HOME: directory, PATH: directory, PEACH_AGG_TOOL_BIN: undefined },
    });
    assert.deepEqual(JSON.parse(result.stdout), ["--yes",
      `--package=https://github.com/Murphy0127/peach-agg-tool/releases/download/v${version}/peach-agg-tool-${version}.tgz`,
      "peach-agg-tool", "benchmark", "--help"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
