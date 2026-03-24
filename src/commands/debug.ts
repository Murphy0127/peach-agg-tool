/**
 * Debug command: diagnose Peach simulation failures by inspecting pool state.
 *
 * Workflow:
 *   1. Run a Peach quote
 *   2. If simulation fails (or always if --force), fetch pool_debug for each pool in the route
 *   3. Read on-chain pool state via RPC and compare with Peach data
 *   4. Optionally compare with pool_redis to detect data sync issues
 *   5. Print diagnostic summary
 */

import { ethers } from "ethers";
import {
  printKV, printTable, pad, padL, fmtN, findSender,
  WBNB, type AggResult,
} from "../lib/common.js";
import { queryPeach } from "../lib/peach.js";
import { resolveToken, tokenLabel, tokenDecimals, fmtAmt } from "../lib/tokens.js";

// ── Interfaces ──────────────────────────────────────────────────────

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

interface OnchainV3State {
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
}

interface OnchainV2State {
  reserve0: bigint;
  reserve1: bigint;
}

interface OnchainDODOState {
  baseReserve: bigint;
  quoteReserve: bigint;
  baseTarget: bigint;
  quoteTarget: bigint;
}

interface OnchainDiff {
  field: string;
  peach: string;
  onchain: string;
  deviation: string;
  critical: boolean;
}

// ── ABI fragments ───────────────────────────────────────────────────

const V3_POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint32 feeProtocol, bool unlocked)",
  "function liquidity() view returns (uint128)",
];

const V2_PAIR_ABI = [
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
];

const DODO_POOL_ABI = [
  "function _BASE_RESERVE_() view returns (uint256)",
  "function _QUOTE_RESERVE_() view returns (uint256)",
  "function _BASE_TARGET_() view returns (uint256)",
  "function _QUOTE_TARGET_() view returns (uint256)",
];

// ── Peach debug API queries ──────────────────────────────────────────

function debugHeaders(debugToken?: string): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/json" };
  if (debugToken) h["Authorization"] = `Bearer ${debugToken}`;
  return h;
}

async function fetchPoolDebug(apiUrl: string, poolId: string, provider?: string, debugToken?: string): Promise<PoolDebugResponse[]> {
  const params = new URLSearchParams({ pool_id: poolId });
  if (provider) params.set("provider", provider);
  const url = `${apiUrl}/debug/pool?${params}`;
  try {
    const resp = await fetch(url, { headers: debugHeaders(debugToken), signal: AbortSignal.timeout(10000) });
    const json = await resp.json() as any;
    if (json?.code === 200 && json?.data) {
      return Array.isArray(json.data) ? json.data : [json.data];
    }
    return [];
  } catch {
    return [];
  }
}

async function fetchPoolRedis(apiUrl: string, poolId: string, provider: string, debugToken?: string): Promise<PoolRedisResponse | null> {
  const params = new URLSearchParams({ pool_id: poolId, provider });
  const url = `${apiUrl}/debug/pool/redis?${params}`;
  try {
    const resp = await fetch(url, { headers: debugHeaders(debugToken), signal: AbortSignal.timeout(10000) });
    const json = await resp.json() as any;
    if (json?.code === 200 && json?.data) return json.data;
    return null;
  } catch {
    return null;
  }
}

// ── On-chain reads ──────────────────────────────────────────────────

async function readV3Onchain(rpcProvider: ethers.JsonRpcProvider, poolAddr: string): Promise<OnchainV3State | null> {
  try {
    const pool = new ethers.Contract(poolAddr, V3_POOL_ABI, rpcProvider);
    const [slot0, liquidity] = await Promise.all([pool.slot0(), pool.liquidity()]);
    return {
      sqrtPriceX96: slot0.sqrtPriceX96,
      tick: Number(slot0.tick),
      liquidity: liquidity,
    };
  } catch {
    return null;
  }
}

async function readV2Onchain(rpcProvider: ethers.JsonRpcProvider, poolAddr: string): Promise<OnchainV2State | null> {
  try {
    const pair = new ethers.Contract(poolAddr, V2_PAIR_ABI, rpcProvider);
    const reserves = await pair.getReserves();
    return {
      reserve0: reserves.reserve0,
      reserve1: reserves.reserve1,
    };
  } catch {
    return null;
  }
}

