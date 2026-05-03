# 快速开始：本地图表 Agent 工作台

## 安装依赖

```bash
cd /Users/zhongyuanzhang/priceViewer
source .venv/bin/activate
pip install -r requirements.txt
npm install
```

## 配置数据源

Bitget 公共行情不需要 API key。Alpaca 美股 / ETF 需要环境变量：

```bash
export APCA_API_KEY_ID="你的 Alpaca Key"
export APCA_API_SECRET_KEY="你的 Alpaca Secret"
export APCA_API_BASE_URL="https://paper-api.alpaca.markets"
```

Agent provider 当前默认使用 Codex adapter。优先读取本机 Codex CLI 登录态：

```text
$CODEX_HOME/auth.json；未设置 CODEX_HOME 时读取 ~/.codex/auth.json
```

也可以临时用环境变量提供 token：

```bash
export TERMINAL_TICKER_CODEX_API_KEY="你的 Codex access token"
```

## 运行测试

```bash
.venv/bin/python -m unittest discover -s tests
npm run build
```

## 本地开发运行

终端 1：

```bash
.venv/bin/python -m terminal_ticker --host 127.0.0.1 --port 8765
```

终端 2：

```bash
npm run dev
```

打开：

```text
http://127.0.0.1:5173
```

本机代理环境可能干扰 `localhost` 请求，排查 API 时优先使用：

```bash
curl --noproxy '*' http://127.0.0.1:8765/api/state
```

## 静态构建运行

```bash
npm run build
.venv/bin/python -m terminal_ticker --host 127.0.0.1 --port 8765
```

打开：

```text
http://127.0.0.1:8765
```

## 预期行为

- 浏览器页面直接进入行情工作台，不出现营销页。
- 左侧展示按 `watchlist.toml` 分组的 Bitget 和 Alpaca 标的。
- 选中标的后，中间 K 线图和本地策略信号同步更新。
- 右侧 Chart Session 展示当前标的 active session、最近消息和 Agent 输出。
- 连续提问会复用该标的 active session，并把最近历史带给 provider。
- 点击 reset 会开启干净会话，但不会删除旧历史。
- Codex 只作为 provider adapter 出现在配置和凭证说明里，用户入口仍是 Agent。
- Longbridge 不再是主路径；旧代码未清理前只作为 legacy 兼容。
