# Auto-enable new gateways Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan inline. Track completed steps with checkboxes.

**Goal:** Automatically enable newly available providers without undoing existing manual model choices.
**Architecture:** Persist the profile's known providers, serialize discovery and manual saves with the host's file lock, and synchronize native enabledModels. Share one synchronizer between both commands and session lifecycle hooks.
**Tech Stack:** TypeScript, Bun, oh-my-pi 18.15 native settings, extension runner, managed timers and file locks.
**Spec:** docs/superpowers/specs/2026-11-03-auto-enable-gateways-design.md

## Global Constraints

- Preserve full provider/model identity and native settings precedence. Empty enabledModels continues to mean all models.
- First run records the existing catalog; subsequent new providers are enabled once. Existing providers' new models remain manual.
- No prompt copying, host patches, native startup display changes, paid requests, or publication of profile data.
- Reuse the dedicated plugin checkout on a temporary branch. Publishing and local installation have already been approved.
- Use real OMP loader/settings/matcher tests and a loopback CLI smoke check. Only publish after verification.

## Review Focus

- Concurrent sessions and stale open pickers must not silently lose auto-added gateways or restore deselected models.
- First-run migration, offline/reappearing providers, configuration overlays and path-scoped arrays must preserve the user's intent.
- Timer callbacks must use the correct profile/settings context, stop on teardown and never write during a busy turn or from subagents.
- A failed state/config write must be recoverable without broadening the existing model selection.

### Task 1: Discovery and command integration

**Files:** add src/gateway-sync.ts; edit src/index.ts, src/allowlist.ts, src/append-system.ts, tests/plugins.test.ts, package.json.
**Interfaces:** createGatewaySync() returns sync(ctx) and save(keys, ctx, snapshot?) methods. Native settings and the profile state file are written under one host lock; manual picker saves detect stale snapshots.

- [ ] Extend the integration harness with a mutable model catalog and session cleanup.
- [ ] Add regressions: first-run baseline; new provider auto-append; same IDs across providers; prompt-menu linkage; repeat/offline/deselect/restart; existing-provider additions; empty scope; priority; concurrent discovery/manual save; malformed state; stale picker.
- [ ] Run Bun tests against the installed host. Expected: new-gateway assertions fail against v1.1.1; baseline tests pass.
- [ ] Implement the smallest shared discovery/state coordinator and command integration that satisfies those tests. Preserve unsupported raw path conditions without rewriting them.
- [ ] Run the suite and strict type check. Expected: all pass, no secrets or unrelated files in diff.
- [ ] Commit this tested change on the task branch.

### Task 2: Lifecycle, documentation and release

**Files:** edit src/index.ts, src/gateway-sync.ts, tests/plugins.test.ts, README.md, CHANGELOG.md, package.json, .gitignore.
**Interfaces:** synchronize at session start and both command entries; managed idle polling checks only the loaded catalog, captures the live settings scope explicitly, and stops on shutdown. Version 1.2.0.

- [ ] Add and run lifecycle regressions for idle catalog additions, busy turns, child sessions and shutdown. Expected: the missing lifecycle behavior fails before implementing it.
- [ ] Integrate managed timers and startup synchronization; run the full suite and type check. Expected: all pass.
- [ ] Document first-run baseline, provider identity, manual deselection, settings precedence and profile state; bump version and ignore private state files.
- [ ] Run the actual omp.exe loopback smoke test. Expected: both commands load and model-specific prompt content is preserved.
- [ ] Commit, obtain one fresh-context whole-change review and address important findings with regression tests.
- [ ] Back up the user's config, append the specifically authorized current gateway models and initialize the known-provider baseline through native settings; verify only intended fields changed.
- [ ] Publish the verified public files to GitHub, align local main and generate the v1.2.0 source zip. Expected: remote and local trees match and the installed link reports v1.2.0.
