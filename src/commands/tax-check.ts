/**
 * tax-check command: detect token transfer tax using pure on-chain simulation.
 *
 * Deploys a helper contract via eth_call that:
 *   1. Buys the token via PancakeV2 Router (FeeOnTransfer variant)
 *   2. Compares getAmountsOut (expected, no tax) vs actual balanceOf (received)
 *   3. Transfers half to address(0xdead) and checks balanceOf diff
 *   4. Returns results via revert data
 *
 * Completely independent of Peach — pure on-chain measurement.
 */

import { ethers } from "ethers";
import { printKV, printTable, findSender, WBNB } from "../lib/common.js";
import { resolveToken, tokenLabel, fmtAmt, tokenDecimals } from "../lib/tokens.js";

// Pre-compiled bytecode of TaxInline.sol — constructor(address token) payable
// Buys token with msg.value BNB, measures buy tax, then transfers half and measures transfer tax.
// Returns data via revert: abi.encode(expected, actualReceived, transferSent, transferReceived)
const TAX_CHECKER_BYTECODE =
  "0x6080604052604051610b9e380380610b9e833981810160405281019061002591906105ba565b60007310ed43c718714eb63d5aa57b78b54704e256024e9050600073bb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c90506000600267ffffffffffffffff811115610074576100736105e7565b5b6040519080825280602002602001820160405280156100a25781602001602082028036833780820191505090505b50905081816000815181106100ba576100b9610616565b5b602002602001019073ffffffffffffffffffffffffffffffffffffffff16908173ffffffffffffffffffffffffffffffffffffffff1681525050838160018151811061010957610108610616565b5b602002602001019073ffffffffffffffffffffffffffffffffffffffff16908173ffffffffffffffffffffffffffffffffffffffff168152505060008373ffffffffffffffffffffffffffffffffffffffff1663d06ca61f34846040518363ffffffff1660e01b815260040161018092919061071c565b600060405180830381865afa15801561019d573d6000803e3d6000fd5b505050506040513d6000823e3d601f19601f820116820180604052508101906101c691906108a2565b90506000816001815181106101de576101dd610616565b5b6020026020010151905060008673ffffffffffffffffffffffffffffffffffffffff166370a08231306040518263ffffffff1660e01b815260040161022391906108fa565b602060405180830381865afa158015610240573d6000803e3d6000fd5b505050506040513d601f19601f820116820180604052508101906102649190610915565b90508573ffffffffffffffffffffffffffffffffffffffff1663b6f9de953460008730610e10426102959190610971565b6040518663ffffffff1660e01b81526004016102b494939291906109ea565b6000604051808303818588803b1580156102cd57600080fd5b505af11580156102e1573d6000803e3d6000fd5b505050505060008773ffffffffffffffffffffffffffffffffffffffff166370a08231306040518263ffffffff1660e01b815260040161032191906108fa565b602060405180830381865afa15801561033e573d6000803e3d6000fd5b505050506040513d601f19601f820116820180604052508101906103629190610915565b9050600082826103729190610a36565b905060006002826103839190610a99565b905060008a73ffffffffffffffffffffffffffffffffffffffff166370a0823161dead6040518263ffffffff1660e01b81526004016103c291906108fa565b602060405180830381865afa1580156103df573d6000803e3d6000fd5b505050506040513d601f19601f820116820180604052508101906104039190610915565b90508a73ffffffffffffffffffffffffffffffffffffffff1663a9059cbb61dead846040518363ffffffff1660e01b8152600401610442929190610aca565b6020604051808303816000875af1158015610461573d6000803e3d6000fd5b505050506040513d601f19601f820116820180604052508101906104859190610b2b565b5060008b73ffffffffffffffffffffffffffffffffffffffff166370a0823161dead6040518263ffffffff1660e01b81526004016104c391906108fa565b602060405180830381865afa1580156104e0573d6000803e3d6000fd5b505050506040513d601f19601f820116820180604052508101906105049190610915565b9050600082826105149190610a36565b905060008886868460405160200161052f9493929190610b58565b6040516020818303038152906040529050805160208201fd5b6000604051905090565b600080fd5b600080fd5b600073ffffffffffffffffffffffffffffffffffffffff82169050919050565b60006105878261055c565b9050919050565b6105978161057c565b81146105a257600080fd5b50565b6000815190506105b48161058e565b92915050565b6000602082840312156105d0576105cf610552565b5b60006105de848285016105a5565b91505092915050565b7f4e487b7100000000000000000000000000000000000000000000000000000000600052604160045260246000fd5b7f4e487b7100000000000000000000000000000000000000000000000000000000600052603260045260246000fd5b6000819050919050565b61065881610645565b82525050565b600081519050919050565b600082825260208201905092915050565b6000819050602082019050919050565b6106938161057c565b82525050565b60006106a5838361068a565b60208301905092915050565b6000602082019050919050565b60006106c98261065e565b6106d38185610669565b93506106de8361067a565b8060005b8381101561070f5781516106f68882610699565b9750610701836106b1565b9250506001810190506106e2565b5085935050505092915050565b6000604082019050610731600083018561064f565b818103602083015261074381846106be565b90509392505050565b600080fd5b6000601f19601f8301169050919050565b61076b82610751565b810181811067ffffffffffffffff8211171561078a576107896105e7565b5b80604052505050565b600061079d610548565b90506107a98282610762565b919050565b600067ffffffffffffffff8211156107c9576107c86105e7565b5b602082029050602081019050919050565b600080fd5b6107e881610645565b81146107f357600080fd5b50565b600081519050610805816107df565b92915050565b600061081e610819846107ae565b610793565b90508083825260208201905060208402830185811115610841576108406107da565b5b835b8181101561086a578061085688826107f6565b845260208401935050602081019050610843565b5050509392505050565b600082601f8301126108895761088861074c565b5b815161089984826020860161080b565b91505092915050565b6000602082840312156108b8576108b7610552565b5b600082015167ffffffffffffffff8111156108d6576108d5610557565b5b6108e284828501610874565b91505092915050565b6108f48161057c565b82525050565b600060208201905061090f60008301846108eb565b92915050565b60006020828403121561092b5761092a610552565b5b6000610939848285016107f6565b91505092915050565b7f4e487b7100000000000000000000000000000000000000000000000000000000600052601160045260246000fd5b600061097c82610645565b915061098783610645565b925082820190508082111561099f5761099e610942565b5b92915050565b6000819050919050565b6000819050919050565b60006109d46109cf6109ca846109a5565b6109af565b610645565b9050919050565b6109e4816109b9565b82525050565b60006080820190506109ff60008301876109db565b8181036020830152610a1181866106be565b9050610a2060408301856108eb565b610a2d606083018461064f565b95945050505050565b6000610a4182610645565b9150610a4c83610645565b9250828203905081811115610a6457610a63610942565b5b92915050565b7f4e487b7100000000000000000000000000000000000000000000000000000000600052601260045260246000fd5b6000610aa482610645565b9150610aaf83610645565b925082610abf57610abe610a6a565b5b828204905092915050565b6000604082019050610adf60008301856108eb565b610aec602083018461064f565b9392505050565b60008115159050919050565b610b0881610af3565b8114610b1357600080fd5b50565b600081519050610b2581610aff565b92915050565b600060208284031215610b4157610b40610552565b5b6000610b4f84828501610b16565b91505092915050565b6000608082019050610b6d600083018761064f565b610b7a602083018661064f565b610b87604083018561064f565b610b94606083018461064f565b9594505050505056fe";

