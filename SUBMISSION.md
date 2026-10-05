# Paseo Coding Quota — Submission Draft

## Summary

`paseo-coding-quota` is a trusted Paseo plugin that provides a unified usage dashboard for Kimi Coding Plan, GLM Coding Plan, and Codex (ChatGPT) subscriptions.

## Why it is useful

Developers who use multiple coding plans currently need to open several provider-specific pages or CLIs to check rolling windows and reset times. This plugin brings those usage reports into one Paseo surface while keeping provider credentials on the user's own daemon.

## Scope

- Direct usage queries from the daemon to provider endpoints
- Multiple Kimi and GLM accounts with independent labels and reports
- Automatic Codex CLI credential discovery
- No telemetry or third-party credential relay
- Theme-aware, React Native UI for desktop, web, and mobile
- Defensive handling of partial provider failures

## Trust and limitations

This is a trusted, unsandboxed plugin. API keys are stored in the host-scoped Paseo plugin settings JSON as plain text because the current plugin settings API is not a credential vault. Users should install it only on daemons they control and should review updates before installing them.

The provider endpoints used here are the endpoints used by the corresponding coding clients, but they are not presented as a stability guarantee by this plugin. Provider response fields may change. The plugin reports an account-level error rather than hiding other accounts when an adapter fails.

Codex OAuth refresh is intentionally delegated to the official Codex CLI. The plugin never redeems or writes the refresh token.

## Verification

- `tsc --noEmit`: passed
- `vitest run`: 7 tests passed
- Real endpoint smoke test: Kimi, GLM, and Codex responses successfully fetched on 2026-10-05; no credentials are stored in fixtures or committed to Git
- Installed locally on Paseo 0.10.3 and verified `running`

## Requested review

Please advise whether this plugin should be listed in an official Paseo community-plugin directory, and whether the maintainers prefer:

1. a separate community-plugin index repository;
2. an entry in the Paseo repository;
3. npm/GitHub discovery only; or
4. the newer `registerUsageSource()` API once the plugin targets Paseo 0.11+.
