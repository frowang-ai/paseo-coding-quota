# Paseo Coding Quota

A Paseo plugin that shows coding-plan usage for **Kimi**, **GLM**, and **Codex (ChatGPT)** in one dashboard.

It is designed for developers who use more than one coding subscription and want to see the remaining quota and reset time without switching between provider dashboards.

> **Security note:** Paseo plugins are trusted, unsandboxed code. API keys are stored as plain JSON in the local Paseo daemon's plugin-settings directory. Only install this plugin on a daemon you trust, and never commit keys or paste them into issues, logs, or pull requests.

## Features

- Kimi Coding Plan
  - Multiple subscriptions/accounts
  - Rolling 5-hour window
  - Weekly window
  - Booster wallet balance
- GLM Coding Plan
  - Multiple subscriptions/accounts
  - 5-hour token window
  - Weekly token window
  - Monthly tool-call quota
- Codex (ChatGPT)
  - Reads the existing Codex CLI OAuth credentials from `~/.codex/auth.json`
  - Honors `CODEX_HOME`
  - Shows all windows returned by the account, including 5-hour and weekly windows when available
  - Shows plan, account email, and credits when reported by the API
- Automatic refresh every 60 seconds
- A manual refresh action
- 30-second server-side cache with single-flight requests
- Theme-aware React Native UI for Paseo desktop, web, and mobile clients
- No provider API keys are sent to a third-party service

## Installation

### Install from a local directory

```bash
npm install
npm run typecheck
paseo plugin install /absolute/path/to/paseo-coding-quota
```

On Windows, for example:

```powershell
paseo plugin install F:\codeF\llm_projects\paseo-extension\paseo-coding-quota
```

### Install from GitHub

After this project is published to GitHub:

```bash
paseo plugin install github:<your-github-user>/paseo-coding-quota
```

Because the plugin has a runtime dependency (`undici`), Git installation uses the preparation command in `paseo-plugin.json` to run `npm ci --omit=dev` on the daemon host.

## Configuration

Open **Settings → Plugins → paseo-coding-quota → Coding Quota**.

### Kimi

Add one entry per account. Give each entry a label such as `Kimi 699` or `Kimi 199`, then paste the corresponding API key.

### GLM

Add one entry per account in the same way. The current settings schema stores GLM subscriptions as an array, just like Kimi subscriptions.

### Codex

Enable or disable Codex usage display. When enabled, the plugin reads the credentials that the Codex CLI already stores locally. It does not refresh OAuth tokens; if the token is rejected, run Codex once so the official CLI can refresh its own credential.

## Configuration storage

Paseo stores the host-scoped settings at a path similar to:

```text
~/.paseo/plugin-settings/paseo-coding-quota/coding-quota.json
```

On Windows, this is normally:

```text
C:\Users\<username>\.paseo\plugin-settings\paseo-coding-quota\coding-quota.json
```

The file contains provider labels and API keys in plain JSON. An agent can configure the plugin by editing this file, but it must preserve the schema and should reload the plugin afterward:

```bash
paseo plugin reload paseo-coding-quota
```

The settings schema is versioned. The plugin automatically migrates the previous single-`glmKey` format to the current multi-account `glm` array.

## Data sources

The plugin calls the provider endpoints directly from the Paseo daemon:

- Kimi: `GET https://api.kimi.com/coding/v1/usages`
- GLM: `GET https://open.bigmodel.cn/api/monitor/usage/quota/limit`
- Codex: `GET https://chatgpt.com/backend-api/wham/usage`

Codex requests use the system proxy when one is configured through `HTTPS_PROXY`, `ALL_PROXY`, or the Windows Internet Settings proxy. Kimi and GLM requests are sent directly.

The response adapters are intentionally defensive: provider response fields are mapped into a small internal schema, and failed accounts are shown independently instead of hiding the other accounts.

## Development

```bash
npm install
npm run typecheck
npm test
paseo plugin reload paseo-coding-quota
paseo plugin logs paseo-coding-quota
```

The tests cover the response mapping for all three providers using fixtures based on real response shapes. Do not add real credentials to tests or fixtures.

## Project layout

```text
paseo-coding-quota/
├── client/       # React Native surfaces and settings UI
├── server/       # Provider requests, filesystem access, and RPC handler
├── shared/       # RPC contract and settings schema
├── index.client.tsx
├── index.server.ts
└── paseo-plugin.json
```

## Compatibility

- Paseo SDK: `>=0.10.0`
- The plugin uses the runtime-entry format (`index.client.tsx` and `index.server.ts`).
- Paseo supplies React, React Native, Zod, and the plugin SDK at runtime.

## License

MIT
