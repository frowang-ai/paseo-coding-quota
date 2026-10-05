# paseo-coding-quota

Paseo 插件：在一个侧边栏页面里集中显示各 Coding 订阅的额度，重点是 5 小时窗口和每周窗口的剩余量与重置时间。

## 支持的服务

| 服务 | 认证方式 | 显示内容 |
| --- | --- | --- |
| Kimi Coding Plan | 设置页粘贴 API key（可加多个账号，分别显示，如 699 档 / 199 档） | 5 小时窗口、每周窗口、加速钱包余额 |
| GLM Coding Plan | 设置页粘贴 API key | 5 小时 token 窗口、每周 token 窗口、月度工具调用次数 |
| Codex (ChatGPT) | 自动读取 `~/.codex/auth.json`（尊重 `CODEX_HOME`），无需输入 | 所有用量窗口（5 小时 / 每周，按套餐自动识别）、套餐、email、credits |

## 安装与使用

```bash
npm install
npm run typecheck
paseo plugin install F:\codeF\llm_projects\paseo-coding-quota
```

1. Paseo 侧边栏会出现「Coding 额度」，或用 Ctrl+K 搜「打开 Coding 额度」。
2. 首次使用进 设置 → 插件 → paseo-coding-quota，添加 Kimi / GLM 的 key。数据每 60 秒自动刷新，也可手动点「刷新」。
3. 服务端有 30 秒缓存，多个客户端同时打开也不会连环打接口。

## 实现说明

- 三个数据源（全部为各家官方客户端使用的接口，2026-10 实测）：
  - Kimi `GET https://api.kimi.com/coding/v1/usages`
  - GLM `GET https://open.bigmodel.cn/api/monitor/usage/quota/limit`
  - Codex `GET https://chatgpt.com/backend-api/wham/usage`
- Codex 请求自动走系统代理（环境变量 `HTTPS_PROXY` 等，或 Windows 注册表 IE 代理设置）；Kimi/GLM 直连。
- Codex 的 OAuth token 过期时（401）不会自动刷新，避免和 Codex CLI 抢 refresh token：按提示在本机跑一次 `codex` 让它自己刷新即可。
- API key 保存在 daemon 侧的插件设置存储里（普通 host 端 JSON，不是加密保险库），只在你自己信任的 daemon 上使用。

## 开发

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest：三个接口的响应映射用真实结构做夹具
paseo plugin reload paseo-coding-quota
paseo plugin logs paseo-coding-quota
```
