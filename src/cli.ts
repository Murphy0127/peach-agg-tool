#!/usr/bin/env node
/**
 * Peach vs OKX aggregator testing tool.
 *
 * Subcommands:
 *   quote         Single pair quote comparison + simulation
 *   compare       Continuous multi-round comparison
 *   dex-stats     OKX DEX usage distribution
 *   analyze       Analyze compare logs
 *   hop-sim       Per-hop on-chain simulation analysis
 *   tax-check     Detect token transfer tax (on-chain)
 *   fetch-tokens  Refresh BSC token data
 *
 * Usage:
 *   npx peach-agg-tool <command> [options]
 *   npx peach-agg-tool -h
 */

import { loadOkxEnv } from "./lib/common.js";

function printHelp() {
  console.log(`
Peach vs OKX DEX Aggregator Testing Tool

Usage:
  npx peach-agg-tool <command> [options]

Global options:
  --env-file <path>    Path to .env file with OKX credentials
                       Default: ~/.config/peach-agg-tool/.env > ~/.okx/.env

Commands:
  quote <from> <target> <amount>    Single pair quote (use --agg all to compare)
  compare [options]                 Continuous multi-round comparison
  dex-stats [options]               OKX DEX usage distribution
  analyze <log.jsonl>               Analyze compare logs
  debug <from> <target> <amount>    Diagnose Peach simulation failures
  hop-sim <from> <target> <amount> Per-hop on-chain simulation analysis
  tax-check <token> [token2 ...]   Detect token transfer tax (on-chain)
  fetch-tokens [options]            Refresh BSC token data from GeckoTerminal

quote options:
  --agg <name>         Aggregator: peach, okx, all (default: peach)
  --slippage <bps>     Slippage in bps (default: 50)
  --sender <addr>      Sender address (auto-detect)
  --rpc <url>          BSC RPC URL
  --api <url>          Peach API URL
  --depth <n>          Peach search depth (default: 3)
  --split <n>          Peach split count (default: 5)
  --dex-ids <ids>      OKX DEX IDs filter

compare options:
  --duration <min>     Duration in minutes (default: 60)
  --interval <sec>     Interval between rounds (default: 10)
  --min-usd <n>        Min trade size in USD (default: 10000)
  --max-usd <n>        Max trade size in USD (default: 1000000)
  --slippage <bps>     Slippage in bps (default: 50)
  --no-sim             Skip simulation
  --out <dir>          Output directory (default: /tmp/aggregator)
  --rpc <url>          BSC RPC URL
  --api <url>          Peach API URL

dex-stats options:
  --duration <min>     Duration in minutes (default: 60)
  --interval <sec>     Interval between rounds (default: 10)
  --min-usd <n>        Min trade size (default: 10000)
  --max-usd <n>        Max trade size (default: 1000000)
  --out <path>         Output file (default: /tmp/aggregator/okx-dex-stats.json)

debug options:
  --rpc <url>          BSC RPC URL
  --api <url>          Peach API URL
  --sender <addr>      Sender address (auto-detect)
  --slippage <bps>     Slippage (default: 50)
  --depth <n>          Search depth (default: 3)
  --split <n>          Split count (default: 5)
  --check-redis        Also check Redis data for sync issues
  --force              Show pool debug even if simulation succeeds

hop-sim options:
  --rpc <url>          BSC RPC URL
  --api <url>          Peach API URL
  --depth <n>          Search depth (default: 3)
  --split <n>          Split count (default: 5)
  --threshold <bps>    Deviation alert threshold (default: 50 = 0.5%)
  --full-sim           Also run full route simulation

tax-check options:
  --rpc <url>          BSC RPC URL
  --amount <bnb>       BNB amount for test swap (default: 0.1)

fetch-tokens options:
  --top <n>            Number of tokens to keep (default: 100)
  --pages <n>          Pool pages to fetch (default: 8)

Examples:
  npx peach-agg-tool quote BNB USDT 1.0
  npx peach-agg-tool quote USDT BNB 100 --agg peach
  npx peach-agg-tool compare --duration 30 --min-usd 1000 --max-usd 100000
  npx peach-agg-tool compare --no-sim --duration 10
  npx peach-agg-tool dex-stats --duration 30
  npx peach-agg-tool analyze /tmp/aggregator/compare-xxx.jsonl
  npx peach-agg-tool debug BNB USDT 1.0
  npx peach-agg-tool debug USDT BNB 100 --check-redis --force
  npx peach-agg-tool hop-sim BNB USDT 1.0
  npx peach-agg-tool hop-sim BNB USDT 1.0 --full-sim
  npx peach-agg-tool tax-check VIN LTC CAKE
  npx peach-agg-tool tax-check 0x85E43bF8... --amount 0.1
  npx peach-agg-tool fetch-tokens --top 50
`);
}

async function main() {
  const args = process.argv.slice(2);

  // Extract global --env-file before command parsing
  let envFilePath: string | undefined;
  const filteredArgs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--env-file") {
      envFilePath = args[++i];
    } else {
      filteredArgs.push(args[i]);
    }
  }

  const cmd = filteredArgs[0];
  const rest = filteredArgs.slice(1);

  if (!cmd || cmd === "-h" || cmd === "--help") { printHelp(); process.exit(0); }
  if (cmd === "-v" || cmd === "--version") {
    const { createRequire } = await import("module");
    const pkg = createRequire(import.meta.url)("../package.json");
    console.log(pkg.version);
    process.exit(0);
  }

  // Load OKX credentials for commands that need them
  if (cmd !== "analyze" && cmd !== "fetch-tokens") {
    loadOkxEnv(envFilePath);
  }

  switch (cmd) {
    case "quote": {
      const { cmdQuote } = await import("./commands/quote.js");
      await cmdQuote(rest);
      break;
    }
    case "compare": {
      const { cmdCompare } = await import("./commands/compare.js");
      await cmdCompare(rest);
      break;
    }
    case "dex-stats": {
      const { cmdDexStats } = await import("./commands/dex-stats.js");
      await cmdDexStats(rest);
      break;
    }
    case "analyze": {
      const { cmdAnalyze } = await import("./commands/analyze.js");
      await cmdAnalyze(rest);
      break;
    }
    case "debug": {
      const { cmdDebug } = await import("./commands/debug.js");
      await cmdDebug(rest);
      break;
    }
    case "hop-sim": {
      const { cmdHopSim } = await import("./commands/hop-sim.js");
      await cmdHopSim(rest);
      break;
    }
    case "tax-check": {
      const { cmdTaxCheck } = await import("./commands/tax-check.js");
      await cmdTaxCheck(rest);
      break;
    }
    case "fetch-tokens": {
      const { cmdFetchTokens } = await import("./commands/fetch-tokens.js");
      await cmdFetchTokens(rest);
      break;
    }
    default:
      console.error(`Unknown command: ${cmd}\nRun with -h for help.`);
      process.exit(1);
  }
}

main().catch((err) => { console.error("Fatal error:", err.message || err); process.exit(1); });
