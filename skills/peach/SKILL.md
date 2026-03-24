---
name: peach
description: Peach DEX aggregator testing and comparison tool for BSC. Use when the user wants to compare swap quotes, benchmark aggregator performance, analyze DEX routing, or check token prices on BSC.
---

# Peach Aggregator Tool

CLI tool for testing and comparing DEX aggregator quotes on BSC (Peach vs OKX).

Install: `npm install -g peach-agg-tool` or use directly via `npx peach-agg-tool`.

## OKX Credentials

OKX API credentials are configured in `${CLAUDE_SKILL_DIR}/.env`. If the file does not exist, copy the template:
```bash
cp ${CLAUDE_SKILL_DIR}/.env.example ${CLAUDE_SKILL_DIR}/.env
```

Then fill in the credentials:
```
OKX_API_KEY="..."
OKX_SECRET_KEY="..."
OKX_PASSPHRASE="..."
OKX_PROJECT_ID="..."
```

**IMPORTANT**: When running any command that needs OKX (quote, compare, dex-stats), always pass the env file:
```bash
npx peach-agg-tool --env-file ${CLAUDE_SKILL_DIR}/.env <command> [options]
```

Without OKX credentials, only `--agg peach` and `analyze`/`fetch-tokens` commands will work.

If `${CLAUDE_SKILL_DIR}/.env` does not exist and the user wants to use OKX, remind them to set up credentials first.

## Peach Debug API Credentials

The `debug` command uses Peach aggregator's debug API endpoints which require Bearer token authentication. Set the token via environment variable:

```
PEACH_DEBUG_TOKEN="..."
```

Add it to `${CLAUDE_SKILL_DIR}/.env` alongside OKX credentials, or set it in the shell environment.

**Without `PEACH_DEBUG_TOKEN`**, the `debug` command will still run quotes and on-chain comparisons, but pool inspection (memory state, Redis comparison, single-pool swap simulation) will return empty results.

## Commands

### quote - Single pair quote comparison

```bash
npx peach-agg-tool quote <from> <to> <amount> [options]
```

Queries one or both aggregators, displays quoted output amounts, swap routes, and simulates execution via `eth_call`.

**Key options:**
- `--agg <peach|okx|all>` — which aggregator (default: all)
- `--slippage <bps>` — slippage tolerance in basis points (default: 50 = 0.5%)
- `--rpc <url>` — BSC RPC endpoint
- `--api <url>` — Peach API URL
- `--depth <n>` — Peach route search depth (default: 3)
- `--split <n>` — Peach split count (default: 5)
- `--dex-ids <ids>` — OKX DEX IDs filter

**Examples:**
```bash
npx peach-agg-tool --env-file ${CLAUDE_SKILL_DIR}/.env quote BNB USDT 1.0
npx peach-agg-tool quote USDT BNB 100 --agg peach
npx peach-agg-tool --env-file ${CLAUDE_SKILL_DIR}/.env quote BNB USDT 0.1 --depth 5 --split 10
```

### compare - Continuous benchmarking

```bash
npx peach-agg-tool compare [options]
```

Runs multiple rounds with random token pairs and trade sizes, comparing both aggregators and collecting statistics.

**Key options:**
- `--duration <min>` — run duration in minutes (default: 60)
- `--interval <sec>` — seconds between rounds (default: 10)
- `--min-usd <n>` / `--max-usd <n>` — trade size range in USD
- `--no-sim` — skip eth_call simulation (faster)
- `--out <dir>` — output directory (default: /tmp/aggregator)

**Examples:**
```bash
npx peach-agg-tool --env-file ${CLAUDE_SKILL_DIR}/.env compare --duration 30 --min-usd 1000 --max-usd 100000
npx peach-agg-tool --env-file ${CLAUDE_SKILL_DIR}/.env compare --no-sim --duration 10
```

Output: JSONL log at `/tmp/aggregator/compare-<timestamp>.jsonl`

