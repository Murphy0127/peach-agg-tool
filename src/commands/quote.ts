import * as fs from "fs";
import * as path from "path";
import { ethers } from "ethers";
import {
  pad, padL, fmtN, printKV, printTable, findSender,
  NATIVE_TOKEN, WBNB, type AggResult,
} from "../lib/common.js";
import { queryOkx } from "../lib/okx.js";
import { queryPeach } from "../lib/peach.js";
import { resolveToken, tokenLabel, tokenDecimals, fmtAmt } from "../lib/tokens.js";

export async function cmdQuote(args: string[]) {
  if (args.length < 3) {
    console.error(`Usage: agg-tool quote <from> <target> <amount> [options]

Options:
  --agg <name>         聚合器: peach, okx, all (默认: peach)
  --slippage <bps>     滑点基点 (默认: 50 = 0.5%)
  --sender <address>   发送地址 (自动检测)
  --rpc <url>          BSC RPC URL
  --api <url>          Peach API URL
  --depth <n>          Peach 搜索深度 (默认: 3)
  --split <n>          Peach 分割数 (默认: 5)
  --providers <list>   Peach providers
  --version <v>        Peach API 版本: v1, v3, v5 (默认: v5)
  --dex-ids <ids>      OKX DEX IDs 过滤`);
    process.exit(1);
  }

  const from = resolveToken(args[0]);
  const target = resolveToken(args[1]);
  const amountStr = args[2];

  let agg: "peach" | "okx" | "all" = "peach";
  let slippage = 50, sender = "", rpcUrl = "https://bsc-dataseed.bnbchain.org";
  let apiUrl = "https://api.cipheron.org";
  let depth = 3, splitCount = 5, providers = "PANCAKEV2,PANCAKEV3,UNISWAPV3,DODO,THENA";
  let version = "v5", dexIds = "";

  for (let i = 3; i < args.length; i++) {
    switch (args[i]) {
      case "--agg":       agg = args[++i] as any; break;
      case "--slippage":  slippage = parseInt(args[++i]); break;
      case "--sender":    sender = args[++i]; break;
      case "--rpc":       rpcUrl = args[++i]; break;
      case "--api":       apiUrl = args[++i]; break;
      case "--depth":     depth = parseInt(args[++i]); break;
      case "--split":     splitCount = parseInt(args[++i]); break;
      case "--providers": providers = args[++i]; break;
      case "--version":   version = args[++i]; break;
      case "--dex-ids":   dexIds = args[++i]; break;
    }
  }

  const srcDecimals = tokenDecimals(from);
  const isRawWei = !amountStr.includes(".") && amountStr.length >= 15 && /^\d+$/.test(amountStr);
  const amountIn = isRawWei ? BigInt(amountStr) : ethers.parseUnits(amountStr, srcDecimals);
  const isNative = from.toLowerCase() === WBNB;
  const runPeach = agg === "peach" || agg === "all";
  const runOkx = agg === "okx" || agg === "all";

  console.log();
  console.log(`=== Aggregator ${agg === "all" ? "Comparison" : "Quote"} Test ===`);
  console.log();
  printKV([
    ["From", `${tokenLabel(from)} (${from})`],
    ["To", `${tokenLabel(target)} (${target})`],
    ["Amount", `${fmtAmt(amountIn, from)} ${tokenLabel(from)}`],
    ["Slippage", `${slippage} bps (${slippage / 100}%)`],
    ["Aggregator", agg],
  ]);
  console.log();

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  if (!sender) {
    console.log("Finding funded sender...");
    sender = await findSender(provider, from, amountIn, isNative);
    console.log(`  Sender: ${sender}\n`);
  }

  const results: AggResult[] = [];
  const tasks: Promise<void>[] = [];

  if (runPeach) {
    tasks.push((async () => {
      console.log(`[Peach] Fetching quote + simulating...`);
      const r = await queryPeach(from, target, amountIn.toString(), 0, {
        apiUrl, rpcUrl, sender, slippageBps: slippage, provider, doSim: true,
        depth, splitCount, providers, version,
      });
      results.push(r);
      console.log(`[Peach] Done (${r.latencyMs}ms) ${r.ok ? "" : "FAILED: " + r.error?.slice(0, 80)}`);
    })());
  }

  if (runOkx) {
    tasks.push((async () => {
      console.log(`[OKX]   Fetching quote + simulating...`);
      const r = await queryOkx(
        isNative ? NATIVE_TOKEN : from,
        target.toLowerCase() === WBNB ? NATIVE_TOKEN : target,
        amountIn.toString(), 0,
        { sender, slippageBps: slippage, provider, doSim: true, dexIds },
      );
      results.push(r);
      console.log(`[OKX]   Done (${r.latencyMs}ms) ${r.ok ? "" : "FAILED: " + r.error?.slice(0, 80)}`);
    })());
  }

  await Promise.all(tasks);

  // Print individual results
  for (const r of results) {
    console.log();
    console.log(`=== ${r.name} ===`);
    console.log();
    printKV([
      ["Amount In", `${fmtAmt(r.amountIn, from)} ${tokenLabel(from)}`],
      ["Amount Out", r.ok ? `${fmtAmt(r.amountOut, target)} ${tokenLabel(target)}` : `ERROR: ${r.error}`],
      ["Gas Estimate", r.gasEstimate],
      ["Price Impact", `${r.priceImpact}%`],
      ["Latency", `${r.latencyMs}ms`],
    ]);
    if (r.routes.length > 0) {
      console.log();
      const rows = r.routes.map((rt, i) => [(i + 1).toString(), rt.path ?? `${rt.fromToken} -> ${rt.toToken}`, rt.dexName, rt.percent > 0 ? `${(rt.percent * 100).toFixed(0)}%` : "-"]);
      printTable(["#", "Path", "DEX", "Pct"], rows, ["r", "l", "l", "r"]);
    }
    console.log();
    if (r.simStatus === "SUCCESS") {
      const diff = r.amountOut > 0n ? Number((r.simAmountOut - r.amountOut) * 10000n / r.amountOut) / 100 : 0;
      printKV([
        ["Simulation", "SUCCESS"],
        ["Sim Out", `${fmtAmt(r.simAmountOut, target)} ${tokenLabel(target)}`],
        ["Quote Out", `${fmtAmt(r.amountOut, target)} ${tokenLabel(target)}`],
        ["Diff", `${diff >= 0 ? "+" : ""}${diff.toFixed(4)}%`],
      ]);
    } else if (r.simStatus === "FAILED") {
      printKV([["Simulation", "FAILED"], ["Error", (r.simError ?? "").slice(0, 120)]]);
    } else {
      printKV([["Simulation", "SKIPPED"]]);
    }
  }

  // Comparison table
  if (agg === "all" && results.filter(r => r.ok).length > 1) {
    console.log();
    console.log("=== Comparison ===");
    console.log();
    const sorted = [...results].sort((a, b) => (b.amountOut > a.amountOut ? 1 : b.amountOut < a.amountOut ? -1 : 0));
    const best = sorted[0];
    const simOk = results.filter(r => r.simStatus === "SUCCESS" && r.simAmountOut > 0n);
    const simBest = simOk.length > 0 ? simOk.reduce((a, b) => (a.simAmountOut > b.simAmountOut ? a : b)) : null;

    const rows = sorted.map(r => {
      const diff = best.amountOut > 0n && r !== best
        ? `${(Number((r.amountOut - best.amountOut) * 10000n / best.amountOut) / 100).toFixed(4)}%` : "BEST";
      const simLabel = r.simStatus === "SUCCESS" && r.simAmountOut > 0n ? fmtAmt(r.simAmountOut, target) : r.simStatus;
      const simBestLabel = r === simBest ? "BEST"
        : (r.simStatus === "SUCCESS" && r.simAmountOut > 0n && simBest) ? `${(Number((r.simAmountOut - simBest.simAmountOut) * 10000n / simBest.simAmountOut) / 100).toFixed(4)}%` : "-";
      return [r.name, fmtAmt(r.amountOut, target), diff, simLabel, simBestLabel, `${r.latencyMs}ms`];
    });
    printTable(["Aggregator", `Out (${tokenLabel(target)})`, "vs Best", "Sim Out", "Sim Best", "Latency"], rows, ["l", "r", "r", "r", "r", "r"]);
  }

  // Write log
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const logDir = "/tmp/aggregator";
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `quote-${tokenLabel(from)}-${tokenLabel(target)}-${ts}.log`);
  const lines: string[] = [];
  lines.push(`Aggregator Quote Test | ${new Date().toISOString()}`);
  lines.push(`${tokenLabel(from)} -> ${tokenLabel(target)} | Amount: ${fmtAmt(amountIn, from)} | Sender: ${sender}`);
  for (const r of results) {
    lines.push(`[${r.name}] out=${r.ok ? fmtAmt(r.amountOut, target) : "ERR"} sim=${r.simStatus} simOut=${r.simAmountOut > 0n ? fmtAmt(r.simAmountOut, target) : "-"} ${r.latencyMs}ms`);
  }
  lines.push(JSON.stringify(results.map(r => ({ ...r, amountIn: r.amountIn.toString(), amountOut: r.amountOut.toString(), simAmountOut: r.simAmountOut.toString() })), null, 2));
  fs.writeFileSync(logFile, lines.join("\n"), "utf-8");
  console.log(`\nLog: ${logFile}\n`);
}
