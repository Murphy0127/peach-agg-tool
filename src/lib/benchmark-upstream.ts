import { createHmac } from "node:crypto";
import { ethers } from "ethers";
import { proxyFetch } from "./common.js";
import { NATIVE, type Case, type Hop, type Profile, type Result } from "./benchmark-model.js";

const arr = (v: any): any[] => Array.isArray(v) ? v : [];
const same = (a: unknown, b: string) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();
export function uint(value: unknown, label = "amount"): string {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,77})$/.test(value) || BigInt(value) >= 1n << 256n) throw new Error(`Invalid ${label}: expected an exact unsigned integer string`);
  return value;
}
function match(value: unknown, expected: string, label: string) {
  if (!same(value, expected)) throw new Error(`Response ${label} differs from request`);
}
export function cleanEvidence(value: unknown): any {
  const secrets = ["OKX_API_KEY", "OKX_SECRET_KEY", "OKX_PASSPHRASE", "OKX_PROJECT_ID", "KYBER_API_KEY", "FLY_API_KEY", "BLOCKSCOUT_API_KEY"]
    .map(k => process.env[k]).filter((s): s is string => !!s && s.length > 3);
  const visit = (v: any): any => {
    if (typeof v === "string") {
      for (const secret of secrets) v = v.split(secret).join("[REDACTED]");
      return v.replace(/((?:api[_-]?key|access[_-]?token|secret|passphrase)=)[^&\s]+/gi, "$1[REDACTED]");
    }
    if (Array.isArray(v)) return v.map(visit);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, /^(api[-_]?key|secret[-_]?key|passphrase|authorization|cookie|OK-ACCESS.*)$/i.test(k) ? "[REDACTED]" : visit(x)]));
    return v;
  };
  return visit(value);
}
/** Bounded, proxy-aware transport. Never follow a credential-bearing redirect. */
export async function fetchJson(url: string, init: { headers?: Record<string, string>; body?: unknown } = {}, max = 2_000_000): Promise<any> {
  const response = await proxyFetch(url, { method: init.body === undefined ? "GET" : "POST",
    headers: { Accept: "application/json", ...(init.body === undefined ? {} : { "Content-Type": "application/json" }), ...init.headers },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }), redirect: "error", signal: AbortSignal.timeout(30000) });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty response body");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > max) throw new Error(`Response exceeds ${max} bytes`);
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function headers(p: Profile, url: string): Record<string, string> {
  if (p.kind === "okx") {
    const { OKX_API_KEY: key, OKX_SECRET_KEY: secret, OKX_PASSPHRASE: pass, OKX_PROJECT_ID: project } = process.env;
    if (!key || !secret || !pass) throw new Error("Missing OKX_API_KEY / OKX_SECRET_KEY / OKX_PASSPHRASE");
    const time = new Date().toISOString(), u = new URL(url);
    return { "OK-ACCESS-KEY": key, "OK-ACCESS-PASSPHRASE": pass, "OK-ACCESS-TIMESTAMP": time,
      "OK-ACCESS-SIGN": createHmac("sha256", secret).update(time + "GET" + u.pathname + u.search).digest("base64"),
      ...(project ? { "OK-ACCESS-PROJECT": project } : {}) };
  }
  if (p.kind === "kyber") return { "x-client-id": process.env.KYBER_CLIENT_ID ?? "peach-agg-tool", ...(process.env.KYBER_API_KEY ? { "x-api-key": process.env.KYBER_API_KEY } : {}) };
  if (p.kind === "fly" && process.env.FLY_API_KEY) return { apikey: process.env.FLY_API_KEY };
  return {};
}
export function quoteRequest(p: Profile, c: Case) {
  const api = p.api.replace(/\/$/, "");
  let endpoint: string, params: Record<string, string>;
  if (p.kind === "peach") {
    endpoint = `${api}/router/find_routes`;
    params = { from: c.from, target: c.target, amount: c.amountIn, by_amount_in: "true", depth: String(c.depth ?? 3), split_count: String(c.splitCount ?? 5), v: "1001500" };
    if (c.providers) params.providers = c.providers;
  } else if (p.kind === "kyber") {
    if (![56, 5042].includes(c.chainId)) throw new Error("Kyber supports only configured BSC/ARC mainnet profiles");
    endpoint = `${api}/${c.chainId === 56 ? "bsc" : "arc"}/api/v1/routes`;
    params = { tokenIn: c.from, tokenOut: c.target, amountIn: c.amountIn, gasInclude: "true" };
  } else if (p.kind === "okx") {
    endpoint = `${api}/api/v6/dex/aggregator/quote`;
    params = { chainIndex: String(c.chainId), fromTokenAddress: c.from, toTokenAddress: c.target, amount: c.amountIn, swapMode: "exactIn" };
  } else {
    if (c.chainId !== 5042) throw new Error("Fly is configured for ARC mainnet only");
    endpoint = `${api}/aggregator/quote`;
    params = { network: process.env.FLY_NETWORK ?? "arc", fromTokenAddress: c.from, toTokenAddress: c.target, sellAmount: c.amountIn,
      slippage: String(c.slippageBps / 10000), fromAddress: c.sender, toAddress: c.recipient ?? c.sender, gasless: "false" };
  }
  return { endpoint, params };
}
async function call(p: Profile, endpoint: string, params: Record<string, string>, body?: unknown) {
  const url = endpoint + (Object.keys(params).length ? `?${new URLSearchParams(params)}` : "");
  return fetchJson(url, { headers: headers(p, url), body }, 2_000_000);
}
export function normalize(p: Profile, c: Case, body: any): { amountOut: string; routes: Hop[] | null; quoteId?: string; quoteTimestamp?: number } {
  if (body?.simulation === true || body?.data?.simulation === true) throw new Error("Upstream returned a mock/simulation quote");
  let amount: unknown, routes: Hop[] | null = null, quoteId: string | undefined, quoteTimestamp: number | undefined;
  if (p.kind === "peach") {
    if (body?.code !== 200 || !body.data) throw new Error(body?.msg ?? "Invalid Peach quote");
    const d = body.data;
    match(d.amount_in, c.amountIn, "amount_in"); amount = d.amount_out; quoteId = d.request_id; quoteTimestamp = d.quote_ts;
    if (!Array.isArray(d.paths) || !d.paths.length) throw new Error("Missing Peach route paths");
    routes = d.paths.map((h: any) => {
      if (!ethers.isAddress(h.token_in) || !ethers.isAddress(h.token_out)) throw new Error("Invalid Peach route token");
      return { dex: String(h.provider), pool: typeof h.pool === "string" ? h.pool.toLowerCase() : null,
        tokenIn: h.token_in.toLowerCase(), tokenOut: h.token_out.toLowerCase(), amountIn: uint(h.amount_in), amountOut: uint(h.amount_out), feeRate: h.fee_rate ?? null };
    });
    const input = routes!.filter(h => same(h.tokenIn, c.from)).reduce((n, h) => n + BigInt(h.amountIn!), 0n);
    const output = routes!.filter(h => same(h.tokenOut, c.target)).reduce((n, h) => n + BigInt(h.amountOut!), 0n);
    if (input !== BigInt(c.amountIn) || output !== BigInt(uint(amount))) throw new Error("Peach route boundary amounts do not match quote");
  } else if (p.kind === "kyber") {
    if (body?.code !== 0 || !body.data?.routeSummary) throw new Error(body?.message ?? "Invalid Kyber quote");
    const d = body.data.routeSummary;
    match(d.tokenIn, c.from, "tokenIn"); match(d.tokenOut, c.target, "tokenOut"); match(d.amountIn, c.amountIn, "amountIn");
    amount = d.amountOut; quoteId = d.routeID;
    routes = arr(d.route).flatMap(r => arr(r).map(h => ({ dex: String(h.exchange), pool: typeof h.pool === "string" ? h.pool.toLowerCase() : null,
      tokenIn: h.tokenIn, tokenOut: h.tokenOut, amountIn: typeof h.swapAmount === "string" ? h.swapAmount : null, amountOut: typeof h.amountOut === "string" ? h.amountOut : null })));
  } else if (p.kind === "okx") {
    if (body?.code !== "0" || !body.data?.length) throw new Error(body?.msg ?? "Invalid OKX quote");
    const d = body.data[0];
    match(String(d.chainIndex), String(c.chainId), "chainIndex");
    match(d.fromToken?.tokenContractAddress, c.from, "fromToken"); match(d.toToken?.tokenContractAddress, c.target, "toToken"); match(d.fromTokenAmount, c.amountIn, "fromTokenAmount");
    amount = d.toTokenAmount;
    routes = arr(d.dexRouterList).flatMap(r => (arr(r.subRouterList).length ? r.subRouterList : [r]).flatMap((s: any) => (Array.isArray(s.dexProtocol) ? s.dexProtocol : [s.dexProtocol]).filter(Boolean).map((d: any) => ({
      dex: String(d.dexName), pool: null, tokenIn: s.fromToken?.tokenContractAddress ?? "", tokenOut: s.toToken?.tokenContractAddress ?? "", amountIn: null, amountOut: null,
    }))));
  } else {
    const d = body?.typedData?.message;
    if (!d) throw new Error(body?.message ?? "Invalid Fly quote");
    match(String(body.typedData.domain?.chainId), String(c.chainId), "chainId");
    match(d.fromAsset, c.from, "fromAsset"); match(d.toAsset, c.target, "toAsset");
    match(d.sender, c.sender, "sender"); match(d.recipient, c.recipient ?? c.sender, "recipient");
    amount = body.amountOut; quoteId = body.id;
    if (!/^\d+$/.test(String(d.deadline)) || Number(d.deadline) * 1000 <= Date.now()) throw new Error("Fly quote expired or missing deadline");
  }
  const amountOut = uint(amount, "output");
  if (BigInt(amountOut) === 0n) throw new Error("Zero output amount");
  return { amountOut, routes, quoteId, quoteTimestamp };
}
export async function fetchQuote(p: Profile, c: Case): Promise<Result> {
  const start = Date.now();
  const result: Result = { name: p.name, kind: p.kind, ok: false, latencyMs: 0, simulation: { status: "SKIPPED" } };
  try {
    if (c.from === NATIVE || c.target === NATIVE) throw new Error("Benchmark requires ERC-20 tokens; use WBNB for BSC and the canonical USDC ERC-20 interface for ARC");
    const { endpoint, params } = quoteRequest(p, c);
    result.endpoint = endpoint; result.requestParams = params;
    const body = await call(p, endpoint, params); result.raw = body;
    Object.assign(result, normalize(p, c, body)); result.ok = true;
  } catch (error) { result.error = (error as Error).message; }
  result.latencyMs = Date.now() - start;
  return result;
}
/** Build refreshes its own route. Preserve both quote and build outputs. */
export async function build(p: Profile, c: Case, result: Result): Promise<void> {
  if (!result.ok) return;
  const start = Date.now(); const captures: unknown[] = [];
  const capture = async (endpoint: string, params: Record<string, string>, body?: unknown) => {
    const response = await call(p, endpoint, params, body);
    captures.push({ endpoint, params, requestBody: body ?? null, response }); return response;
  };
  try {
    const { endpoint, params } = quoteRequest(p, c); let tx: any, spender: unknown, expected: unknown, minimum: unknown;
    if (p.kind === "peach") {
      const body = await capture(`${p.api.replace(/\/$/, "")}/router/swap`, { ...params,
        executor: c.sender, payer: c.sender, recipient: c.recipient ?? c.sender,
        slippage_bps: String(c.slippageBps), custom_fee_bps: "0", deadline_secs: "300", native_in: "false", native_out: "false" });
      if (body?.code !== 200 || !body.data) throw new Error(body?.msg ?? "Invalid Peach build");
      const d = body.data;
      match(d.amount_in, c.amountIn, "build amount_in");
      for (const role of ["payer", "executor", "recipient"]) match(d[role], role === "recipient" ? c.recipient ?? c.sender : c.sender, role);
      if (d.custom_fee_bps !== 0 || uint(d.custom_fee_amount) !== "0") throw new Error("Unrequested custom fee in Peach build");
      expected = d.expect_amount_out; result.grossAmountOut = uint(d.amount_out); result.feeAmount = d.custom_fee_amount;
      tx = d.tx; spender = tx?.to; minimum = tx?.amount_out_min;
      if (d.contracts?.execution_router) match(tx?.to, d.contracts.execution_router, "execution router");
    } else if (p.kind === "kyber") {
      const fresh = await capture(endpoint, { ...params, excludeRFQSources: "true" }); normalize(p, c, fresh);
      const d = await capture(endpoint.replace(/\/routes$/, "/route/build"), {}, { routeSummary: fresh.data.routeSummary,
        sender: c.sender, origin: c.sender, recipient: c.recipient ?? c.sender, slippageTolerance: c.slippageBps,
        deadline: Math.floor(Date.now() / 1000) + 300, enableGasEstimation: false, source: "peach-agg-tool" });
      if (d.code !== 0 || d.data?.amountIn !== c.amountIn) throw new Error("Invalid Kyber build amount");
      match(d.data.routerAddress, fresh.data.routerAddress, "Kyber router");
      tx = { to: d.data.routerAddress, data: d.data.data, value: d.data.transactionValue }; spender = tx.to; expected = d.data.amountOut;
    } else if (p.kind === "okx") {
      const d = await capture(endpoint.replace(/\/quote$/, "/swap"), { ...params, slippagePercent: String(c.slippageBps / 100), userWalletAddress: c.sender, swapReceiverAddress: c.recipient ?? c.sender });
      if (d.code !== "0" || !d.data?.[0]) throw new Error(d.msg ?? "Invalid OKX build");
      const data = d.data[0]; normalize(p, c, { code: "0", data: [data.routerResult] });
      tx = data.tx; match(tx?.from, c.sender, "transaction sender"); expected = data.routerResult.toTokenAmount; minimum = tx.minReceiveAmount;
      const approval = await capture(endpoint.replace(/\/quote$/, "/approve-transaction"), { chainIndex: String(c.chainId), tokenContractAddress: c.from, approveAmount: c.amountIn });
      const a = approval.data?.[0];
      if (approval.code !== "0" || !a?.data) throw new Error("Missing OKX approval transaction");
      const decoded = new ethers.Interface(["function approve(address,uint256)"]).decodeFunctionData("approve", a.data);
      match(decoded[0], a.dexContractAddress, "approval spender");
      if (decoded[1] !== BigInt(c.amountIn)) throw new Error("OKX approval amount mismatch");
      spender = a.dexContractAddress;
    } else {
      const d = await capture(`${endpoint}/transaction`, params); const fresh = normalize(p, c, d.quote);
      tx = d.transaction; match(tx?.from, c.sender, "transaction sender"); match(String(tx?.chainId), String(c.chainId), "transaction chain");
      match(tx?.to, d.quote.typedData.message.router, "Fly router");
      spender = d.quote.targetAddress; expected = fresh.amountOut; minimum = d.quote.typedData.message.amountOutMin;
    }
    if (!ethers.isAddress(tx?.to) || !ethers.isAddress(String(spender)) || !/^0x(?:[0-9a-fA-F]{2}){4,131072}$/.test(tx?.data)) throw new Error("Invalid transaction/approval target or calldata");
    if (uint(tx.value, "transaction value") !== "0") throw new Error("ERC-20 benchmark cannot attach native value");
    const amount = uint(expected, "build output"), floor = BigInt(amount) * BigInt(10000 - c.slippageBps) / 10000n;
    const min = uint(minimum ?? floor.toString(), "minimum output");
    if (BigInt(amount) === 0n || BigInt(min) < floor || BigInt(min) > BigInt(amount)) throw new Error("Invalid built minimum output");
    result.tx = { to: tx.to, data: tx.data, value: tx.value }; result.spender = String(spender); result.builtAmountOut = amount; result.minimumOut = min;
  } catch (error) {
    result.buildError = (error as Error).message;
    result.simulation = { status: "FAILED", stage: "build", error: result.buildError };
  } finally { result.buildRaw = captures; result.buildLatencyMs = Date.now() - start; }
}
