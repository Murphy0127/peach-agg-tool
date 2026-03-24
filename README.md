# peach-agg-tool

Peach vs OKX DEX 聚合器测试工具，同时也是 Claude Code 的 **peach** skill plugin。

## 安装

### 1. 安装并注册 Plugin

```bash
# 安装 CLI 工具
npm install -g peach-agg-tool

# 一键注册为 Claude Code Plugin（创建 symlink + 注册 + 启用）
INSTALL_PATH="$(npm root -g)/peach-agg-tool"
mkdir -p ~/.claude/plugins/cache/npm/peach
ln -sfn "$INSTALL_PATH" ~/.claude/plugins/cache/npm/peach/current
node -e "
const fs = require('fs'), os = require('os'), path = require('path');
const home = os.homedir();
const installPath = home + '/.claude/plugins/cache/npm/peach/current';
const ver = require(path.join('$INSTALL_PATH', 'package.json')).version;

// 注册 plugin
const ip = home + '/.claude/plugins/installed_plugins.json';
const ij = JSON.parse(fs.readFileSync(ip, 'utf-8'));
ij.plugins['peach@npm'] = [{ scope: 'user', installPath, version: ver, installedAt: new Date().toISOString(), lastUpdated: new Date().toISOString() }];
fs.writeFileSync(ip, JSON.stringify(ij, null, 2));

// 启用 plugin
const sp = home + '/.claude/settings.json';
const sj = JSON.parse(fs.readFileSync(sp, 'utf-8'));
sj.enabledPlugins = sj.enabledPlugins || {};
sj.enabledPlugins['peach@npm'] = true;
fs.writeFileSync(sp, JSON.stringify(sj, null, 2));

console.log('peach@npm v' + ver + ' registered and enabled');
"
```

重启 Claude Code 或在会话中执行 `/reload-plugins` 即可使用。

### 2. 配置 OKX 凭证（可选）

```bash
cp "$(npm root -g)/peach-agg-tool/skills/peach/.env.example" \
   "$(npm root -g)/peach-agg-tool/skills/peach/.env"
vim "$(npm root -g)/peach-agg-tool/skills/peach/.env"
```

不配置 OKX 凭证也可以使用 Peach-only 功能（`--agg peach`、`debug`、`analyze`）。

## 更新

```bash
npm update -g peach-agg-tool && /reload-plugins
```

> symlink 指向 npm 全局安装路径，更新后 plugin 自动生效，无需重新注册。

## 使用

### CLI 直接使用

```bash
# 查看帮助
npx peach-agg-tool -h

# 单次报价对比（Peach vs OKX）
npx peach-agg-tool quote BNB USDT 1.0

# 仅 Peach 报价
npx peach-agg-tool quote USDT BNB 100 --agg peach

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
| `quote <from> <to> <amount>` | 单次报价对比 + 模拟交易 |
| `compare` | 持续多轮随机对比 |
| `debug <from> <to> <amount>` | 诊断模拟失败（Peach 内存 + 链上比对） |
| `hop-sim <from> <to> <amount>` | 逐跳链上模拟对比，定位报价偏差 |
| `tax-check <token> [token2 ...]` | 纯链上检测 token 转账税（不依赖 Peach） |
| `dex-stats` | OKX DEX 使用分布统计 |
| `analyze <log.jsonl>` | 分析 compare 日志 |
| `fetch-tokens` | 刷新 BSC token 数据 |

### debug 命令详细

`debug` 命令执行 4 步诊断：

1. 执行 Peach quote + simulation
2. 拉取聚合器内存中的 pool 数据（`/router/pool_debug`）
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

**推荐排查流程：**

```
hop-sim --full-sim  →  定位哪个 hop 有偏差
    ↓ 所有 hop 正常但 full sim 失败
tax-check <中间代币>  →  确认 transfer tax
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
quote (模拟失败) → debug (pool 正常) → tax-check (发现中间 token 有税)
```

## 卸载

```bash
# 移除 npm 包
npm uninstall -g peach-agg-tool

# 移除 plugin 注册
rm -rf ~/.claude/plugins/cache/npm/peach
# 然后从 ~/.claude/settings.json 和 ~/.claude/plugins/installed_plugins.json 中删除 peach@npm 条目
```