interface TaxResult {
  token: string;
  symbol: string;
  expected: bigint;
  actualReceived: bigint;
  buyTaxBps: number;
  transferSent: bigint;
  transferReceived: bigint;
  transferTaxBps: number;
  error?: string;
}

async function checkTax(
  provider: ethers.JsonRpcProvider,
  tokenAddr: string,
  symbol: string,
  bnbAmount: bigint,
  sender: string,
): Promise<TaxResult> {
  const result: TaxResult = {
    token: tokenAddr,
    symbol,
    expected: 0n,
    actualReceived: 0n,
    buyTaxBps: 0,
    transferSent: 0n,
    transferReceived: 0n,
    transferTaxBps: 0,
  };

  const constructorArg = ethers.AbiCoder.defaultAbiCoder().encode(["address"], [tokenAddr]);
  const deployData = TAX_CHECKER_BYTECODE + constructorArg.slice(2);

  try {
    await provider.call({
      from: sender,
      data: deployData,
      value: bnbAmount,
    });
    // Should not reach here — constructor always reverts with data
    result.error = "unexpected: constructor did not revert";
  } catch (e: any) {
    const revertData = e.data;
    if (revertData && revertData.length > 2) {
      const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
        ["uint256", "uint256", "uint256", "uint256"],
        revertData,
      );
      result.expected = decoded[0];
      result.actualReceived = decoded[1];
      result.transferSent = decoded[2];
      result.transferReceived = decoded[3];

      if (result.actualReceived < result.expected) {
        result.buyTaxBps = Number((result.expected - result.actualReceived) * 10000n / result.expected);
      }
      if (result.transferReceived < result.transferSent) {
        result.transferTaxBps = Number((result.transferSent - result.transferReceived) * 10000n / result.transferSent);
      }
    } else {
      result.error = e.message?.slice(0, 200) ?? "unknown revert";
    }
  }

  return result;
}