async function readDODOOnchain(rpcProvider: ethers.JsonRpcProvider, poolAddr: string): Promise<OnchainDODOState | null> {
  try {
    const pool = new ethers.Contract(poolAddr, DODO_POOL_ABI, rpcProvider);
    const [baseReserve, quoteReserve, baseTarget, quoteTarget] = await Promise.all([
      pool._BASE_RESERVE_(),
      pool._QUOTE_RESERVE_(),
      pool._BASE_TARGET_(),
      pool._QUOTE_TARGET_(),
    ]);
    return { baseReserve, quoteReserve, baseTarget, quoteTarget };
  } catch {
    return null;
  }
}

// ── Comparison logic ────────────────────────────────────────────────

function pctDeviation(peach: bigint, onchain: bigint): string {
  if (onchain === 0n) return peach === 0n ? "0%" : "∞";
  const diff = peach > onchain ? peach - onchain : onchain - peach;
  const pct = Number(diff * 10000n / onchain) / 100;
  const sign = peach >= onchain ? "+" : "-";
  return `${sign}${pct.toFixed(4)}%`;
}

function isCriticalDeviation(peach: bigint, onchain: bigint, thresholdBps: number = 10): boolean {
  if (onchain === 0n) return peach !== 0n;
  const diff = peach > onchain ? peach - onchain : onchain - peach;
  return Number(diff * 10000n / onchain) > thresholdBps;
}

function compareV3WithOnchain(debug: PoolDebugResponse, onchain: OnchainV3State): OnchainDiff[] {
  const diffs: OnchainDiff[] = [];
  const d = debug.detail;

  if (d?.sqrt_price_x96 !== undefined) {
    const peachVal = BigInt(d.sqrt_price_x96);
    diffs.push({
      field: "sqrtPriceX96",
      peach: peachVal.toString(),
      onchain: onchain.sqrtPriceX96.toString(),
      deviation: pctDeviation(peachVal, onchain.sqrtPriceX96),
      critical: isCriticalDeviation(peachVal, onchain.sqrtPriceX96),
    });
  }

  if (d?.tick !== undefined) {
    const peachTick = Number(d.tick);
    const diff = Math.abs(peachTick - onchain.tick);
    diffs.push({
      field: "tick",
      peach: peachTick.toString(),
      onchain: onchain.tick.toString(),
      deviation: diff === 0 ? "0" : `${peachTick > onchain.tick ? "+" : "-"}${diff}`,
      critical: diff > 10,
    });
  }

  if (d?.liquidity !== undefined) {
    const peachVal = BigInt(d.liquidity);
    diffs.push({
      field: "liquidity",
      peach: peachVal.toString(),
      onchain: onchain.liquidity.toString(),
      deviation: pctDeviation(peachVal, onchain.liquidity),
      critical: isCriticalDeviation(peachVal, onchain.liquidity, 100), // 1% threshold
    });
  }

  return diffs;
}

function compareV2WithOnchain(debug: PoolDebugResponse, onchain: OnchainV2State): OnchainDiff[] {
  const diffs: OnchainDiff[] = [];
  const d = debug.detail;

  if (d?.reserve0 !== undefined) {
    const peachVal = BigInt(d.reserve0);
    diffs.push({
      field: "reserve0",
      peach: peachVal.toString(),
      onchain: onchain.reserve0.toString(),
      deviation: pctDeviation(peachVal, onchain.reserve0),
      critical: isCriticalDeviation(peachVal, onchain.reserve0, 50), // 0.5%
    });
  }

  if (d?.reserve1 !== undefined) {
    const peachVal = BigInt(d.reserve1);
    diffs.push({
      field: "reserve1",
      peach: peachVal.toString(),
      onchain: onchain.reserve1.toString(),
      deviation: pctDeviation(peachVal, onchain.reserve1),
      critical: isCriticalDeviation(peachVal, onchain.reserve1, 50),
    });
  }

  return diffs;
}