### dex-stats - OKX DEX usage distribution

```bash
npx peach-agg-tool dex-stats [options]
```

Collects which DEXes OKX routes through, with volume distribution.

**Options:** Same as compare (`--duration`, `--interval`, `--min-usd`, `--max-usd`, `--out`).

### analyze - Analyze comparison logs

```bash
npx peach-agg-tool analyze <log.jsonl>
```

Analyzes a JSONL log file from `compare` and outputs:
- Quote win rates (Peach vs OKX)
- Simulation success rates and deviation
- Breakdown by trade size
- Missing DEXes (ones OKX uses that Peach doesn't)
- Worst-performing token pairs for Peach

### debug - Diagnose simulation failures

```bash
npx peach-agg-tool debug <from> <to> <amount> [options]
```

Runs a Peach quote and, if simulation fails (or with `--force`), inspects every pool in the route via the aggregator's debug API (`/agg/debug/pool`). Reports:
- Pool state: liquidity, reserves, prices, tick data
- Honeypot detection flags
- Per-token buy/sell tax rates (bps)
- Edge max_amount_out (zero = broken path)
- Optionally compares in-memory vs Redis data (`--check-redis`) to detect sync issues

**Requires**: `PEACH_DEBUG_TOKEN` environment variable for debug API access.

**Key options:**
- `--check-redis` — also query `/agg/debug/pool/redis` and compare with memory
- `--no-onchain` — skip on-chain comparison (faster, only check Peach internal state)
- `--force` — show pool debug even if simulation succeeds
- `--api <url>` — Peach API URL (must point to aggregator with debug endpoints)
- Other options same as `quote` (--rpc, --slippage, --depth, --split, --providers)

**Examples:**
```bash
npx peach-agg-tool debug BNB USDT 1.0
npx peach-agg-tool debug USDT BNB 100 --check-redis --force
npx peach-agg-tool debug 0x... 0x... 1000000000000000000 --api http://localhost:8080
```

**Diagnosis output includes:**
- Per-pool: provider, token pair, fee, liquidity, prices, edges, issues found
- **Peach vs On-chain diff table**: compares sqrtPriceX96/tick/liquidity (V3), reserve0/reserve1 (V2), baseReserve/quoteReserve (DODO) with live chain data
- Fields marked `⚠ STALE` indicate Peach cached data is out of date vs on-chain
- Summary: which pools have problems and likely root cause
- Common failure causes: honeypot tokens, zero liquidity, stale data, tick mismatch, Redis sync issues

### hop-sim - Per-hop on-chain simulation analysis

```bash
npx peach-agg-tool hop-sim <from> <to> <amount> [options]
```

Two-layer per-hop analysis:
1. **Per-hop pool simulation** (V2 reserve math, V3 QuoterV2, DODO querySell) — tests pool data accuracy
2. **Full route eth_call** via SDK Router contract — shows actual output including transfer tax
3. **SDK findFailingStep** — pinpoints which step causes the revert

By comparing pool math (no tax) vs actual Router simulation (with tax), instantly reveals
whether the issue is stale pool data or transfer tax on intermediate tokens.

**Key options:**
- `--threshold <bps>` — deviation alert threshold (default: 50 = 0.5%)
- Other options same as `debug` (--rpc, --api, --depth, --split)

**Examples:**
```bash
npx peach-agg-tool hop-sim BNB USDT 1.0
npx peach-agg-tool hop-sim BNB USDT 1.0 --threshold 10
```

**Output includes:**
- Per-hop comparison table: Peach Out vs On-chain Out, deviation %, status
- Full route simulation result via Router contract (actual output with tax)
- findFailingStep: which specific step causes the revert
- Diagnosis: cross-layer comparison → stale data / transfer tax / both

### tax-check - Detect token transfer tax

```bash
npx peach-agg-tool tax-check <token> [token2 ...] [options]
```

Detects token transfer tax via pure on-chain simulation — completely independent of Peach.
Deploys a helper contract via `eth_call` that buys the token through PancakeV2 Router (FeeOnTransfer variant),
compares `getAmountsOut` (expected, no tax) vs actual `balanceOf` (received), then transfers half to measure transfer tax.

**Key options:**
- `--rpc <url>` — BSC RPC endpoint
- `--amount <bnb>` — BNB amount for test swap (default: 0.01)

**Examples:**
```bash
npx peach-agg-tool tax-check VIN LTC CAKE
npx peach-agg-tool tax-check 0x85E43bF8faAF04ceDdcD03d6C07438b72606a988 --amount 0.1
```

**Output includes:**
- Buy tax: `getAmountsOut` expected vs actual received (buy from PancakeV2 pool)
- Transfer tax: amount sent vs amount received by target address
- Tax rates in basis points and percentage
- Summary table when checking multiple tokens

**When to use:**
- After `debug` shows "No pool-level issues" but simulation still fails — check if intermediate tokens have hidden tax
- When Peach quote is significantly higher than simulation result
- To verify whether a token is safe to route through as an intermediate hop

### fetch-tokens - Refresh token data

```bash
npx peach-agg-tool fetch-tokens [--top 100] [--pages 8]
```

Fetches BSC top traded tokens from GeckoTerminal and updates the bundled token database.

## Token Resolution

Tokens can be specified by symbol (case-insensitive) or `0x` address:
- Symbols: BNB, WBNB, USDT, USDC, ETH, BTCB, CAKE, and ~100 more
- Run `npx peach-agg-tool fetch-tokens` to refresh the token list

## Interpreting Output

**Quote comparison table:**
- `vs Best` — percentage difference from the best quote (negative = worse)
- `Sim Out` — actual execution result via eth_call simulation
- `Sim Best` — sim result vs best simulation

**Compare stats:**
- `Q:OKX/Q:PCH` — quote winner for each round
- `S:OKX/S:PCH` — simulation winner
- Win rate, deviation, and error rates are shown every 10 rounds

**Key metrics to watch:**
- Sim deviation > 1% may indicate stale quotes or on-chain conditions changed
- Sim FAILED usually means insufficient liquidity or token transfer restrictions
- Missing DEXes shows where Peach could improve by adding new liquidity sources

## Common Workflows

1. **Quick price check**: `npx peach-agg-tool --env-file ${CLAUDE_SKILL_DIR}/.env quote BNB USDT 1.0`
2. **Peach-only** (no OKX creds needed): `npx peach-agg-tool quote BNB USDT 10 --agg peach --depth 5 --split 10`
3. **Short benchmark**: `npx peach-agg-tool --env-file ${CLAUDE_SKILL_DIR}/.env compare --duration 5 --interval 5`
4. **Analyze results**: Find latest log in `/tmp/aggregator/` and run `npx peach-agg-tool analyze <file>`
5. **Check DEX coverage**: `npx peach-agg-tool --env-file ${CLAUDE_SKILL_DIR}/.env dex-stats --duration 10`
6. **Debug sim failure** (4-step workflow):
   - `hop-sim BNB USDT 1.0` → locate which hop deviates
   - `debug BNB USDT 1.0 --check-redis --force` → compare memory/Redis/on-chain data
   - Use `/agg/debug/pool/swap` API to reproduce single-hop calculation
   - `tax-check <intermediate_tokens>` → verify token transfer tax
7. **Inspect pools even on success**: `npx peach-agg-tool debug BNB USDT 1.0 --force`
8. **Check token tax**: `npx peach-agg-tool tax-check VIN CAKE`

### Systematic debugging workflow

When a Peach quote has simulation failure or significant quote-vs-sim deviation, follow this 4-step process:

#### Step 1: Locate — which hop deviates?

Run `hop-sim` to do per-hop on-chain simulation, plus use the aggregator's `/agg/debug/pool/swap` API to simulate each hop with the aggregator's own math:

```bash
npx peach-agg-tool hop-sim <from> <to> <amount>
```

For each hop, compare three numbers:
- **Quote amount_out**: what the routing engine calculated (from the route response)
- **Aggregator pool/swap**: what the aggregator calculates with current in-memory data (`/agg/debug/pool/swap`)
- **On-chain simulation**: what actually happens on-chain (eth_call via RPC)

| Quote ≠ pool/swap | Routing engine logic issue (split accumulation, DP cache, etc.) |
|---|---|
| **pool/swap ≠ on-chain** | **Aggregator data stale vs chain** |
| **All match, but full sim fails** | **Token transfer tax or router contract issue** |

#### Step 2: Compare — is the data stale?

For each problematic hop identified in Step 1, compare three data layers:

```bash
npx peach-agg-tool debug <from> <to> <amount> --check-redis --force
```

This queries:
- `/agg/debug/pool` — aggregator in-memory state (reserves, sqrtPrice, tick, liquidity)
- `/agg/debug/pool/redis` — Redis cache state (check for memory↔Redis drift)
- On-chain RPC — live chain state (getReserves, slot0, liquidity)

Also check `/agg/debug/pool/version` for `last_update_time` to directly assess data freshness.

#### Step 3: Reproduce — single-pool swap simulation

Use `/agg/debug/pool/swap` to reproduce the exact calculation the aggregator would do for the problematic hop:

```
GET /agg/debug/pool/swap?pool_id=<addr>&provider=<name>&token_in=<addr>&token_out=<addr>&amount=<raw_amount>
```

Compare the returned `amount_out` with:
- The quote's per-hop amount_out (from Step 1)
- The on-chain simulation result

This isolates whether the issue is in the pool math itself or in the routing/split logic.

#### Step 4: Diagnose — token tax or aggregator bug?

If data is fresh but simulation still fails:

1. **Check token info** from aggregator cache: query `/agg/debug/token` or `/agg/debug/tokens` for all intermediate tokens in the route to see cached tax/honeypot flags
2. **On-chain tax detection**: run `tax-check` for tokens the aggregator reports as tax-free but that show simulation deviation:
   ```bash
   npx peach-agg-tool tax-check <intermediate_token_1> <intermediate_token_2> ...
   ```
3. If on-chain tax is confirmed but aggregator cache shows 0 → aggregator's token info is stale
4. If no tax found → likely an aggregator calculation bug, check the specific pool provider's swap math

### Peach Debug API Reference

All debug endpoints require `PEACH_DEBUG_TOKEN` and use base URL from `--api` (default: `https://api.cipheron.org`).

| Endpoint | Purpose | Key Parameters |
|----------|---------|---------------|
| `GET /agg/debug/pool` | Pool in-memory state + graph edges | `pool_id`, `provider` (opt) |
| `GET /agg/debug/pool/redis` | Raw Redis cache data | `pool_id`, `provider` |
| `GET /agg/debug/pool/swap` | Single-pool swap simulation | `pool_id`, `provider`, `token_in`, `token_out`, `amount` |
| `GET /agg/debug/pool/version` | Pool cache version & freshness | `pool_id`, `provider` |
| `GET /agg/debug/pool/ticks` | V3/Thena tick data (hex BCS) | `pool_id`, `provider` |
| `GET /agg/debug/token` | Token tax/honeypot info | `address` |
| `GET /agg/debug/tokens` | Batch token info | `addresses` (comma-separated) |
| `GET /agg/debug/route/refresh` | Force graph rebuild for pair | `from`, `target`, `depth` (opt) |

## Logs

All output logs are written to `/tmp/aggregator/`:
- `quote-*.log` — single quote results
- `compare-*.jsonl` — comparison round data
- `compare-stats-*.json` — running statistics
- `okx-dex-stats.json` — DEX distribution data
