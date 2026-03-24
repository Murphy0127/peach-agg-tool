# peach-agg-tool

Peach vs OKX DEX 聚合器测试工具，同时也是 Claude Code 的 **peach** skill plugin。

## 安装

### 1. 作为 Claude Code Plugin 安装（推荐）

```bash
# 添加 marketplace
claude plugin marketplace add Murphy0127/peach-agg-tool

# 安装 plugin
claude plugin install peach@peach-agg-tool
```

重启 Claude Code 或在会话中执行 `/reload-plugins` 即可使用。

### 2. 仅作为 CLI 工具安装

```bash
npm install -g peach-agg-tool
```

### 3. 配置凭证（可选）

Plugin 安装后，在 skill 目录下创建 `.env` 文件：

```bash
# 找到 plugin 的 skill 目录（plugin 安装后 Claude 会自动解析 ${CLAUDE_SKILL_DIR}）
# 也可以在 ~/.okx/.env 放置凭证，工具会自动搜索
cp skills/peach/.env.example skills/peach/.env
vim skills/peach/.env
```

`.env` 支持的变量：

| 变量 | 用途 | 必须？ |
|------|------|--------|
| `OKX_API_KEY` / `OKX_SECRET_KEY` / `OKX_PASSPHRASE` / `OKX_PROJECT_ID` | OKX 聚合器对比 | `--agg all` 时需要 |
| `PEACH_DEBUG_TOKEN` | Peach debug API 认证 | `debug` 命令的池子检查需要 |

不配置 OKX 凭证也可以使用 Peach-only 功能（`--agg peach`、`debug`、`analyze`）。
不配置 `PEACH_DEBUG_TOKEN` 也能跑 debug，但无法查看聚合器内存/Redis 池子数据。

## 更新

Plugin 通过 GitHub 安装后：
```bash
claude plugin update peach@peach-agg-tool
```
或在会话中执行 `/reload-plugins` 自动拉取最新版本。

CLI 工具通过 npm 安装的：
```bash
npm update -g peach-agg-tool
```

## 使用

### CLI 直接使用

```bash
# 查看帮助
npx peach-agg-tool -h

# 单次 Peach 报价
npx peach-agg-tool quote BNB USDT 1.0

# Peach vs OKX 对比
npx peach-agg-tool quote BNB USDT 1.0 --agg all

# 持续对比跑 30 分钟
npx peach-agg-tool compare --duration 30 --min-usd 1000

# 诊断模拟失败（含链上数据比对）
npx peach-agg-tool debug BNB USDT 1.0
npx peach-agg-tool debug USDT BNB 100 --check-redis --force

# 分析日志
npx peach-agg-tool analyze /tmp/aggregator/compare-xxx.jsonl

# OKX DEX 分布统计
npx peach-agg-tool dex-stats --duration 10

# 逐跳模拟分析（定位报价偏差）
npx peach-agg-tool hop-sim BNB USDT 1.0 --full-sim

# 检测 token 转账税
npx peach-agg-tool tax-check VIN LTC CAKE

# 刷新 token 数据
npx peach-agg-tool fetch-tokens
```

### 作为 Claude Code Skill 使用

安装 plugin 后，Claude 会自动识别聚合器相关的请求。你可以直接用自然语言：

- "帮我比较一下 BNB 换 USDT 1 个的报价"
- "跑一个 10 分钟的 benchmark"
- "BNB 换 USDT 模拟失败了，帮我分析原因"
- "查看最新的 compare 日志分析结果"

或直接调用 `/peach` slash command。

## 命令参考

| 命令 | 用途 |
|------|------|
| `quote <from> <to> <amount>` | 单次报价 + 模拟（`--agg all` 对比） |
| `compare` | 持续多轮随机对比 |
| `debug <from> <to> <amount>` | 诊断模拟失败（Peach 内存 + 链上比对） |
| `hop-sim <from> <to> <amount>` | 逐跳链上模拟对比，定位报价偏差 |
| `tax-check <token> [token2 ...]` | 纯链上检测 token 转账税（不依赖 Peach） |
| `dex-stats` | OKX DEX 使用分布统计 |
| `analyze <log.jsonl>` | 分析 compare 日志 |
| `fetch-tokens` | 刷新 BSC token 数据 |

