import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ethers } from "ethers";
import { analyze, simulate, summarize, type Case, type Profile, type Result } from "../lib/benchmark.js";
import { NETWORKS, NATIVE, defaultProfiles } from "../lib/benchmark-model.js";
import { chainToken, decimals, snapshot, verifyBlock, discoverSender, rpc } from "../lib/benchmark-rpc.js";
import { build, fetchQuote, cleanEvidence } from "../lib/benchmark-upstream.js";

const HELP = `Usage: peach-agg-tool benchmark <from> <target> <amount> [options]
  --chain bsc|arc|arc-testnet   Required; ARC mainnet=5042, testnet=5042002
  --agg <list>                peach-prod,peach-pre,kyber,okx,fly or all
  --rpc <url>                 Defaults to PeachManager's PublicNode RPC
  --api <url>                 Override Peach API; default prod/pre catalog by chain
  --profiles <json>           Array of {name,kind,api}
  --sender <address>          Auto-discover a funded EOA when omitted
  --recipient <address>       Defaults to sender
  --raw                       Explicit amount_in in base units
  --slippage <bps>            Default: 50
  --depth <n>                 Peach search depth, default 3 (1..6)
  --split <n>                 Peach split count, default 5 (1..100)
  --providers <csv>           Restrict Peach providers; default all
  --rounds <n>                Repeat fixed case, default 1 (1..1000)
  --interval <seconds>        Between rounds, default 1
  --baseline <name>           Analysis baseline, default first Peach source
  --no-sim                    Quote only; no build or execution simulation
  --out <directory>           Default: /tmp/aggregator
  --report <json>             Re-analyze a saved report offline

Examples:
  peach-agg-tool benchmark USDT WBNB 100 --chain bsc --agg peach-prod,peach-pre,kyber
  peach-agg-tool benchmark USDC 0x171a4217b86a807a64eb94757db6849fb4bdbaa0 1 --chain arc --agg all

ERC-20 only. No private key, wallet signature or transaction broadcast.
OKX/Kyber/Fly credentials use the existing --env-file mechanism.`;

