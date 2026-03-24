/**
 * hop-sim command: per-hop on-chain simulation to pinpoint quote discrepancies.
 *
 * Two-layer analysis:
 *   1. Per-hop pool-level simulation (reserve math / V3 quoter) — shows pool data accuracy
 *   2. Full route eth_call via SDK — shows actual output including transfer tax
 *   Comparing the two reveals whether discrepancy is from stale data or transfer tax.
 *
 * Also uses SDK's findFailingStep to pinpoint which step causes the revert.
 */

import { ethers } from "ethers";
import { PeachClient, BSC_MAINNET_CONFIG } from "@pagg/aggregator-sdk";
import type { Quote } from "@pagg/aggregator-sdk";
import {
  printKV, printTable, findSender, WBNB, decodeRevert,
} from "../lib/common.js";
import { resolveToken, tokenLabel, tokenDecimals, fmtAmt } from "../lib/tokens.js";
import { simHop, type HopData, type HopSimResult } from "../lib/pool-sim.js";

// ── Helpers ──────────────────────────────────────────────────────────

function fmtDev(bps: number): string {
  const sign = bps >= 0 ? "+" : "";
  return `${sign}${(bps / 100).toFixed(2)}%`;
}

function statusIcon(status: string): string {
  switch (status) {
    case "OK": return "✓";
    case "STALE_DATA": return "⚠ STALE";
    case "SIM_FAILED": return "✗ FAILED";
    default: return "?";
  }
}

// ── Main command ────────────────────────────────────────────────────

