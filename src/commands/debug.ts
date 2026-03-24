/**
 * Debug command: diagnose Peach simulation failures by inspecting pool state.
 *
 * Workflow:
 *   1. Run a Peach quote
 *   2. If simulation fails (or always if --force), fetch pool_debug for each pool in the route
 *   3. Optionally compare with pool_redis to detect data sync issues
 *   4. Print diagnostic summary
 */

import { ethers } from "ethers";
import {
  printKV, printTable, pad, padL, fmtN, findSender,
  WBNB, type AggResult,
} from "../lib/common.js";
import { queryPeach } from "../lib/peach.js";
import { resolveToken, tokenLabel, tokenDecimals, fmtAmt } from "../lib/tokens.js";

interface PoolDebugResponse {
  pool_id: string;
  provider: string;
  token0: string;
  token1: string;
  token0_decimals: number;
  token1_decimals: number;
  fee: number;
  price_a2b: string;
  price_b2a: string;
  detail: any;
  edges: {
    edge_id: string;
    from: string;
    target: string;
    price: string;
    max_amount_out: string;
    max_depth: number;
  }[];
}

interface PoolRedisResponse {
  pool_id: string;
  provider: string;
  pool_data: any;
  tick_count: number;
  ticks: any;
  pool_exists: boolean;
  ticks_exists: boolean;
}

async function fetchPoolDebug(apiUrl: string, poolId: string, provider?: string): Promise<PoolDebugResponse[]> {
  const params = new URLSearchParams({ pool_id: poolId });
  if (provider) params.set("provider", provider);
  const url = `${apiUrl}/router/pool_debug?${params}`;
  try {
    const resp = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10000) });
    const json = await resp.json() as any;
    if (json?.code === 200 && json?.data) {
      return Array.isArray(json.data) ? json.data : [json.data];
    }
    return [];
  } catch {
    return [];
  }
}

async function fetchPoolRedis(apiUrl: string, poolId: string, provider: string): Promise<PoolRedisResponse | null> {
  const params = new URLSearchParams({ pool_id: poolId, provider });
  const url = `${apiUrl}/router/pool_redis?${params}`;
  try {
    const resp = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10000) });
    const json = await resp.json() as any;
    if (json?.code === 200 && json?.data) return json.data;
    return null;
  } catch {
    return null;
  }
}

function diagnosePool(debug: PoolDebugResponse): string[] {
  const issues: string[] = [];
  const d = debug.detail;

  // Check honeypot
  if (d?.token0_is_honeypot) issues.push(`token0 (${tokenLabel(debug.token0)}) flagged as HONEYPOT`);
  if (d?.token1_is_honeypot) issues.push(`token1 (${tokenLabel(debug.token1)}) flagged as HONEYPOT`);

  // Check liquidity
  if (d?.liquidity !== undefined && (d.liquidity === "0" || d.liquidity === 0)) {
    issues.push("liquidity is ZERO");
  }

  // Check reserves (V2/DODO)
  if (d?.reserve0 !== undefined && d?.reserve1 !== undefined) {
    if (d.reserve0 === "0" || d.reserve1 === "0") issues.push("one or both reserves are ZERO");
  }
  if (d?.base_reserve !== undefined && d?.quote_reserve !== undefined) {
    if (d.base_reserve === "0" || d.quote_reserve === "0") issues.push("base or quote reserve is ZERO");
  }

  // Check if pool is locked/paused
  if (d?.unlocked === false || d?.unlocked === 0) issues.push("pool is LOCKED (unlocked=false)");

  // Check tick count for V3 pools
  if (d?.tick_count !== undefined && d.tick_count === 0) issues.push("tick_count is ZERO (no ticks loaded)");

  // Check buy/sell taxes (DODO/V2)
  if (d?.buy_tax !== undefined && parseFloat(d.buy_tax) > 0.1) issues.push(`high buy tax: ${(parseFloat(d.buy_tax) * 100).toFixed(1)}%`);
  if (d?.sell_tax !== undefined && parseFloat(d.sell_tax) > 0.1) issues.push(`high sell tax: ${(parseFloat(d.sell_tax) * 100).toFixed(1)}%`);

  // Check edge max_amount_out
  for (const edge of debug.edges) {
    if (edge.max_amount_out === "0") {
      issues.push(`edge ${edge.from.slice(0, 8)}→${edge.target.slice(0, 8)}: max_amount_out is ZERO`);
    }
  }

  return issues;
}

