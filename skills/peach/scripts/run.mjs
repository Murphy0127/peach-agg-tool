#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const version = "0.6.0";
const args = process.argv.slice(2);
const explicit = process.env.PEACH_AGG_TOOL_BIN;
const candidates = explicit ? [explicit] : ["peach-agg-tool", join(homedir(), ".local", "bin", "peach-agg-tool")];
let command;
for (const candidate of candidates) {
  const probe = spawnSync(candidate, ["--version"], { encoding: "utf8" });
  if (!probe.error && probe.status === 0 && probe.stdout.trim() === version) { command = candidate; break; }
}
if (explicit && !command) {
  console.error(`PEACH_AGG_TOOL_BIN must point to an executable peach-agg-tool ${version}.`);
  process.exit(1);
}
const result = command
  ? spawnSync(command, args, { stdio: "inherit" })
  : spawnSync("npx", ["--yes", `--package=peach-agg-tool@${version}`, "peach-agg-tool", ...args], { stdio: "inherit" });
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
