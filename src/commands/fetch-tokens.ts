/**
 * Fetch BSC top traded tokens and save to data/tokens.json.
 * Data source: GeckoTerminal API (free, no auth required).
 */

import * as fs from "fs";
import * as path from "path";
import { proxyFetch } from "../lib/common.js";
import type { TokenEntry } from "../lib/tokens.js";

const NATIVE_TOKEN = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const WBNB = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

interface PoolData {
  id: string;
  attributes: {
    name: string;
    address: string;
    base_token_price_usd: string | null;
    quote_token_price_usd: string | null;
    fdv_usd: string | null;
    market_cap_usd: string | null;
    volume_usd: { h24: string | null };
    reserve_in_usd: string | null;
  };
  relationships: {
    base_token: { data: { id: string } };
    quote_token: { data: { id: string } };
  };
}

interface IncludedToken {
  id: string;
  attributes: {
    address: string;
    name: string;
    symbol: string;
    decimals: number;
    image_url?: string;
  };
}

async function fetchGeckoTerminalPools(pages: number): Promise<{ pools: PoolData[]; tokenMap: Map<string, IncludedToken> }> {
  const allPools: PoolData[] = [];
  const tokenMap = new Map<string, IncludedToken>();

  for (let page = 1; page <= pages; page++) {
    const url = `https://api.geckoterminal.com/api/v2/networks/bsc/pools?page=${page}&sort=h24_volume_usd_desc&include=base_token,quote_token`;
    process.stdout.write(`  Fetching page ${page}/${pages}...`);

    let resp: Awaited<ReturnType<typeof proxyFetch>> | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      resp = await proxyFetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(15000),
      });
      if (resp.status === 429) {
        const wait = 10 * (attempt + 1);
        process.stdout.write(` 429, retry in ${wait}s...`);
        await sleep(wait * 1000);
        resp = null;
        continue;
      }
      break;
    }

    if (!resp || !resp.ok) {
      console.log(` FAILED (${resp?.status ?? "timeout"})`);
      break;
    }

    const json = await resp.json() as any;
    const pools: PoolData[] = json.data ?? [];
    const included: IncludedToken[] = json.included ?? [];

    allPools.push(...pools);
    for (const t of included) {
      if (!tokenMap.has(t.id)) tokenMap.set(t.id, t);
    }

    console.log(` ${pools.length} pools, ${included.length} tokens`);

    if (page < pages) await sleep(3000);
  }

  return { pools: allPools, tokenMap };
}

function aggregateTokens(pools: PoolData[], tokenMap: Map<string, IncludedToken>, top: number): TokenEntry[] {
  const tokenVolume = new Map<string, number>();
  const tokenPrice = new Map<string, number>();
  const tokenMcap = new Map<string, number>();

  for (const pool of pools) {
    const vol = parseFloat(pool.attributes.volume_usd?.h24 ?? "0");
    if (vol <= 0) continue;

    const baseId = pool.relationships.base_token.data.id;
    const quoteId = pool.relationships.quote_token.data.id;
    const baseAddr = baseId.replace("bsc_", "").toLowerCase();
    const quoteAddr = quoteId.replace("bsc_", "").toLowerCase();

    const basePrice = parseFloat(pool.attributes.base_token_price_usd ?? "0");
    const quotePrice = parseFloat(pool.attributes.quote_token_price_usd ?? "0");

    for (const [addr, price] of [
      [baseAddr, basePrice],
      [quoteAddr, quotePrice],
    ] as [string, number][]) {
      tokenVolume.set(addr, (tokenVolume.get(addr) ?? 0) + vol);
      if (price > 0) {
        tokenPrice.set(addr, price);
      }
    }

    const mcap = parseFloat(pool.attributes.market_cap_usd ?? pool.attributes.fdv_usd ?? "0");
    if (mcap > 0) {
      const addr = baseAddr;
      if (!tokenMcap.has(addr) || mcap > tokenMcap.get(addr)!) {
        tokenMcap.set(addr, mcap);
      }
    }
  }

  const tokens: TokenEntry[] = [];
  const seen = new Set<string>();

  for (const [addr, vol] of tokenVolume.entries()) {
    if (seen.has(addr)) continue;
    seen.add(addr);

    const price = tokenPrice.get(addr) ?? 0;
    if (price <= 0) continue;

    const geckoId = `bsc_${addr}`;
    const meta = tokenMap.get(geckoId);

    tokens.push({
      address: addr,
      symbol: meta?.attributes.symbol ?? "???",
      name: meta?.attributes.name ?? meta?.attributes.symbol ?? "???",
      decimals: meta?.attributes.decimals ?? 18,
      priceUsd: price,
      marketCap: tokenMcap.get(addr) ?? 0,
      volume24h: vol,
      isNative: false,
    });
  }

  tokens.sort((a, b) => b.volume24h - a.volume24h);

  const wbnbEntry = tokens.find(t => t.address === WBNB);
  const hasNative = tokens.some(t => t.address === NATIVE_TOKEN);
  if (wbnbEntry && !hasNative) {
    tokens.unshift({
      ...wbnbEntry,
      address: NATIVE_TOKEN,
      symbol: "BNB",
      name: "BNB",
      isNative: true,
    });
  }

  return tokens.slice(0, top);
}

