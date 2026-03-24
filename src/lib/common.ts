/**
 * Shared utilities for aggregator test tools.
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { ethers } from "ethers";
import { ProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";

// ── Env loading ─────────────────────────────────────────────────────
export function loadEnvFile(filePath: string) {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const m = trimmed.match(/^(\w+)\s*=\s*"?([^"]*)"?\s*$/);
      if (m) process.env[m[1]] = m[2];
    }
  } catch {}
}

export function loadOkxEnv(envFilePath?: string) {
  // Priority: explicit path > skill dir .env > ~/.okx/.env
  if (envFilePath) {
    if (!fs.existsSync(envFilePath)) {
      console.error(`Env file not found: ${envFilePath}`);
      process.exit(1);
    }
    loadEnvFile(envFilePath);
    return;
  }

  // Search for .env in the skill directory (relative to package root)
  const currentDir = path.dirname(new URL(import.meta.url).pathname);
  let dir = currentDir;
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, "skills", "peach", ".env");
    if (fs.existsSync(candidate)) {
      loadEnvFile(candidate);
      return;
    }
    dir = path.dirname(dir);
  }

  // Fallback: ~/.okx/.env
  loadEnvFile(path.join(os.homedir(), ".okx", ".env"));
}

// ── Proxy-aware fetch ───────────────────────────────────────────────
const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY;
const dispatcher: Dispatcher | undefined = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;

export function proxyFetch(url: string, init?: Parameters<typeof undiciFetch>[1]) {
  return undiciFetch(url, { ...init, dispatcher });
}

// ── OKX Auth ────────────────────────────────────────────────────────
export function getOkxCreds() {
  const { OKX_API_KEY: apiKey, OKX_SECRET_KEY: secretKey, OKX_PASSPHRASE: passphrase, OKX_PROJECT_ID: projectId } = process.env;
  if (!apiKey || !secretKey || !passphrase || !projectId) {
    throw new Error("Missing OKX credentials (OKX_API_KEY, OKX_SECRET_KEY, OKX_PASSPHRASE, OKX_PROJECT_ID). Configure in skills/peach/.env or use --env-file");
  }
  return { apiKey, secretKey, passphrase, projectId };
}

export function okxHeaders(method: string, reqPath: string) {
  const creds = getOkxCreds();
  const ts = new Date().toISOString();
  const sign = crypto.createHmac("sha256", creds.secretKey).update(ts + method + reqPath).digest("base64");
  return {
    "OK-ACCESS-KEY": creds.apiKey, "OK-ACCESS-SIGN": sign,
    "OK-ACCESS-TIMESTAMP": ts, "OK-ACCESS-PASSPHRASE": creds.passphrase,
    "OK-ACCESS-PROJECT": creds.projectId, "Content-Type": "application/json",
  };
}

// ── OKX approve spender (TokenApprovalProxy) ────────────────────────
let _okxApproveSpender: string | null = null;
export async function getOkxApproveSpender(): Promise<string> {
  if (_okxApproveSpender) return _okxApproveSpender;
  const USDT = "0x55d398326f99059ff775485246999027b3197955";
  const params = new URLSearchParams({
    chainIndex: "56", tokenContractAddress: USDT, approveAmount: "1",
  });
  const reqPath = `/api/v6/dex/aggregator/approve-transaction?${params}`;
  const resp = await proxyFetch(`https://www.okx.com${reqPath}`, {
    headers: okxHeaders("GET", reqPath), signal: AbortSignal.timeout(10000),
  });
  const json = await resp.json() as any;
  if (json.code === "0" && json.data?.[0]?.dexContractAddress) {
    _okxApproveSpender = json.data[0].dexContractAddress;
    return _okxApproveSpender!;
  }
  throw new Error(`Failed to fetch OKX approve spender: ${json.msg ?? json.code}`);
}

// ── ERC20 state overrides ───────────────────────────────────────────
const STATE_OVERRIDE_SLOTS = [0, 1, 2, 9, 10, 11, 12, 13, 50, 51, 52, 100, 101, 102];

export function buildErc20StateOverrides(
  tokenAddress: string, owner: string, spender: string, balance: bigint,
): Record<string, { stateDiff: Record<string, string> }> {
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  const balanceHex = ethers.zeroPadValue(ethers.toBeHex(balance), 32);
  const maxAllowance = ethers.zeroPadValue(ethers.toBeHex(ethers.MaxUint256), 32);
  const stateDiff: Record<string, string> = {};

  for (const slot of STATE_OVERRIDE_SLOTS) {
    const balKey = ethers.keccak256(abiCoder.encode(['address', 'uint256'], [owner, slot]));
    stateDiff[balKey] = balanceHex;
    const inner = ethers.keccak256(abiCoder.encode(['address', 'uint256'], [owner, slot]));
    const allowKey = ethers.keccak256(abiCoder.encode(['address', 'bytes32'], [spender, inner]));
    stateDiff[allowKey] = maxAllowance;
  }

  return { [tokenAddress.toLowerCase()]: { stateDiff } };
}

// ── Whale addresses for simulation ──────────────────────────────────
const WHALE_ADDRS = [
  "0xF977814e90dA44bFA03b6295A0616a897441aceC",
  "0x8894E0a0c962CB723c1ef8a1B68B3462Ec26BB46",
  "0x28C6c06298d514Db089934071355E5743bf21d60",
  "0x21a31Ee1afC51d94C2eFcCAa2092aD1028285549",
  "0x4B16c5dE96EB2117bBE5fd171E4d203624B014aa",
];

const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];

export async function findSender(
  provider: ethers.JsonRpcProvider, tokenAddr: string, required: bigint, isNative: boolean,
): Promise<string> {
  for (const addr of WHALE_ADDRS) {
    try {
      if (isNative) {
        if ((await provider.getBalance(addr)) >= required) return addr;
      } else {
        const tok = new ethers.Contract(tokenAddr, ERC20_ABI, provider);
        if ((await tok.balanceOf(addr) as bigint) >= required) return addr;
      }
    } catch {}
  }
  return WHALE_ADDRS[0];
}

// ── Revert decoder ──────────────────────────────────────────────────
export function decodeRevert(revertData: string, targetAddr: string): string {
  if (!revertData || revertData.length < 10) return "";
  const sel = revertData.slice(0, 10);
  if (sel === "0x08c379a0" && revertData.length > 138) {
    try {
      const [reason] = ethers.AbiCoder.defaultAbiCoder().decode(["string"], "0x" + revertData.slice(10));
      return reason;
    } catch {}
  }
  if (sel === "0x2c19b8b8" && revertData.length >= 138) {
    const actual = BigInt("0x" + revertData.slice(10, 74));
    const min = BigInt("0x" + revertData.slice(74, 138));
    return `TooLittleReceived: actual=${actual}, min=${min}`;
  }
  return `selector=${sel}`;
}

// ── Formatting helpers ──────────────────────────────────────────────
export function pad(s: string, n: number) { return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length); }
export function padL(s: string, n: number) { return s.length >= n ? s : " ".repeat(n - s.length) + s; }

export function fmtN(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(2) + "K";
  return n.toFixed(2);
}

export function fmtTable(headers: string[], rows: string[][], colAligns?: ("l" | "r")[]): string {
  const cw = headers.map((h, i) => Math.max(h.length, ...rows.map(r => (r[i] ?? "").length)));
  const al = colAligns ?? headers.map(() => "l");
  const p = (s: string, w: number, a: "l" | "r") => a === "r" ? padL(s, w) : pad(s, w);
  const sep = "+-" + cw.map(w => "-".repeat(w)).join("-+-") + "-+";
  const fr = (row: string[]) => "| " + row.map((c, i) => p(c ?? "", cw[i], al[i])).join(" | ") + " |";
  return [sep, fr(headers), sep, ...rows.map(r => fr(r)), sep].join("\n");
}

export function fmtKV(pairs: [string, string][]): string {
  const kw = Math.max(...pairs.map(([k]) => k.length));
  const vw = Math.max(...pairs.map(([, v]) => v.length));
  const sep = "+-" + "-".repeat(kw) + "-+-" + "-".repeat(vw) + "-+";
  return [sep, ...pairs.map(([k, v]) => `| ${pad(k, kw)} | ${pad(v, vw)} |`), sep].join("\n");
}

export function printKV(pairs: [string, string][]) { console.log(fmtKV(pairs)); }
export function printTable(h: string[], r: string[][], a?: ("l" | "r")[]) { console.log(fmtTable(h, r, a)); }

export function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

export function appendLog(logPath: string, entry: Record<string, any>) {
  fs.appendFileSync(logPath, JSON.stringify(entry) + "\n", "utf-8");
}

// ── Constants ───────────────────────────────────────────────────────
export const USDT = "0x55d398326f99059ff775485246999027b3197955";
export const USDC = "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d";
export const TARGET_TOKENS = [
  { address: USDT, symbol: "USDT", decimals: 18 },
  { address: USDC, symbol: "USDC", decimals: 18 },
  { address: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", symbol: "BNB", decimals: 18 },
];

// ── Token pool for continuous tests ─────────────────────────────────
import { NATIVE_TOKEN, WBNB, getTokenList } from "./tokens.js";
export { NATIVE_TOKEN, WBNB };

export interface TokenInfo {
  address: string;
  okxAddress: string;
  peachAddress: string;
  symbol: string;
  decimals: number;
  priceUsd: number;
}

export function loadTokenPool(): TokenInfo[] {
  return getTokenList().map(t => ({
    address: t.address,
    okxAddress: t.isNative ? NATIVE_TOKEN : t.address,
    peachAddress: t.isNative ? WBNB : (t.address === WBNB ? WBNB : t.address),
    symbol: t.symbol,
    decimals: t.decimals,
    priceUsd: t.priceUsd,
  }));
}

// ── Shared result type ──────────────────────────────────────────────
export interface AggResult {
  name: string;
  ok: boolean;
  amountIn: bigint;
  amountOut: bigint;
  amountOutUsd: number;
  latencyMs: number;
  error?: string;
  routes: { dexName: string; percent: number; volumeUsd: number; fromToken: string; toToken: string; path?: string }[];
  gasEstimate: string;
  priceImpact: string;
  // Simulation
  simStatus: "SUCCESS" | "FAILED" | "SKIPPED";
  simAmountOut: bigint;
  simLatencyMs: number;
  simError?: string;
  simDeviationPct: number;
  // Raw data
  rawApiResponse?: any;
  txData?: { to: string; data: string; value: string; gas: string } | null;
}

export function emptyResult(name: string, amountIn: bigint): AggResult {
  return {
    name, ok: false, amountIn, amountOut: 0n, amountOutUsd: 0, latencyMs: 0,
    routes: [], gasEstimate: "-", priceImpact: "-",
    simStatus: "SKIPPED", simAmountOut: 0n, simLatencyMs: 0, simDeviationPct: 0,
  };
}