export async function cmdTaxCheck(args: string[]) {
  if (args.length < 1) {
    console.error(`Usage: peach-agg-tool tax-check <token> [token2 ...] [options]

Detect token transfer tax via pure on-chain simulation (no Peach dependency).
Deploys a helper contract via eth_call that buys the token, then transfers it,
comparing expected vs actual amounts to measure buy tax and transfer tax.

Options:
  --rpc <url>          BSC RPC URL (default: https://bsc-dataseed.bnbchain.org)
  --amount <bnb>       BNB amount to use for test swap (default: 0.1)

Examples:
  npx peach-agg-tool tax-check 0x85E43bF8faAF04ceDdcD03d6C07438b72606a988
  npx peach-agg-tool tax-check VIN LTC CAKE
  npx peach-agg-tool tax-check 0x... --amount 0.5`);
    process.exit(1);
  }

  let rpcUrl = "https://bsc-dataseed.bnbchain.org";
  let bnbAmountStr = "0.1";
  const tokens: string[] = [];

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--rpc": rpcUrl = args[++i]; break;
      case "--amount": bnbAmountStr = args[++i]; break;
      default: tokens.push(args[i]); break;
    }
  }

  const bnbAmount = ethers.parseEther(bnbAmountStr);
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const sender = await findSender(provider, WBNB, bnbAmount * BigInt(tokens.length), true);

  console.log();
  console.log("═══════════════════════════════════════════════════════");
  console.log("  Token Transfer Tax Detection (on-chain)");
  console.log("═══════════════════════════════════════════════════════");
  console.log();
  printKV([
    ["RPC", rpcUrl],
    ["Test amount", `${bnbAmountStr} BNB per token`],
    ["Sender", sender],
    ["Tokens", tokens.length.toString()],
  ]);
  console.log();

  const results: TaxResult[] = [];

  for (const tokenInput of tokens) {
    const tokenAddr = resolveToken(tokenInput);
    const symbol = tokenLabel(tokenAddr);
    console.log(`[${results.length + 1}/${tokens.length}] Testing ${symbol} (${tokenAddr})...`);

    let result = await checkTax(provider, tokenAddr, symbol, bnbAmount, sender);

    // Retry with 10x amount if first attempt fails (some tokens have min-amount restrictions)
    if (result.error && bnbAmount < ethers.parseEther("1.0")) {
      const retryAmount = bnbAmount * 10n;
      console.log(`  First attempt failed, retrying with ${ethers.formatEther(retryAmount)} BNB...`);
      result = await checkTax(provider, tokenAddr, symbol, retryAmount, sender);
    }

    results.push(result);

    if (result.error) {
      console.log(`  ERROR: ${result.error}\n`);
      continue;
    }

    const decimals = tokenDecimals(tokenAddr);

    printKV([
      ["Token", `${symbol} (${tokenAddr})`],
      ["Expected (no tax)", `${ethers.formatUnits(result.expected, decimals)} ${symbol}`],
      ["Actually received", `${ethers.formatUnits(result.actualReceived, decimals)} ${symbol}`],
      ["Buy tax", `${(result.buyTaxBps / 100).toFixed(2)}% (${result.buyTaxBps} bps)`],
      ["Transfer sent", `${ethers.formatUnits(result.transferSent, decimals)} ${symbol}`],
      ["Transfer received", `${ethers.formatUnits(result.transferReceived, decimals)} ${symbol}`],
      ["Transfer tax", `${(result.transferTaxBps / 100).toFixed(2)}% (${result.transferTaxBps} bps)`],
    ]);
    console.log();
  }

  // Summary table
  if (results.length > 1) {
    console.log("═══════════════════════════════════════════════════════");
    console.log("  Summary");
    console.log("═══════════════════════════════════════════════════════\n");

    const rows = results.map(r => [
      r.symbol,
      r.error ? "ERROR" : `${(r.buyTaxBps / 100).toFixed(2)}%`,
      r.error ? "ERROR" : `${(r.transferTaxBps / 100).toFixed(2)}%`,
      r.error ? r.error.slice(0, 40) : (r.buyTaxBps > 0 || r.transferTaxBps > 0 ? "⚠ HAS TAX" : "✓ NO TAX"),
    ]);

    printTable(["Token", "Buy Tax", "Transfer Tax", "Status"], rows);
  }
}