export async function cmdHopSim(args: string[]) {
  if (args.length < 3) {
    console.error(`Usage: peach-agg-tool hop-sim <from> <target> <amount> [options]

Two-layer per-hop analysis:
  1. Per-hop pool simulation (reserve math / V3 quoter) — tests pool data accuracy
  2. Full route eth_call via Router contract — shows actual output with transfer tax
  3. SDK findFailingStep — pinpoints which step causes the revert

Options:
  --rpc <url>          BSC RPC URL
  --api <url>          Peach API URL
  --sender <address>   Sender address
  --slippage <bps>     Slippage (default: 50)
  --depth <n>          Search depth (default: 3)
  --split <n>          Split count (default: 5)
  --providers <list>   DEX providers
  --threshold <bps>    Deviation alert threshold (default: 50 = 0.5%)

Examples:
  npx peach-agg-tool hop-sim BNB USDT 1.0
  npx peach-agg-tool hop-sim USDT BNB 100 --threshold 10`);
    process.exit(1);
  }

  const from = resolveToken(args[0]);
  const target = resolveToken(args[1]);
  const amountStr = args[2];

  let slippage = 50, sender = "", rpcUrl = "https://bsc-dataseed.bnbchain.org";
  let apiUrl = "https://api.cipheron.org";
  let depth = 3, splitCount = 5, providers = "PANCAKEV2,PANCAKEV3,UNISWAPV3,DODO,THENA";
  let version = "v5", thresholdBps = 50;

  for (let i = 3; i < args.length; i++) {
    switch (args[i]) {
      case "--slippage":  slippage = parseInt(args[++i]); break;
      case "--sender":    sender = args[++i]; break;
      case "--rpc":       rpcUrl = args[++i]; break;
      case "--api":       apiUrl = args[++i]; break;
      case "--depth":     depth = parseInt(args[++i]); break;
      case "--split":     splitCount = parseInt(args[++i]); break;
      case "--providers": providers = args[++i]; break;
      case "--version":   version = args[++i]; break;
      case "--threshold": thresholdBps = parseInt(args[++i]); break;
    }
  }

  const srcDecimals = tokenDecimals(from);
  const isRawWei = !amountStr.includes(".") && amountStr.length >= 15 && /^\d+$/.test(amountStr);
  const amountIn = isRawWei ? BigInt(amountStr) : ethers.parseUnits(amountStr, srcDecimals);
  const isNative = from.toLowerCase() === WBNB;

  const rpcProvider = new ethers.JsonRpcProvider(rpcUrl);
  if (!sender) {
    sender = await findSender(rpcProvider, from, amountIn, isNative);
  }

  const config = { ...BSC_MAINNET_CONFIG, rpcUrl };
  const client = new PeachClient(config, rpcProvider, { api: { baseUrl: apiUrl, timeout: 30000 } });

  console.log();
  console.log("═══════════════════════════════════════════════════════");
  console.log("  Per-Hop On-Chain Simulation");
  console.log("═══════════════════════════════════════════════════════");
  console.log();
  printKV([
    ["From", `${tokenLabel(from)} (${from})`],
    ["To", `${tokenLabel(target)} (${target})`],
    ["Amount", `${fmtAmt(amountIn, from)} ${tokenLabel(from)}`],
    ["API", apiUrl],
    ["RPC", rpcUrl],
    ["Threshold", `${thresholdBps} bps (${(thresholdBps / 100).toFixed(1)}%)`],
  ]);

  // Step 1: Fetch Peach quote + build SDK Quote
  console.log("\n[1/4] Fetching Peach quote...");

  const routeParams = new URLSearchParams({
    from, target, amount: amountIn.toString(),
    by_amount_in: "true", depth: depth.toString(),
    split_count: splitCount.toString(), providers, v: "1001500",
  });
  const endpoint = version === "v5" ? "find_routes" : `find_routes_${version}`;
  const routeUrl = `${apiUrl}/router/${endpoint}?${routeParams}`;

  const routeStart = Date.now();
  const resp = await fetch(routeUrl, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(30000) });
  const json = await resp.json() as any;
  const latencyMs = Date.now() - routeStart;

  if (json?.code !== 200 || !json?.data) {
    console.log(`  Quote FAILED: ${json?.msg ?? "unknown"} (code: ${json?.code})`);
    return;
  }

  const quote: Quote = client.buildQuoteFromRouteData(json.data, from, target);
  const dstDecimals = tokenDecimals(target);

  // Extract path hops for display
  const hops: HopData[] = (json.data.paths as any[]).map(p => ({
    pool: p.pool ?? p.pool_id ?? "",
    provider: p.provider,
    tokenIn: p.token_in,
    tokenOut: p.token_out,
    amountIn: p.amount_in,
    amountOut: p.amount_out,
    feeRate: p.fee_rate,
  }));

  // Build state overrides for simulation
  const routerAddress = quote.routerAddress ?? config.routerAddress;
  const stateOverrides = isNative
    ? undefined
    : client.buildStateOverrides(from, sender, routerAddress, amountIn * 2n);

  // Step 2: Full route simulation via SDK
  console.log("[2/4] Full route simulation via Router contract...");

  let fullSimOut = 0n;
  let fullSimStatus = "SUCCESS";
  let fullSimError: any = null;
  let fullSimErrorMsg = "";
  try {
    const sim = await client.simulate(quote, slippage, sender, stateOverrides);
    fullSimOut = sim.amountOut;
  } catch (err: any) {
    fullSimStatus = "FAILED";
    fullSimError = err;
    fullSimErrorMsg = err.message?.slice(0, 120) ?? String(err);
    // Try to decode revert
    const rd = err.data || err.info?.error?.data;
    if (rd) {
      const decoded = decodeRevert(rd, target);
      if (decoded) fullSimErrorMsg = decoded;
    }
  }

  printKV([
    ["Quote", `${ethers.formatUnits(quote.amountOut, dstDecimals)} ${tokenLabel(target)}`],
    ["Hops", hops.length.toString()],
    ["Latency", `${latencyMs}ms`],
    ["Full Sim", fullSimStatus === "SUCCESS"
      ? `${ethers.formatUnits(fullSimOut, dstDecimals)} ${tokenLabel(target)}`
      : `FAILED — ${fullSimErrorMsg}`],
  ]);

  // Step 3: Per-hop pool-level simulation (reserve math / quoter)
  console.log(`\n[3/4] Per-hop pool simulation (${hops.length} hop(s))...\n`);

  const simResults: HopSimResult[] = [];
  for (let i = 0; i < hops.length; i++) {
    const hop = hops[i];
    process.stdout.write(`  [${i + 1}/${hops.length}] ${hop.provider} ${hop.pool.slice(0, 10)}... `);
    const sr = await simHop(rpcProvider, hop, thresholdBps);
    simResults.push(sr);
    console.log(statusIcon(sr.status));
  }

  // Print per-hop table
  console.log();
  const rows = simResults.map((sr, i) => {
    const outDec = tokenDecimals(sr.tokenOut);
    return [
      (i + 1).toString(),
      sr.pool.slice(0, 10) + "...",
      sr.provider,
      `${tokenLabel(sr.tokenIn)} → ${tokenLabel(sr.tokenOut)}`,
      ethers.formatUnits(sr.peachAmountOut, outDec),
      sr.status === "SIM_FAILED" ? (sr.error?.slice(0, 20) ?? "FAILED") : ethers.formatUnits(sr.onchainAmountOut, outDec),
      sr.status === "SIM_FAILED" ? "-" : fmtDev(sr.deviationBps),
      statusIcon(sr.status),
    ];
  });
  printTable(
    ["#", "Pool", "Provider", "Path", "Peach Out", "On-chain Out", "Dev", "Status"],
    rows,
  );

  // Step 4: findFailingStep if full sim failed
  let failingStep: { stepIndex: number; revertMessage?: string } | null = null;
  if (fullSimStatus === "FAILED") {
    console.log(`\n[4/4] Finding failing step via SDK...`);
    try {
      failingStep = await client.findFailingStep(quote, slippage, sender, stateOverrides, fullSimError);
      if (failingStep) {
        const fHop = hops[failingStep.stepIndex];
        console.log(`  → Step ${failingStep.stepIndex + 1}: ${fHop.provider} ${fHop.pool.slice(0, 16)}...`);
        console.log(`    ${tokenLabel(fHop.tokenIn)} → ${tokenLabel(fHop.tokenOut)}`);
        if (failingStep.revertMessage) {
          console.log(`    Revert: ${failingStep.revertMessage}`);
        }
      } else {
        console.log("  → Could not identify specific failing step (revert reason mismatch).");
      }
    } catch (err: any) {
      console.log(`  → findFailingStep error: ${err.message?.slice(0, 80)}`);
    }
  } else {
    console.log("\n[4/4] Skipped (simulation succeeded).");
  }

  // ── Diagnosis ──────────────────────────────────────────────────────

  const staleHops = simResults.filter(r => r.status === "STALE_DATA");
  const failedHops = simResults.filter(r => r.status === "SIM_FAILED");
  const poolDataOk = staleHops.length === 0 && failedHops.length === 0;

  console.log();
  console.log("═══════════════════════════════════════════════════════");
  console.log("  Diagnosis");
  console.log("═══════════════════════════════════════════════════════\n");

  // Pool data issues
  if (staleHops.length > 0) {
    console.log(`  ⚠ ${staleHops.length} hop(s) have stale pool data:\n`);
    for (const h of staleHops) {
      console.log(`    ${h.provider} ${h.pool.slice(0, 16)}...`);
      console.log(`      Peach: ${ethers.formatUnits(h.peachAmountOut, tokenDecimals(h.tokenOut))} ${tokenLabel(h.tokenOut)}`);
      console.log(`      Chain: ${ethers.formatUnits(h.onchainAmountOut, tokenDecimals(h.tokenOut))} ${tokenLabel(h.tokenOut)}`);
      console.log(`      Dev:   ${fmtDev(h.deviationBps)}\n`);
    }
  }
  if (failedHops.length > 0) {
    console.log(`  ✗ ${failedHops.length} hop(s) failed pool simulation:\n`);
    for (const h of failedHops) {
      console.log(`    ${h.provider} ${h.pool.slice(0, 16)}... — ${h.error}`);
    }
    console.log();
  }

  // Cross-layer analysis: pool math vs Router sim
  if (poolDataOk && fullSimStatus === "FAILED") {
    console.log("  Pool data: ✓ All hops match on-chain (reserve math / quoter)");
    console.log(`  Router sim: ✗ FAILED — ${fullSimErrorMsg}\n`);
    console.log("  → Pool math correct but actual swap fails.");
    console.log("    This indicates TRANSFER TAX on intermediate token(s).");
    console.log("    (Reserve math ignores tax; actual transfers trigger it.)\n");

    // Collect intermediate tokens
    const intermediates = new Set<string>();
    for (const h of hops) {
      const tin = h.tokenIn.toLowerCase();
      const tout = h.tokenOut.toLowerCase();
      if (tin !== from.toLowerCase() && tin !== target.toLowerCase()) intermediates.add(h.tokenIn);
      if (tout !== from.toLowerCase() && tout !== target.toLowerCase()) intermediates.add(h.tokenOut);
    }

    // If findFailingStep identified a specific step, highlight its tokens
    if (failingStep) {
      const fHop = hops[failingStep.stepIndex];
      console.log(`  Failing step ${failingStep.stepIndex + 1}: ${tokenLabel(fHop.tokenIn)} → ${tokenLabel(fHop.tokenOut)}`);
      // The taxed token is usually the output of this step (buy tax) or
      // the input of the NEXT step (transfer tax between pools).
      // If step 1 fails and its input is the source token (BNB), the output token has buy tax.
      const suspectToken = fHop.tokenIn.toLowerCase() === from.toLowerCase()
        ? fHop.tokenOut : fHop.tokenIn;
      console.log(`  Most likely taxed token: ${tokenLabel(suspectToken)} (${suspectToken})\n`);
    }

    if (intermediates.size > 0) {
      console.log(`  All intermediate tokens:`);
      for (const addr of intermediates) {
        console.log(`    → ${tokenLabel(addr)} (${addr})`);
      }
      console.log(`\n  Confirm: npx peach-agg-tool tax-check ${[...intermediates].join(" ")}`);
    }
  } else if (poolDataOk && fullSimStatus === "SUCCESS") {
    const diffBps = quote.amountOut > 0n
      ? Number((fullSimOut - quote.amountOut) * 10000n / quote.amountOut)
      : 0;
    console.log("  ✓ All checks passed.");
    console.log(`    Quote:      ${ethers.formatUnits(quote.amountOut, dstDecimals)} ${tokenLabel(target)}`);
    console.log(`    Router sim: ${ethers.formatUnits(fullSimOut, dstDecimals)} ${tokenLabel(target)}`);
    console.log(`    Dev:        ${fmtDev(diffBps)}`);
  } else if (!poolDataOk && fullSimStatus === "FAILED") {
    console.log("  Both pool data and Router simulation have issues.");
    console.log("  Fix pool data staleness first, then re-check for transfer tax.");
  }

  console.log();
}
