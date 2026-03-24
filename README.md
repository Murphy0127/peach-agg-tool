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

## 卸载

```bash
# 移除 npm 包
npm uninstall -g peach-agg-tool

# 移除 plugin 注册
rm -rf ~/.claude/plugins/cache/npm/peach
# 然后从 ~/.claude/settings.json 和 ~/.claude/plugins/installed_plugins.json 中删除 peach@npm 条目
```
