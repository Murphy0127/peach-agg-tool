import { ethers } from "ethers";
import { fetchJson } from "./benchmark-upstream.js";
import { ARC_USDC, NATIVE, type Block } from "./benchmark-model.js";

export const ERC20 = new ethers.Interface(["function decimals() view returns(uint8)", "function balanceOf(address) view returns(uint256)", "function allowance(address,address) view returns(uint256)", "function approve(address,uint256) returns(bool)"]);
const METHODS = new Set(["eth_chainId", "eth_blockNumber", "eth_getBlockByNumber", "eth_getBalance", "eth_getCode", "eth_call", "eth_getLogs", "eth_gasPrice", "eth_simulateV1"]);
export class RpcError extends Error {}
export async function rpc(url: string, method: string, params: unknown[]): Promise<any> {
  if (!METHODS.has(method)) throw new Error(`RPC method ${method} is not read-only/allowed`);
  try {
    const json = await fetchJson(url, { body: { jsonrpc: "2.0", id: 1, method, params } }, 8_000_000);
    if (json.jsonrpc !== "2.0" || json.id !== 1) throw new Error("Invalid RPC response identity");
    if (json.error) throw new Error(`${method}: ${json.error.message ?? "RPC error"}`);
    if (json.result === undefined) throw new Error(`${method}: missing result`);
    return json.result;
  } catch (error) { throw new RpcError((error as Error).message); }
}
export async function snapshot(url: string, chainId: number): Promise<Block> {
  if (BigInt(await rpc(url, "eth_chainId", [])) !== BigInt(chainId)) throw new Error("RPC chain ID does not match --chain");
  const b = await rpc(url, "eth_getBlockByNumber", ["latest", false]);
  if (!b || !/^0x[0-9a-fA-F]{64}$/.test(b.hash) || !/^0x[0-9a-fA-F]+$/.test(b.number) || !/^0x[0-9a-fA-F]+$/.test(b.timestamp)) throw new Error("Invalid RPC block");
  const timestamp = Number(BigInt(b.timestamp));
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) throw new Error("Invalid block timestamp");
  return { number: b.number, hash: b.hash, timestamp };
}
export async function verifyBlock(url: string, block: Block): Promise<boolean> {
  const current = await rpc(url, "eth_getBlockByNumber", [block.number, false]);
  return current?.hash?.toLowerCase() === block.hash.toLowerCase() && BigInt(current.number) === BigInt(block.number);
}
export function chainToken(chainId: number, input: string): string {
  if (/^0x[0-9a-fA-F]{40}$/.test(input) && ethers.isAddress(input) && input.toLowerCase() !== ethers.ZeroAddress) return input.toLowerCase();
  const aliases: Record<number, Record<string, string>> = {
    56: { BNB: NATIVE, WBNB: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c", USDT: "0x55d398326f99059ff775485246999027b3197955", USDC: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d" },
    5042002: { USDC: ARC_USDC },
    5042: { USDC: ARC_USDC, WUSDC: "0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f" },
  };
  const token = aliases[chainId]?.[input.toUpperCase()];
  if (!token) throw new Error(`Unknown token ${input} on chain ${chainId}; provide its address`);
  return token;
}
export async function decimals(url: string, token: string, block: string): Promise<number> {
  if (token === NATIVE) return 18;
  try {
    const raw = await rpc(url, "eth_call", [{ to: token, data: ERC20.encodeFunctionData("decimals") }, block]);
    return Number(ERC20.decodeFunctionResult("decimals", raw)[0]);
  } catch (error) { throw new Error(`Cannot read decimals for ${token} at ${block}: ${(error as Error).message}`); }
}
export async function inspectSender(url: string, token: string, address: string, block: string) {
  const [balance, nativeBalance, code] = await Promise.all([
    rpc(url, "eth_call", [{ to: token, data: ERC20.encodeFunctionData("balanceOf", [address]) }, block]),
    rpc(url, "eth_getBalance", [address, block]), rpc(url, "eth_getCode", [address, block]),
  ]);
  return { address, balance: String(ERC20.decodeFunctionResult("balanceOf", balance)[0]), nativeBalance: BigInt(nativeBalance).toString(), code };
}
/** Bounded discovery, matching Manager's fixed BSC candidate + recent Transfers.
 * All candidates are verified against real pinned EOA/token/native balances. */
export async function discoverSender(url: string, chain: number, token: string, amount: bigint, block: Block) {
  const candidates = new Set<string>();
  if (chain === 56) candidates.add("0xf977814e90da44bfa03b6295a0616a897441acec");
  const failures = { checked: 0, contracts: 0, tokenBalance: 0, nativeBalance: 0, rpc: 0 };
  const verify = async (addresses: string[]) => {
    for (let i = 0; i < addresses.length; i += 4) {
      const batch = await Promise.allSettled(addresses.slice(i, i + 4).map(a => inspectSender(url, token, a, block.number)));
      for (const r of batch) {
        failures.checked++;
        if (r.status === "rejected") { failures.rpc++; continue; }
        if (r.value.code !== "0x") { failures.contracts++; continue; }
        if (BigInt(r.value.balance) < amount) { failures.tokenBalance++; continue; }
        const inputNative = [5042, 5042002].includes(chain) && token === ARC_USDC ? amount * 10n ** 12n : 0n;
        if (BigInt(r.value.nativeBalance) <= inputNative) { failures.nativeBalance++; continue; }
        return r.value;
      }
    }
  };
  let selected = await verify([...candidates]);
  let logError: string | null = null;
  if (!selected) {
    try {
      const height = BigInt(block.number);
      const logs = await rpc(url, "eth_getLogs", [{ address: token, fromBlock: ethers.toQuantity(height > 127n ? height - 127n : 0n), toBlock: block.number, topics: [ethers.id("Transfer(address,address,uint256)")] }]);
      if (!Array.isArray(logs)) throw new Error("Invalid Transfer logs");
      for (const log of logs.slice(-500).reverse()) {
        if (log.removed || String(log.address).toLowerCase() !== token) continue;
        for (const topic of [log.topics?.[2], log.topics?.[1]]) {
          if (typeof topic !== "string" || !/^0x0{24}[0-9a-fA-F]{40}$/.test(topic)) continue;
          const a = `0x${topic.slice(-40)}`.toLowerCase();
          if (a !== ethers.ZeroAddress && a !== "0x000000000000000000000000000000000000dead") candidates.add(a);
        }
        if (candidates.size >= 24) break;
      }
      selected = await verify([...candidates].slice(0, 24));
    } catch (error) { logError = (error as Error).message; }
  }
  if (!selected) throw new Error(`No funded EOA sender found in bounded candidate search: ${JSON.stringify(failures)}${logError ? `; ${logError}` : ""}. Specify --sender.`);
  if (!await verifyBlock(url, block)) throw new Error("Sender discovery block changed; retry");
  return { selected, block, failures, sources: ["BSC seed (BSC only), then up to 24 candidates from recent 128 blocks of Transfers"], notes: ["Candidate verification does not prove authorization or execution; no balance overrides used"] };
}