function compareWithRedis(debug: PoolDebugResponse, redis: PoolRedisResponse): string[] {
  const issues: string[] = [];

  if (!redis.pool_exists) {
    issues.push("pool NOT FOUND in Redis");
    return issues;
  }

  // For V3-type pools, check ticks
  if (["PANCAKEV3", "UNISWAPV3", "THENA"].includes(debug.provider.toUpperCase())) {
    if (!redis.ticks_exists) {
      issues.push("ticks NOT FOUND in Redis (V3 pool needs tick data)");
    } else if (redis.tick_count === 0) {
      issues.push("Redis tick_count is ZERO");
    }

    // Compare tick counts
    const memoryTickCount = debug.detail?.tick_count;
    if (memoryTickCount !== undefined && redis.tick_count !== undefined && memoryTickCount !== redis.tick_count) {
      issues.push(`tick count mismatch: memory=${memoryTickCount} vs redis=${redis.tick_count}`);
    }
  }

  return issues;
}

export async function cmdDebug(args: string[]) {
  if (args.length < 3) {
    console.error(`Usage: peach-agg-tool debug <from> <target> <amount> [options]

Diagnose Peach simulation failures by inspecting pool state.

Options:
  --rpc <url>          BSC RPC URL
  --api <url>          Peach API URL
  --sender <address>   Sender address (auto-detect)
  --slippage <bps>     Slippage (default: 50)
  --depth <n>          Search depth (default: 3)
  --split <n>          Split count (default: 5)
  --providers <list>   DEX providers
  --version <v>        API version (default: v5)
  --check-redis        Also check Redis pool data for sync issues
  --force              Show pool debug even if simulation succeeds`);
    process.exit(1);
  }

  const from = resolveToken(args[0]);
  const target = resolveToken(args[1]);
  const amountStr = args[2];

  let slippage = 50, sender = "", rpcUrl = "https://bsc-dataseed.bnbchain.org";
  let apiUrl = "https://api.cipheron.org";
  let depth = 3, splitCount = 5, providers = "PANCAKEV2,PANCAKEV3,UNISWAPV3,DODO,THENA";
  let version = "v5", checkRedis = false, force = false;

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
      case "--check-redis": checkRedis = true; break;
      case "--force":     force = true; break;
    }
  }

  const srcDecimals = tokenDecimals(from);
  const isRawWei = !amountStr.includes(".") && amountStr.length >= 15 && /^\d+$/.test(amountStr);
  const amountIn = isRawWei ? BigInt(amountStr) : ethers.parseUnits(amountStr, srcDecimals);
  const isNative = from.toLowerCase() === WBNB;

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  if (!sender) {
    sender = await findSender(provider, from, amountIn, isNative);
  }

  // Step 1: Run Peach quote
  console.log();
  console.log("═══════════════════════════════════════════════════════");
  console.log("  Peach Simulation Debug");
  console.log("═══════════════════════════════════════════════════════");
  console.log();
  printKV([
    ["From", `${tokenLabel(from)} (${from})`],
    ["To", `${tokenLabel(target)} (${target})`],
    ["Amount", `${fmtAmt(amountIn, from)} ${tokenLabel(from)}`],
    ["Sender", sender],
    ["API", apiUrl],
  ]);
  console.log();

  console.log("[1/3] Running Peach quote + simulation...");
  const result = await queryPeach(from, target, amountIn.toString(), 0, {
    apiUrl, rpcUrl, sender, slippageBps: slippage, provider: provider, doSim: true,
    depth, splitCount, providers, version,
  });

  // Print quote result
  if (result.ok) {
    printKV([
      ["Quote", `${fmtAmt(result.amountOut, target)} ${tokenLabel(target)}`],
      ["Simulation", result.simStatus],
      ...(result.simStatus === "SUCCESS" ? [["Sim Out", `${fmtAmt(result.simAmountOut, target)} ${tokenLabel(target)}`] as [string, string]] : []),
      ...(result.simStatus === "FAILED" ? [["Sim Error", result.simError ?? "unknown"] as [string, string]] : []),
      ["Latency", `${result.latencyMs}ms`],
    ]);
  } else {
    printKV([
      ["Quote", "FAILED"],
      ["Error", result.error ?? "unknown"],
    ]);
  }

  // Extract pool IDs from routes
  const routePoolIds: { poolId: string; provider: string; path: string }[] = [];
  const rawData = result.rawApiResponse?.data;
  if (rawData?.paths) {
    for (const p of rawData.paths) {
      routePoolIds.push({
        poolId: p.pool ?? p.pool_id ?? p.id,
        provider: p.provider,
        path: `${tokenLabel(p.token_in ?? p.from)} → ${tokenLabel(p.token_out ?? p.target)}`,
      });
    }
  } else if (result.routes.length > 0) {
    // Fallback: use route info (less detailed)
    for (const r of result.routes) {
      routePoolIds.push({
        poolId: "",
        provider: r.dexName,
        path: r.path ?? `${r.fromToken} → ${r.toToken}`,
      });
    }
  }

  if (routePoolIds.length === 0) {
    console.log("\n  No routes found — cannot inspect pools.\n");
    return;
  }

  const needDebug = force || result.simStatus === "FAILED" || !result.ok;
  if (!needDebug) {
    console.log("\n  Simulation succeeded. Use --force to inspect pools anyway.\n");
    return;
  }

  // Step 2: Fetch pool debug info
  console.log(`\n[2/3] Fetching pool debug for ${routePoolIds.length} pool(s)...\n`);

  const allIssues: { poolId: string; provider: string; path: string; issues: string[] }[] = [];

  for (const rp of routePoolIds) {
    if (!rp.poolId) {
      console.log(`  ${pad(rp.provider, 12)} ${rp.path} — no pool_id available`);
      continue;
    }

    const debugInfos = await fetchPoolDebug(apiUrl, rp.poolId, rp.provider);

    if (debugInfos.length === 0) {
      console.log(`  ${pad(rp.provider, 12)} ${rp.poolId.slice(0, 16)}... — pool_debug returned empty`);
      allIssues.push({ ...rp, issues: ["pool_debug returned empty (pool may not exist in memory)"] });
      continue;
    }

    for (const dbg of debugInfos) {
      const issues = diagnosePool(dbg);

      // Step 3: Optionally check Redis
      let redisIssues: string[] = [];
      if (checkRedis) {
        const redis = await fetchPoolRedis(apiUrl, rp.poolId, dbg.provider);
        if (redis) {
          redisIssues = compareWithRedis(dbg, redis);
        } else {
          redisIssues = ["pool_redis query failed"];
        }
      }

      const combined = [...issues, ...redisIssues];
      allIssues.push({ poolId: rp.poolId, provider: dbg.provider, path: rp.path, issues: combined });

      // Print pool detail
      console.log(`  ┌─ ${dbg.provider} | ${rp.poolId}`);
      console.log(`  │  ${tokenLabel(dbg.token0)}(${dbg.token0_decimals}) / ${tokenLabel(dbg.token1)}(${dbg.token1_decimals}) | fee=${dbg.fee}`);
      console.log(`  │  price: a→b=${dbg.price_a2b}  b→a=${dbg.price_b2a}`);

      // Print provider-specific details
      const d = dbg.detail;
      if (d) {
        if (d.liquidity !== undefined) console.log(`  │  liquidity=${d.liquidity} tick=${d.tick} sqrtPrice=${d.sqrt_price_x96}`);
        if (d.reserve0 !== undefined) console.log(`  │  reserve0=${d.reserve0} reserve1=${d.reserve1}`);
        if (d.base_reserve !== undefined) console.log(`  │  baseReserve=${d.base_reserve} quoteReserve=${d.quote_reserve} k=${d.k}`);
        if (d.tick_count !== undefined) console.log(`  │  tick_count=${d.tick_count}`);
        if (d.token0_is_honeypot || d.token1_is_honeypot) console.log(`  │  ⚠ HONEYPOT: t0=${d.token0_is_honeypot} t1=${d.token1_is_honeypot}`);
        if (d.buy_tax !== undefined) console.log(`  │  buy_tax=${d.buy_tax} sell_tax=${d.sell_tax}`);
        if (d.unlocked !== undefined) console.log(`  │  unlocked=${d.unlocked}`);
      }

      // Print edges
      for (const edge of dbg.edges) {
        console.log(`  │  edge: ${tokenLabel(edge.from)}→${tokenLabel(edge.target)} price=${edge.price} maxOut=${edge.max_amount_out}`);
      }

      if (combined.length > 0) {
        console.log(`  │`);
        for (const issue of combined) {
          console.log(`  │  ⚠ ${issue}`);
        }
      } else {
        console.log(`  │  ✓ No obvious issues`);
      }
      console.log(`  └──────────────────────────────────────────`);
      console.log();
    }
  }

  // Summary
  console.log("[3/3] Diagnosis Summary");
  console.log("───────────────────────────────────────────────────────");

  const poolsWithIssues = allIssues.filter(p => p.issues.length > 0);
  if (poolsWithIssues.length === 0) {
    console.log("  No pool-level issues detected.");
    if (result.simStatus === "FAILED") {
      console.log("  Simulation failure may be caused by:");
      console.log("    - On-chain state changed between quote and simulation");
      console.log("    - Slippage tolerance too tight");
      console.log("    - Router contract interaction issue");
      console.log("    - Token transfer restrictions not captured in pool data");
    }
  } else {
    console.log(`  Found issues in ${poolsWithIssues.length}/${allIssues.length} pool(s):\n`);
    for (const p of poolsWithIssues) {
      console.log(`  ${p.provider} ${p.poolId.slice(0, 20)}... (${p.path})`);
      for (const issue of p.issues) {
        console.log(`    ⚠ ${issue}`);
      }
      console.log();
    }
  }

  if (result.simError) {
    console.log(`\n  Simulation error: ${result.simError}`);
  }
  console.log();
}