export async function cmdFetchTokens(args: string[]) {
  let top = 100;
  let pages = 8;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--top") top = parseInt(args[++i]);
    if (args[i] === "--pages") pages = parseInt(args[++i]);
    if (args[i] === "-h" || args[i] === "--help") {
      console.log(`
Fetch BSC top traded tokens by 24h DEX volume (via GeckoTerminal).

Usage:
  npx @pagg/agg-tool fetch-tokens [--top <n>] [--pages <n>]

Options:
  --top <n>      Number of tokens to keep (default: 100)
  --pages <n>    Number of pool pages to fetch, 25 pools/page (default: 8)
`);
      process.exit(0);
    }
  }

  console.log(`Fetching BSC top pools (${pages} pages x 25 pools) from GeckoTerminal...\n`);
  const { pools, tokenMap } = await fetchGeckoTerminalPools(pages);
  console.log(`\nTotal: ${pools.length} pools, ${tokenMap.size} unique tokens in metadata\n`);

  const tokens = aggregateTokens(pools, tokenMap, top);

  if (tokens.length === 0) {
    console.error("No tokens fetched. Keeping existing tokens.json unchanged.");
    process.exit(1);
  }

  // Write to package's data/ directory
  const currentDir = path.dirname(new URL(import.meta.url).pathname);
  let outPath = path.join(currentDir, "..", "data", "tokens.json");
  // Walk up to find existing data dir
  let dir = currentDir;
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, "data");
    if (fs.existsSync(candidate)) { outPath = path.join(candidate, "tokens.json"); break; }
    dir = path.dirname(dir);
  }
  const output = {
    updatedAt: new Date().toISOString(),
    chain: "BSC",
    chainId: 56,
    source: "GeckoTerminal (24h DEX volume)",
    count: tokens.length,
    tokens,
  };
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2), "utf-8");

  console.log(`Saved ${tokens.length} tokens to ${outPath}\n`);

  const pad = (s: string, n: number) => s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
  const padL = (s: string, n: number) => s.length >= n ? s : " ".repeat(n - s.length) + s;
  const fmtN = (n: number) => n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(0)}`;

  console.log(`${padL("#", 3)}  ${pad("Symbol", 10)} ${padL("Price", 14)} ${padL("24h Volume", 14)} ${padL("Market Cap", 14)} ${pad("Address", 44)}`);
  console.log("-".repeat(104));
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    console.log(
      `${padL((i + 1).toString(), 3)}  ${pad(t.symbol, 10)} ${padL("$" + t.priceUsd.toPrecision(6), 14)} ${padL(fmtN(t.volume24h), 14)} ${padL(fmtN(t.marketCap), 14)} ${t.address}`,
    );
  }
}