export async function cmdBenchmark(args: string[]) {
  if (args.includes("--help") || (!args.length)) { console.log(HELP); return; }
  const reportOnly = args[0] === "--report";
  if (!reportOnly && (args.length < 3 || args.slice(0, 3).some(a => a.startsWith("--")))) throw new Error(HELP);
  const flags = new Map<string, string>();
  for (let i = reportOnly ? 0 : 3; i < args.length; i++) {
    const key = args[i];
    if (["--raw", "--no-sim"].includes(key)) { flags.set(key, "true"); continue; }
    if (!["--chain", "--rpc", "--api", "--agg", "--profiles", "--sender", "--recipient", "--slippage", "--depth", "--split", "--providers", "--rounds", "--interval", "--baseline", "--out", "--report"].includes(key)) throw new Error(`Unknown option ${key}`);
    const value = args[++i]; if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`);
    flags.set(key, value);
  }
  if (reportOnly) {
    const report = JSON.parse(fs.readFileSync(flags.get("--report")!, "utf8"));
    if (![1, 2].includes(report.schemaVersion) || !Array.isArray(report.results)) throw new Error("Not a benchmark report");
    console.log(JSON.stringify(analyze(report.results, flags.get("--baseline") ?? report.baseline), null, 2)); return;
  }
  const chain = flags.get("--chain") ?? "", network = NETWORKS[chain];
  if (!network) throw new Error("Specify --chain bsc|arc|arc-testnet");
  const rpcUrl = flags.get("--rpc") ?? network.rpc;
  if (!rpcUrl) throw new Error("Specify --rpc for ARC testnet");
  const doSim = !flags.has("--no-sim");
  const numeric = (flag: string, fallback: number, min: number, max: number, integer = true) => {
    const value = Number(flags.get(flag) ?? fallback);
    if (!Number.isFinite(value) || (integer && !Number.isInteger(value)) || value < min || value > max) throw new Error(`${flag} must be ${integer ? "an integer" : "a number"} from ${min} to ${max}`);
    return value;
  };
  const slippageBps = numeric("--slippage", 50, 0, 9999), depth = numeric("--depth", 3, 1, 6), splitCount = numeric("--split", 5, 1, 100);
  const rounds = numeric("--rounds", 1, 1, 1000), interval = numeric("--interval", 1, 0, 3600, false);
  const providers = flags.get("--providers") ?? "";
  if (providers && !providers.split(",").every(p => /^[A-Za-z0-9_-]{1,64}$/.test(p))) throw new Error("Invalid provider list");
  for (const flag of ["--sender", "--recipient"]) if (flags.has(flag) && (!ethers.isAddress(flags.get(flag)!) || flags.get(flag)!.toLowerCase() === ethers.ZeroAddress)) throw new Error(`Invalid ${flag}`);
  const from = chainToken(network.chainId, args[0]), target = chainToken(network.chainId, args[1]);
  if (from === target || from === NATIVE || target === NATIVE) throw new Error("Use distinct ERC-20 tokens; BNB native mode is unsupported, use WBNB");
  let profiles: Profile[];
  if (flags.has("--profiles")) profiles = JSON.parse(fs.readFileSync(flags.get("--profiles")!, "utf8"));
  else {
    const selected = flags.get("--agg") ?? "peach-prod";
    const names = selected === "all" ? ["peach-prod", "peach-pre", "kyber", "okx", ...(chain === "arc" ? ["fly"] : [])] : selected.split(",");
    // Explicit API supports old/custom/testnet deployments, without guessing its chain.
    profiles = flags.has("--api") ? names.map(name => {
      if (["peach", "peach-prod", "peach-pre"].includes(name)) return { name, kind: "peach" as const, api: flags.get("--api")! };
      return defaultProfiles(chain, [name])[0];
    }) : defaultProfiles(chain, names);
  }
  if (!Array.isArray(profiles) || !profiles.length || profiles.length > 10 || profiles.some(p => {
    if (!p || typeof p.name !== "string" || !/^[\w .-]{1,80}$/.test(p.name) || !["peach", "okx", "kyber", "fly"].includes(p.kind) || typeof p.api !== "string") return true;
    try { const url = new URL(p.api); if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return true; } catch { return true; }
    return Object.keys(p).some(key => !["name", "kind", "api"].includes(key));
  })) throw new Error("Invalid profiles configuration (base API URLs cannot contain credentials/query/hash)");
  if (new Set(profiles.map(p => p.name)).size !== profiles.length) throw new Error("Profile names must be unique");
  const baseline = flags.get("--baseline") ?? profiles.find(p => p.kind === "peach")?.name ?? profiles[0].name;
  if (!profiles.some(p => p.name === baseline)) throw new Error("Baseline must be a selected profile name");
  if (!/^\d+(?:\.\d+)?$/.test(args[2]) || (flags.has("--raw") && !/^\d+$/.test(args[2]))) throw new Error("Invalid amount (use an integer with --raw)");
  const directory = flags.get("--out") ?? "/tmp/aggregator";
  fs.mkdirSync(directory, { recursive: true });
  let anyQuote = false, anySimulation = false;
  const history: Result[][] = [], reports: string[] = [];
  let resolvedSender = flags.get("--sender"), senderDiscovery: Awaited<ReturnType<typeof discoverSender>> | undefined;
  let frozenDecimals: [number, number] | undefined;
  for (let round = 1; round <= rounds; round++) {
    const initial = await snapshot(rpcUrl, network.chainId);
    const [fromDecimals, targetDecimals] = await Promise.all([decimals(rpcUrl, from, initial.number), decimals(rpcUrl, target, initial.number)]);
    if (frozenDecimals && (fromDecimals !== frozenDecimals[0] || targetDecimals !== frozenDecimals[1])) throw new Error("Token decimals changed during session; refusing to change the frozen case");
    frozenDecimals ??= [fromDecimals, targetDecimals];
    const amount = flags.has("--raw") ? BigInt(args[2]) : ethers.parseUnits(args[2], fromDecimals);
    if (amount <= 0n || amount >= 1n << 128n) throw new Error("Input amount must be positive and fit u128");
    if (!resolvedSender && (doSim || profiles.some(p => p.kind === "fly"))) {
      console.error(`Discovering funded sender on ${chain} for ${args[0]}...`);
      senderDiscovery = await discoverSender(rpcUrl, network.chainId, from, amount, initial); resolvedSender = senderDiscovery.selected.address;
    }
    const sender = resolvedSender ?? "0x0000000000000000000000000000000000000001";
    const c: Case = { chainId: network.chainId, from, target, amountIn: String(amount), sender,
      recipient: flags.get("--recipient") ?? sender, slippageBps, depth, splitCount, providers, block: initial.number, doSim };
    console.error(`Round ${round}/${rounds}: ${profiles.map(p => p.name).join(", ")} on ${chain}, sender ${sender}`);
    const results = await Promise.all(profiles.map(p => fetchQuote(p, c)));
    if (doSim) {
      await Promise.all(profiles.map((p, i) => build(p, c, results[i])));
      try {
        const block = await snapshot(rpcUrl, network.chainId); c.block = block.number; c.blockMeta = block;
        const [gasPrice, actualInDecimals, actualOutDecimals] = await Promise.all([
          rpc(rpcUrl, "eth_gasPrice", []), decimals(rpcUrl, from, block.number), decimals(rpcUrl, target, block.number),
        ]);
        c.gasPrice = BigInt(gasPrice).toString();
        if (actualInDecimals !== fromDecimals || actualOutDecimals !== targetDecimals) throw new Error("Token decimals changed before simulation; case is unverified");
        await Promise.all(results.map(async r => {
          if (r.ok && !r.buildError) r.simulation = await simulate(c, r.tx, r.spender!, rpcUrl, r);
        }));
        if (!await verifyBlock(rpcUrl, block)) throw new Error("Simulation parent block hash changed; results unverified");
      } catch (error) {
        for (const r of results) if (r.simulation.status === "SUCCESS" || (r.ok && !r.buildError && r.simulation.status === "SKIPPED")) r.simulation = { ...r.simulation, status: "UNAVAILABLE", stage: "rpc", error: (error as Error).message };
      }
    }
    const analysis = analyze(results, baseline);
    const report = cleanEvidence({ schemaVersion: 2, timestamp: new Date().toISOString(), round, baseline, case: c, fromDecimals, targetDecimals,
      rpcOrigin: new URL(rpcUrl).origin, profiles, senderDiscovery, results, analysis });
    const filename = path.join(directory, `benchmark-${network.chainId}-${Date.now()}-${round}.json`);
    fs.writeFileSync(filename, JSON.stringify(report, null, 2), { mode: 0o600, flag: "wx" });
    reports.push(filename); history.push(results);
    console.log(JSON.stringify({ report: filename, round, ...cleanEvidence(analysis) }, null, 2));
    anyQuote ||= results.some(r => r.ok); anySimulation ||= results.some(r => r.simulation.status === "SUCCESS");
    if (round < rounds && interval > 0) await delay(interval * 1000);
  }
  if (rounds > 1) {
    const summary = { schemaVersion: "peach.benchmark-session.v1", chainId: network.chainId, reports, ...summarize(history) };
    const filename = path.join(directory, `benchmark-session-${network.chainId}-${Date.now()}.json`);
    fs.writeFileSync(filename, JSON.stringify(summary, null, 2), { mode: 0o600, flag: "wx" });
    console.log(JSON.stringify({ sessionReport: filename, ...summary }, null, 2));
  }
  if (!anyQuote || (doSim && !anySimulation)) process.exitCode = 1;
}