### debug 命令详细

`debug` 命令通过 Peach debug API（`/agg/debug/pool`、`/agg/debug/pool/redis`）检查池子状态，需要 `PEACH_DEBUG_TOKEN`。

执行 4 步诊断：

1. 执行 Peach quote + simulation
2. 拉取聚合器内存中的 pool 数据（`/agg/debug/pool`）
3. 通过 RPC 读取链上真实状态，逐字段比对：
   - **V3 pools**: sqrtPriceX96, tick, liquidity
   - **V2 pools**: reserve0, reserve1
   - **DODO pools**: baseReserve, quoteReserve, baseTarget, quoteTarget
4. 汇总诊断结果

数据偏差超过阈值会标记为 `⚠ STALE`，表示聚合器缓存过期。

```bash
# 基本用法（模拟失败时自动诊断）
npx peach-agg-tool debug BNB USDT 1.0

# 同时检查 Redis 数据同步
npx peach-agg-tool debug BNB USDT 1.0 --check-redis

# 即使模拟成功也检查 pool 状态
npx peach-agg-tool debug BNB USDT 1.0 --force

# 跳过链上比对（更快）
npx peach-agg-tool debug BNB USDT 1.0 --no-onchain
```

### hop-sim 命令详细

`hop-sim` 逐跳模拟 Peach 的报价路由，将每一跳的 Peach 预测输出与链上实际计算结果对比：

- **V2 pools**: 读取 `getReserves()` + 恒等积公式计算
- **V3 pools**: 调用 QuoterV2 的 `quoteExactInputSingle()` 做真实 tick 遍历
- **DODO pools**: 调用 `querySellBase()`/`querySellQuote()`

```bash
# 基本用法
npx peach-agg-tool hop-sim BNB USDT 1.0

# 同时跑完整路由模拟，自动判断是 stale data 还是 transfer tax
npx peach-agg-tool hop-sim BNB USDT 1.0 --full-sim

# 自定义偏差阈值（10 bps = 0.1%）
npx peach-agg-tool hop-sim BNB USDT 1.0 --threshold 10
```

**系统化排查流程（4 步）：**

```
1. hop-sim           →  逐跳链上模拟，定位哪个 hop 有偏差
2. debug --check-redis --force  →  比对内存/Redis/链上三层数据
3. /agg/debug/pool/swap API  →  用聚合器自身逻辑复现单跳计算
4. tax-check <中间代币>  →  确认 transfer tax 或聚合器 bug
```

### tax-check 命令详细

`tax-check` 通过纯链上模拟检测 token 的隐藏转账税，完全不依赖 Peach：

1. 通过 PancakeV2 Router 的 `swapExactETHForTokensSupportingFeeOnTransferTokens` 买入 token
2. 对比 `getAmountsOut`（无税预期）vs `balanceOf`（实际到手）→ **Buy tax**
3. 将一半 token 转给 `address(0xdead)`，对比发送量 vs 接收量 → **Transfer tax**

整个过程在单次 `eth_call` 中通过部署临时合约完成，无需消耗 gas。

```bash
# 检测单个 token
npx peach-agg-tool tax-check 0x85E43bF8faAF04ceDdcD03d6C07438b72606a988

# 批量检测
npx peach-agg-tool tax-check VIN LTC CAKE

# 用更大金额测试（防止小额豁免）
npx peach-agg-tool tax-check VIN --amount 0.1
```

**典型排查流程：**

```
quote (模拟失败) → hop-sim (定位偏差跳) → debug --check-redis (比对数据) → tax-check (排查 token 税)
```

## 卸载

```bash
# Plugin 方式安装的
claude plugin uninstall peach@peach-agg-tool
claude plugin marketplace remove peach-agg-tool

# npm 方式安装的
npm uninstall -g peach-agg-tool
```
