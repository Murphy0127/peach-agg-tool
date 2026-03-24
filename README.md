# peach-agg-tool

Peach vs OKX DEX 聚合器测试工具，同时也是 Claude Code 的 **peach** skill plugin。

## 安装

### 1. 安装 CLI 工具

```bash
npm install -g peach-agg-tool
```

### 2. 注册为 Claude Code Plugin

安装完成后，执行以下命令将 plugin 注册到 Claude Code：

```bash
# 创建 symlink
mkdir -p ~/.claude/plugins/cache/npm/peach
ln -sfn "$(npm root -g)/peach-agg-tool" ~/.claude/plugins/cache/npm/peach/current

# 注册到 installed_plugins.json（追加 peach@npm 条目）
# 如果你的 installed_plugins.json 尚无 peach@npm，手动添加：
node -e "
const fs = require('fs');
const p = require('os').homedir() + '/.claude/plugins/installed_plugins.json';
const j = JSON.parse(fs.readFileSync(p, 'utf-8'));
j.plugins['peach@npm'] = [{
  scope: 'user',
  installPath: require('os').homedir() + '/.claude/plugins/cache/npm/peach/current',
  version: require(require('path').join(require('child_process').execSync('npm root -g').toString().trim(), 'peach-agg-tool', 'package.json')).version,
  installedAt: new Date().toISOString(),
  lastUpdated: new Date().toISOString()
}];
fs.writeFileSync(p, JSON.stringify(j, null, 2));
console.log('Registered peach@npm plugin');
"

# 启用 plugin（追加到 settings.json 的 enabledPlugins）
node -e "
const fs = require('fs');
const p = require('os').homedir() + '/.claude/settings.json';
const j = JSON.parse(fs.readFileSync(p, 'utf-8'));
j.enabledPlugins = j.enabledPlugins || {};
j.enabledPlugins['peach@npm'] = true;
fs.writeFileSync(p, JSON.stringify(j, null, 2));
console.log('Enabled peach@npm plugin');
"
```

重启 Claude Code 或在会话中执行 `/reload-plugins` 即可使用。

### 3. 配置 OKX 凭证

```bash
# 复制模板
cp "$(npm root -g)/peach-agg-tool/skills/peach/.env.example" \
   "$(npm root -g)/peach-agg-tool/skills/peach/.env"

# 编辑填入你的 OKX API 凭证
vim "$(npm root -g)/peach-agg-tool/skills/peach/.env"
```

不配置 OKX 凭证也可以使用 Peach-only 功能（`--agg peach`、`debug`、`analyze`）。

## 更新

```bash
# 更新 CLI + plugin（symlink 自动指向新版本）
npm update -g peach-agg-tool

# 在 Claude Code 中重新加载
/reload-plugins
```

> 因为 symlink 指向 npm 全局安装路径，更新 npm 包后 plugin 自动生效，无需重新注册。

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