function compareDODOWithOnchain(debug: PoolDebugResponse, onchain: OnchainDODOState): OnchainDiff[] {
  const diffs: OnchainDiff[] = [];
  const d = debug.detail;

  const fields: [string, string, bigint][] = [
    ["baseReserve", "base_reserve", onchain.baseReserve],
    ["quoteReserve", "quote_reserve", onchain.quoteReserve],
    ["baseTarget", "base_target", onchain.baseTarget],
    ["quoteTarget", "quote_target", onchain.quoteTarget],
  ];

  for (const [label, key, onchainVal] of fields) {
    if (d?.[key] !== undefined) {
      const peachVal = BigInt(d[key]);
      diffs.push({
        field: label,
        peach: peachVal.toString(),
        onchain: onchainVal.toString(),
        deviation: pctDeviation(peachVal, onchainVal),
        critical: isCriticalDeviation(peachVal, onchainVal, 50),
      });
    }
  }

  return diffs;
}

// ── Pool diagnosis ──────────────────────────────────────────────────

function diagnosePool(debug: PoolDebugResponse): string[] {
  const issues: string[] = [];
  const d = debug.detail;

  if (d?.token0_is_honeypot) issues.push(`token0 (${tokenLabel(debug.token0)}) flagged as HONEYPOT`);
  if (d?.token1_is_honeypot) issues.push(`token1 (${tokenLabel(debug.token1)}) flagged as HONEYPOT`);

  if (d?.liquidity !== undefined && (d.liquidity === "0" || d.liquidity === 0)) {
    issues.push("liquidity is ZERO");
  }

  if (d?.reserve0 !== undefined && d?.reserve1 !== undefined) {
    if (d.reserve0 === "0" || d.reserve1 === "0") issues.push("one or both reserves are ZERO");
  }
  if (d?.base_reserve !== undefined && d?.quote_reserve !== undefined) {
    if (d.base_reserve === "0" || d.quote_reserve === "0") issues.push("base or quote reserve is ZERO");
  }

  if (d?.unlocked === false || d?.unlocked === 0) issues.push("pool is LOCKED (unlocked=false)");
  if (d?.tick_count !== undefined && d.tick_count === 0) issues.push("tick_count is ZERO (no ticks loaded)");

  // Per-token tax (bps) — V2 / DODO pools
  for (const [label, key] of [
    ["token0 buy tax", "token0_buy_tax_bps"],
    ["token0 sell tax", "token0_sell_tax_bps"],
    ["token1 buy tax", "token1_buy_tax_bps"],
    ["token1 sell tax", "token1_sell_tax_bps"],
  ] as const) {
    if (d?.[key] !== undefined && d[key] > 1000) {
      issues.push(`high ${label}: ${(d[key] / 100).toFixed(1)}%`);
    }
  }

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

  if (["PANCAKEV3", "UNISWAPV3", "THENA"].includes(debug.provider.toUpperCase())) {
    if (!redis.ticks_exists) {
      issues.push("ticks NOT FOUND in Redis (V3 pool needs tick data)");
    } else if (redis.tick_count === 0) {
      issues.push("Redis tick_count is ZERO");
    }

    const memoryTickCount = debug.detail?.tick_count;
    if (memoryTickCount !== undefined && redis.tick_count !== undefined && memoryTickCount !== redis.tick_count) {
      issues.push(`tick count mismatch: memory=${memoryTickCount} vs redis=${redis.tick_count}`);
    }
  }

  return issues;
}

// ── Formatting helpers ──────────────────────────────────────────────

function truncNum(s: string, maxLen: number = 20): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 3) + "...";
}

function printDiffTable(diffs: OnchainDiff[]) {
  if (diffs.length === 0) return;
  const rows = diffs.map(d => [
    d.field,
    truncNum(d.peach),
    truncNum(d.onchain),
    d.deviation,
    d.critical ? "⚠ STALE" : "OK",
  ]);
  const headers = ["Field", "Peach", "On-chain", "Deviation", "Status"];
  // Simple table output
  const cw = headers.map((h, i) => Math.max(h.length, ...rows.map(r => r[i].length)));
  const sep = "  │  +" + cw.map(w => "-".repeat(w + 2)).join("+") + "+";
  const fr = (row: string[]) => "  │  | " + row.map((c, i) => pad(c, cw[i])).join(" | ") + " |";
  console.log(sep);
  console.log(fr(headers));
  console.log(sep);
  for (const row of rows) console.log(fr(row));
  console.log(sep);
}

// ── Main command ────────────────────────────────────────────────────

