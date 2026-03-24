/**
 * Shared token data loader.
 * Reads tokens from data/tokens.json (bundled with the package).
 */

import * as fs from "fs";
import * as path from "path";
import { ethers } from "ethers";

export const NATIVE_TOKEN = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
export const WBNB = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";

export interface TokenEntry {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  priceUsd: number;
  marketCap: number;
  volume24h: number;
  isNative: boolean;
}

interface TokensFile {
  updatedAt: string;
  chain: string;
  chainId: number;
  count: number;
  tokens: TokenEntry[];
}

// ── Load tokens.json ────────────────────────────────────────────────
let _cache: TokensFile | null = null;

function tokensFilePath(): string {
  const currentDir = path.dirname(new URL(import.meta.url).pathname);
  // Walk up from current file until we find data/tokens.json
  let dir = currentDir;
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, "data", "tokens.json");
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  // Fallback: assume one level up from dist/
  return path.join(currentDir, "..", "data", "tokens.json");
}

export function loadTokensFile(): TokensFile {
  if (_cache) return _cache;
  const filePath = tokensFilePath();
  if (!fs.existsSync(filePath)) {
    console.error(`tokens.json not found at ${filePath}. Run: npx @pagg/agg-tool fetch-tokens`);
    process.exit(1);
  }
  _cache = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  return _cache!;
}

export function getTokenList(): TokenEntry[] {
  return loadTokensFile().tokens;
}

// ── Token lookup maps (built lazily) ────────────────────────────────
let _byAddress: Record<string, TokenEntry> | null = null;
let _bySymbol: Record<string, TokenEntry> | null = null;

function buildMaps() {
  if (_byAddress) return;
  _byAddress = {};
  _bySymbol = {};
  for (const t of getTokenList()) {
    _byAddress[t.address.toLowerCase()] = t;
    // Symbol map: first occurrence wins (highest mcap since list is sorted)
    const sym = t.symbol.toUpperCase();
    if (!_bySymbol[sym]) _bySymbol[sym] = t;
  }
  // Ensure WBNB maps to BNB entry
  if (_byAddress[NATIVE_TOKEN] && !_byAddress[WBNB]) {
    _byAddress[WBNB] = { ..._byAddress[NATIVE_TOKEN], address: WBNB, isNative: false };
  }
  // Ensure BNB alias
  if (!_bySymbol["BNB"] && _byAddress[NATIVE_TOKEN]) {
    _bySymbol["BNB"] = _byAddress[NATIVE_TOKEN];
  }
  if (!_bySymbol["WBNB"] && _byAddress[WBNB]) {
    _bySymbol["WBNB"] = _byAddress[WBNB];
  }
}

export function getTokenByAddress(addr: string): TokenEntry | undefined {
  buildMaps();
  return _byAddress![addr.toLowerCase()];
}

export function getTokenBySymbol(symbol: string): TokenEntry | undefined {
  buildMaps();
  return _bySymbol![symbol.toUpperCase()];
}

// ── Convenience functions matching existing script signatures ───────

export function resolveToken(input: string): string {
  if (input.startsWith("0x")) return input.toLowerCase();
  const t = getTokenBySymbol(input);
  if (!t) {
    const available = getTokenList().map(t => t.symbol).slice(0, 20).join(", ");
    console.error(`Unknown token "${input}". Available: ${available} ...`);
    process.exit(1);
  }
  // For Peach: BNB resolves to WBNB address
  return t.address === NATIVE_TOKEN ? WBNB : t.address;
}

export function tokenLabel(addr: string): string {
  const a = addr.toLowerCase();
  if (a === NATIVE_TOKEN || a === WBNB) return "BNB";
  return getTokenByAddress(a)?.symbol ?? addr.slice(0, 10) + "...";
}

export function tokenDecimals(addr: string): number {
  return getTokenByAddress(addr)?.decimals ?? 18;
}

export function fmtAmt(raw: bigint | string, addr: string): string {
  return ethers.formatUnits(BigInt(raw), tokenDecimals(addr));
}
