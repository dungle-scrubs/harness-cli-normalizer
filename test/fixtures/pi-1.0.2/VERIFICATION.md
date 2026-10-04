# Pi 1.0.2 verification

Verified on 2026-10-04 with `openai-codex/gpt-6.1-sol`. The current descriptor anchor is Pi 1.0.2 from `@earendil-works/pi-coding-agent`.

Fresh `SMOKE_HARNESS=pi` capability and question suites passed 7/7 and 1/1. Each suite used its own synthetic cwd and capture directory. This directory contains only status and provenance snapshots. Historical native recordings remain in their original version directories.

The official 1.0.1 to 1.0.2 source comparison covered the coding-agent package and all six coupled packages. Every one of the 622 installed JavaScript files matched the corresponding official 1.0.2 npm bytes. The unbundled runtime changes are model configuration/composition and per-thinking-level sampling in the shared helper and three OpenAI-compatible adapters. Bundle inspection also found 16 changed NVIDIA/OpenRouter catalog entries. The primary OpenAI Codex catalog and implementation remain unchanged.

Actual installed native configuration, composition and sampling/API functions passed 71 bounded assertions. Four successful HCN CLI turns with a synthetic provider/fetch verified high, off, max and medium effort forwarding and effective sampling parameters. Installed bundled ModelRuntime matched all 16 changed catalog entries with in-memory credentials and no network. API payload tests deliberately stopped before transport; they do not qualify remote providers or authentication.

Focused regressions passed 803 tests in each of Vitest and Bun across 71 files. Scoped Biome and typecheck passed. The parent owns the combined full gate and hcn skill checks.

All 51 major-release contracts are accounted for in the qualification report. Nine rows have fresh 1.0.2 evidence; the others retain actual-version historical evidence with unchanged-source comparisons and focused deterministic checks where covered. Previous compaction, marker-recall, malformed-result, incoming-overflow, single-large-image memory, OAuth and TUI limitations remain unchanged. No alternate-provider, real OAuth sign-in, terminal/browser rendering, lossless recall or calibrated full-capacity claim is added.