export async function cmdDebug(args: string[]) {
  if (args.length < 3) {
    console.error(`Usage: peach-agg-tool debug <from> <target> <amount> [options]

Diagnose Peach simulation failures by inspecting pool state and comparing with on-chain data.

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
  --no-onchain         Skip on-chain comparison
  --force              Show pool debug even if simulation succeeds

Environment:
  PEACH_DEBUG_TOKEN    Bearer token for Peach debug API (required)`);
    process.exit(1);
  }

  const from = resolveToken(args[0]);
  const target = resolveToken(args[1]);
  const amountStr = args[2];

  let slippage = 50, sender = "", rpcUrl = "https://bsc-dataseed.bnbchain.org";
  let apiUrl = "https://api.cipheron.org";
  let depth = 3, splitCount = 5, providers = "PANCAKEV2,PANCAKEV3,UNISWAPV3,DODO,THENA";
  let version = "v5", checkRedis = false, force = false, noOnchain = false;
  const debugToken = process.env.PEACH_DEBUG_TOKEN || "";

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
      case "--no-onchain": noOnchain = true; break;
      case "--force":     force = true; break;
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

  const totalSteps = noOnchain ? 3 : 4;

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
    ["RPC", rpcUrl],
  ]);
  console.log();

  console.log(`[1/${totalSteps}] Running Peach quote + simulation...`);
  const result = await queryPeach(from, target, amountIn.toString(), 0, {
    apiUrl, rpcUrl, sender, slippageBps: slippage, provider: rpcProvider, doSim: true,
    depth, splitCount, providers, version,
  });

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
  console.log(`\n[2/${totalSteps}] Fetching pool debug for ${routePoolIds.length} pool(s)...\n`);

  const allIssues: { poolId: string; provider: string; path: string; issues: string[] }[] = [];
  const allDiffs: { poolId: string; provider: string; diffs: OnchainDiff[] }[] = [];

  for (const rp of routePoolIds) {
    if (!rp.poolId) {
      console.log(`  ${pad(rp.provider, 12)} ${rp.path} — no pool_id available`);
      continue;
    }

    const debugInfos = await fetchPoolDebug(apiUrl, rp.poolId, rp.provider, debugToken);

    if (debugInfos.length === 0) {
      console.log(`  ${pad(rp.provider, 12)} ${rp.poolId.slice(0, 16)}... — pool_debug returned empty`);
      allIssues.push({ ...rp, issues: ["pool_debug returned empty (pool may not exist in memory)"] });
      continue;
    }

    for (const dbg of debugInfos) {
      const issues = diagnosePool(dbg);

      // Redis check
      let redisIssues: string[] = [];
      if (checkRedis) {
        const redis = await fetchPoolRedis(apiUrl, rp.poolId, dbg.provider, debugToken);
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

      const d = dbg.detail;
      if (d) {
        if (d.liquidity !== undefined) console.log(`  │  liquidity=${d.liquidity} tick=${d.tick} sqrtPrice=${d.sqrt_price_x96}`);
        if (d.reserve0 !== undefined) console.log(`  │  reserve0=${d.reserve0} reserve1=${d.reserve1}`);
        if (d.base_reserve !== undefined) console.log(`  │  baseReserve=${d.base_reserve} quoteReserve=${d.quote_reserve} k=${d.k}`);
        if (d.tick_count !== undefined) console.log(`  │  tick_count=${d.tick_count}`);
        if (d.token0_is_honeypot || d.token1_is_honeypot) console.log(`  │  HONEYPOT: t0=${d.token0_is_honeypot} t1=${d.token1_is_honeypot}`);
        if (d.token0_buy_tax_bps !== undefined || d.token1_buy_tax_bps !== undefined) {
          const taxes = [
            d.token0_buy_tax_bps ? `t0_buy=${d.token0_buy_tax_bps}bps` : null,
            d.token0_sell_tax_bps ? `t0_sell=${d.token0_sell_tax_bps}bps` : null,
            d.token1_buy_tax_bps ? `t1_buy=${d.token1_buy_tax_bps}bps` : null,
            d.token1_sell_tax_bps ? `t1_sell=${d.token1_sell_tax_bps}bps` : null,
          ].filter(Boolean);
          if (taxes.length > 0) console.log(`  │  tax: ${taxes.join(" ")}`);
        }
        if (d.unlocked !== undefined) console.log(`  │  unlocked=${d.unlocked}`);
      }

      for (const edge of dbg.edges) {
        console.log(`  │  edge: ${tokenLabel(edge.from)}→${tokenLabel(edge.target)} price=${edge.price} maxOut=${edge.max_amount_out}`);
      }

      if (combined.length > 0) {
        console.log(`  │`);
        for (const issue of combined) {
          console.log(`  │  ⚠ ${issue}`);
        }
      } else {
        console.log(`  │  ✓ No obvious issues in Peach data`);
      }
      console.log(`  └──────────────────────────────────────────`);
      console.log();
    }
  }

  // Step 3: On-chain comparison
  if (!noOnchain) {
    console.log(`[3/${totalSteps}] Comparing Peach data with on-chain state...\n`);

    for (const rp of routePoolIds) {
      if (!rp.poolId) continue;

      const debugInfos = await fetchPoolDebug(apiUrl, rp.poolId, rp.provider, debugToken);
      for (const dbg of debugInfos) {
        const providerUpper = dbg.provider.toUpperCase();
        let diffs: OnchainDiff[] = [];

        if (["PANCAKEV3", "UNISWAPV3", "THENA"].includes(providerUpper)) {
          const onchain = await readV3Onchain(rpcProvider, rp.poolId);
          if (onchain) {
            diffs = compareV3WithOnchain(dbg, onchain);
          } else {
            console.log(`  ${dbg.provider} ${rp.poolId.slice(0, 16)}... — failed to read V3 on-chain state`);
          }
        } else if (providerUpper === "PANCAKEV2") {
          const onchain = await readV2Onchain(rpcProvider, rp.poolId);
          if (onchain) {
            diffs = compareV2WithOnchain(dbg, onchain);
          } else {
            console.log(`  ${dbg.provider} ${rp.poolId.slice(0, 16)}... — failed to read V2 on-chain state`);
          }
        } else if (providerUpper === "DODO") {
          const onchain = await readDODOOnchain(rpcProvider, rp.poolId);
          if (onchain) {
            diffs = compareDODOWithOnchain(dbg, onchain);
          } else {
            console.log(`  ${dbg.provider} ${rp.poolId.slice(0, 16)}... — failed to read DODO on-chain state`);
          }
        }

        if (diffs.length > 0) {
          allDiffs.push({ poolId: rp.poolId, provider: dbg.provider, diffs });

          const hasCritical = diffs.some(d => d.critical);
          console.log(`  ┌─ ${dbg.provider} | ${rp.poolId} ${hasCritical ? "⚠ DATA STALE" : "✓"}`);
          printDiffTable(diffs);

          // Add on-chain issues to allIssues
          const staleFields = diffs.filter(d => d.critical);
          if (staleFields.length > 0) {
            const existing = allIssues.find(x => x.poolId === rp.poolId && x.provider === dbg.provider);
            for (const sf of staleFields) {
              const msg = `on-chain drift: ${sf.field} peach=${truncNum(sf.peach, 16)} vs chain=${truncNum(sf.onchain, 16)} (${sf.deviation})`;
              if (existing) existing.issues.push(msg);
            }
          }
          console.log(`  └──────────────────────────────────────────`);
          console.log();
        }
      }
    }

    const totalStaleFields = allDiffs.reduce((sum, d) => sum + d.diffs.filter(x => x.critical).length, 0);
    if (totalStaleFields === 0 && allDiffs.length > 0) {
      console.log("  ✓ All pool data matches on-chain state.\n");
    }
  }

  // Final summary
  const summaryStep = noOnchain ? 3 : 4;
  console.log(`[${summaryStep}/${totalSteps}] Diagnosis Summary`);
  console.log("───────────────────────────────────────────────────────");

  const poolsWithIssues = allIssues.filter(p => p.issues.length > 0);
  if (poolsWithIssues.length === 0) {
    console.log("  No pool-level issues detected.");
    if (result.simStatus === "FAILED") {
      console.log("  Simulation failure may be caused by:");
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

  // On-chain summary
  if (!noOnchain && allDiffs.length > 0) {
    const stalePoolCount = allDiffs.filter(d => d.diffs.some(x => x.critical)).length;
    if (stalePoolCount > 0) {
      console.log(`  ⚠ ${stalePoolCount} pool(s) have stale data vs on-chain.`);
      console.log("    This is likely the root cause of simulation failure.");
      console.log("    The aggregator's cached pool state is out of date.\n");
    }
  }

  if (result.simError) {
    console.log(`  Simulation error: ${result.simError}`);
  }
  console.log();
}
