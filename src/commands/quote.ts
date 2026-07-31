import * as fs from "fs";
import * as path from "path";
import { ethers } from "ethers";
import {
  findSender, resolveApiUrl, DEFAULT_PEACH_ENV,
  NATIVE_TOKEN, WBNB, type AggResult,
} from "../lib/common.js";
import { queryOkx } from "../lib/okx.js";
import { queryPeach } from "../lib/peach.js";
import { resolveToken, tokenLabel, tokenDecimals, fmtAmt } from "../lib/tokens.js";

/**
 * Serialize AggResult to JSON-safe object (BigInt → string).
 */
function serializeResult(r: AggResult, from: string, target: string) {
  return {
    name: r.name,
    ok: r.ok,
    error: r.error ?? null,
    amountIn: r.amountIn.toString(),
    amountOut: r.amountOut.toString(),
    amountOutFmt: r.ok ? fmtAmt(r.amountOut, target) : null,
    latencyMs: r.latencyMs,
    gasEstimate: r.gasEstimate,
    priceImpact: r.priceImpact,
    routes: r.routes.map(rt => ({
      ...rt,
      path: rt.path ?? `${rt.fromToken} → ${rt.toToken}`,
    })),
    simStatus: r.simStatus,
    simAmountOut: r.simAmountOut.toString(),
    simAmountOutFmt: r.simAmountOut > 0n ? fmtAmt(r.simAmountOut, target) : null,
    simLatencyMs: r.simLatencyMs,
    simError: r.simError ?? null,
    simDeviationPct: r.simDeviationPct,
  };
}

export async function cmdQuote(args: string[]) {
  if (args.length < 3) {
    console.error(`Usage: peach-agg-tool quote <from> <target> <amount> [options]

Options:
  --agg <name>         Aggregator: peach, okx, all (default: peach)
  --slippage <bps>     Slippage bps (default: 1000 = 10%)
  --sender <address>   Sender address (auto-detect)
  --rpc <url>          BSC RPC URL
  --env <prod|test>    Peach API env (default: prod = https://api.peach.ag)
  --api <url>          Peach API URL (overrides --env)
  --depth <n>          Peach search depth (default: 3)
  --split <n>          Peach split count (default: 5)
  --providers <list>   Peach providers
  --version <v>        Peach API version: v1, v3, v5 (default: v5)
  --dex-ids <ids>      OKX DEX IDs filter
  --detail             Show route details
  --no-sim             Skip simulation`);
    process.exit(1);
  }

  const from = resolveToken(args[0]);
  const target = resolveToken(args[1]);
  const amountStr = args[2];

  let agg: "peach" | "okx" | "all" = "peach";
  let slippage = 1000, sender = "", rpcUrl = "https://bsc-dataseed.bnbchain.org";
  let apiUrl = "", env = DEFAULT_PEACH_ENV;
  let depth = 3, splitCount = 5, providers = "";
  let version = "v5", dexIds = "";
  let detail = false, doSim = true;

  for (let i = 3; i < args.length; i++) {
    switch (args[i]) {
      case "--agg":       agg = args[++i] as any; break;
      case "--slippage":  slippage = parseInt(args[++i]); break;
      case "--sender":    sender = args[++i]; break;
      case "--rpc":       rpcUrl = args[++i]; break;
      case "--env":       env = args[++i]; break;
      case "--api":       apiUrl = args[++i]; break;
      case "--depth":     depth = parseInt(args[++i]); break;
      case "--split":     splitCount = parseInt(args[++i]); break;
      case "--providers": providers = args[++i]; break;
      case "--version":   version = args[++i]; break;
      case "--dex-ids":   dexIds = args[++i]; break;
      case "--detail":    detail = true; break;
      case "--no-sim":    doSim = false; break;
    }
  }

  apiUrl = resolveApiUrl(apiUrl, env);

  const srcDecimals = tokenDecimals(from);
  const isRawWei = !amountStr.includes(".") && amountStr.length >= 15 && /^\d+$/.test(amountStr);
  const amountIn = isRawWei ? BigInt(amountStr) : ethers.parseUnits(amountStr, srcDecimals);
  const isNative = from.toLowerCase() === WBNB;
  const runPeach = agg === "peach" || agg === "all";
  const runOkx = agg === "okx" || agg === "all";

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  if (!sender) {
    console.error("Finding funded sender...");
    sender = await findSender(provider, from, amountIn, isNative);
    console.error(`  Sender: ${sender}`);
  }

  console.error(`Querying ${agg}...`);

  const results: AggResult[] = [];
  const tasks: Promise<void>[] = [];

  if (runPeach) {
    tasks.push((async () => {
      const r = await queryPeach(from, target, amountIn.toString(), 0, {
        apiUrl, rpcUrl, sender, slippageBps: slippage, provider, doSim,
        depth, splitCount, providers, version,
      });
      results.push(r);
      console.error(`[${r.name}] ${r.ok ? r.latencyMs + "ms" : "FAILED: " + r.error?.slice(0, 60)}`);
    })());
  }

  if (runOkx) {
    tasks.push((async () => {
      const r = await queryOkx(
        isNative ? NATIVE_TOKEN : from,
        target.toLowerCase() === WBNB ? NATIVE_TOKEN : target,
        amountIn.toString(), 0,
        { sender, slippageBps: slippage, provider, rpcUrl, doSim, dexIds },
      );
      results.push(r);
      console.error(`[${r.name}] ${r.ok ? r.latencyMs + "ms" : "FAILED: " + r.error?.slice(0, 60)}`);
    })());
  }

  await Promise.all(tasks);

  // Build structured output
  const output = {
    timestamp: new Date().toISOString(),
    from: { address: from, symbol: tokenLabel(from) },
    target: { address: target, symbol: tokenLabel(target) },
    amountIn: amountIn.toString(),
    amountInFmt: fmtAmt(amountIn, from),
    agg,
    doSim,
    sender,
    results: results.map(r => serializeResult(r, from, target)),
  };

  // Save to log
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const logDir = "/tmp/aggregator";
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `quote-${output.from.symbol}-${output.target.symbol}-${ts}.json`);
  fs.writeFileSync(logFile, JSON.stringify(output, null, 2), "utf-8");

  // Display formatted output via show
  const { cmdShow } = await import("./show.js");
  const showArgs = [logFile];
  if (detail) showArgs.push("--format", "detail");
  await cmdShow(showArgs);
}
