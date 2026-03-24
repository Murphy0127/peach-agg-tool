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

## Logs

All output logs are written to `/tmp/aggregator/`:
- `quote-*.log` — single quote results
- `compare-*.jsonl` — comparison round data
- `compare-stats-*.json` — running statistics
- `okx-dex-stats.json` — DEX distribution data
