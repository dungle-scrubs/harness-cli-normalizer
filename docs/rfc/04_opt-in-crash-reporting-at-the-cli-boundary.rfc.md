---
number: 04
title: "Opt-in Crash Reporting at the CLI Boundary"
type: feature
status: Draft
author: Kevin Frilot
date: 2026-09-14
---

# RFC-04: Opt-in Crash Reporting at the CLI Boundary

## Abstract

The published `hcn` binary crashes in the field with no aggregated evidence: an exit-1 fatal prints a stack to stderr and disappears unless a user pastes it back. This RFC specifies opt-in, crash-only Sentry capture at the CLI entry (`src/cli/index.ts`), quarantined in a single `src/cli` module, enabled only by an explicit DSN and inert without one. The library layers (`src/knowledge`, `src/interpretation`, `src/execution`) stay sink-free; consumers embedding the runner keep owning their telemetry, and an informative annex records the wiring contract for them. The payload is a fixed allowlist - scrubbed stack, version, platform, command word - and never argv, environment, or decoded child output.

## Introduction

hcn is a CLI product that normalizes four harness interfaces and supervises the runs it starts (ADR 0007). The CLI binary is its own application root: no host sits above it to own crash visibility. When it dies on a user's machine, the operator has no aggregate view - only voluntarily pasted stderr.

This RFC covers:

- An opt-in crash reporter for the `hcn` binary, wired at the CLI entry, using Sentry as the sink.
- The payload contract: what may leave the process and what MUST NOT.
- An informative annex mapping hcn's existing library seams (`FailureSummary`, boundary log, `turnId`) onto a host's own Sentry setup.

This RFC does not cover:

- Telemetry in the library layers. A Sentry client in `src/knowledge`, `src/interpretation`, or `src/execution` fails the ADR 0007 scope test (it stores and correlates across process boundaries, which belongs to the caller), double-captures when a consumer already runs Sentry, and breaks the dual-runtime invariant that all process I/O flows through injected primitives. Declined in the fit check; recorded here so it is not rebuilt.
- Forwarding child-process output, boundary-log lines, or stream events to Sentry. The supervised harness can emit secret material (terminal output from production hosts); decoded output is never a telemetry payload.
- Tracing, wide events, or breadcrumbs in v1. Crash-only.
- Any config-file surface or flag. One environment variable is the whole activation surface.

## Terminology

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT, RECOMMENDED, MAY, and OPTIONAL in this document are to be interpreted as described in RFC 2119.

- **Crash**: an unexpected exception escaping CLI dispatch - the `run()` catch path or a process-level `uncaughtException`/`unhandledRejection`. Operational outcomes (refusal exit 2, `FailureSummary` classes such as `auth` or `timeout`) are not crashes; they are hcn working as designed.
- **DSN**: Sentry Data Source Name. The URL that identifies the Sentry project an event is sent to. Here it is the sole activation switch.
- **Boundary log**: the `RunnerDeps.log` stream (`src/execution/deps.ts`) - one structured line per spawn/exit/stall, argv pre-redacted, content masked (v1 D-005). Always-on; the host decides where it goes.
- **FailureSummary**: the typed failure taxonomy (`src/execution/failure.ts`): `class`, `code`, `authKind`, `retryable`, `nativeExitCode`, `resetsAt`.
- **Sink-free**: a module that emits evidence but never delivers it anywhere - the library-layer property this RFC preserves.
- **Host / consumer**: a program that embeds the hcn runner and therefore owns telemetry for its own process.
- **Command word**: `argv[2]` as seen by dispatch (`run`, `session`, `inspect`, ...). A single word, never the full argv.

## Motivation

- Field failures are invisible: the operator learns of an exit-1 fatal only when a user volunteers the stderr. With `check-versions` showing version drift across installs, the operator cannot tell which versions crash.
- The existing seams already produce the right data for hosts; the gap is the one process with no host above it.
- The fit check (2026-09-14) settled the boundary: Sentry init goes in exactly one place - the process that owns the user relationship. For the binary, that is the CLI entry.

## Design

### Placement and quarantine

A single new module, `src/cli/crash-report.ts`, owns everything. It:

- MUST be the only module that imports a Sentry SDK.
- MUST NOT be imported by anything under `src/knowledge`, `src/interpretation`, or `src/execution`. The purity gate, chat seam gate, and dual-runtime invariant are untouched.
- MUST dynamically import the SDK only when enabled (see below). With no DSN, the SDK is never loaded and startup cost is zero.

### Activation

- The reporter is enabled if and only if the environment variable `HCN_SENTRY_DSN` is set to a syntactically valid Sentry DSN. No flag, no config row, no interactive prompt.
- Absent or malformed DSN: the reporter is a no-op and MUST NOT change any observable behavior of the CLI.
- The reporter MUST NOT alter the CLI's exit code, stdout, or stderr content in the success path. The only permitted stderr output is the single disable notice defined in Error Handling.

### Capture scope

When enabled, the reporter captures exactly two cases:

1. The `run()` catch in `src/cli/index.ts` (fatal exit 1).
2. Process-level `uncaughtException` and `unhandledRejection`, hooked only while enabled.

It MUST NOT capture operational outcomes: refusals (exit 2), any `FailureSummary`-bearing failure, or clean exits. Those already have structured representations the caller (script or human) consumes.

### Payload allowlist

The event payload is a fixed allowlist. The reporter:

- MUST attach the exception type, message, and stack, with every frame rewritten to a package-relative module path (strip the filesystem prefix up to and including the package root; keep function, basename, line, column).
- MUST attach tags: hcn version (as release), Node major version, platform, command word.
- MUST NOT attach full argv (prompts are user content and ride argv), any environment variable, `cwd`, decoded child stdout/stderr, session or transcript file contents, or boundary-log lines.

### Runtime

The published bin targets Node >= 24; the adapter uses `@sentry/node`, lazily imported. Under Bun-from-source, capture degrades to a no-op (Open Question 2).

### Annex (informative): host wiring contract

For consumers embedding the runner - no hcn code changes; this records the mapping the fit check produced:

| hcn seam | Host's Sentry |
| --- | --- |
| `FailureSummary` | capture on failure |
| `failure.class` | tag + fingerprint, so a rate-limit storm groups as one issue |
| `failure.code`, `authKind`, `nativeExitCode` | `error.code` context |
| `failure.retryable` | context attribute |
| `deps.log` boundary lines | breadcrumbs |
| `turnId` | correlation id on every capture |

A host MUST NOT forward decoded child output or raw stream events to a hosted sink; the boundary log is the scrubbed surface. This line restates the machine's privacy override, not a new rule.

## State Machine

```
DISABLED ──(HCN_SENTRY_DSN valid)──► ENABLED_INIT ──(SDK init ok)──► ARMED
DISABLED ──(DSN absent/malformed)──► DISABLED   (no observable change)
ENABLED_INIT ──(init fails)──► DISABLED_NOTICE  (one stderr line; stays disabled)
ARMED ──(crash: run() catch / uncaught)──► CAPTURED ──(send ok or fail)──► TERMINAL_EXIT
ARMED ──(normal exit, any operational outcome)──► TERMINAL_EXIT   (no capture)
```

Invalid transitions (e.g., capture while DISABLED) MUST be unreachable by construction: the hooks are installed only after successful init and torn down at exit.

## Error Handling

- **T001 - SDK init failure** (severity: warning). Recovery: reporter disables itself, writes exactly one stderr line `crash reporting disabled: <reason>`, and the CLI proceeds. The exit code MUST NOT change.
- **T002 - event send failure** (severity: info). Recovery: swallow silently. Telemetry is best-effort; a failed send MUST NOT delay or fail the CLI. The SDK's shutdown flush SHOULD be bounded (<= 2s) so it cannot stall exit.
- **T003 - scrubbing failure** (severity: warning). If a stack frame cannot be rewritten to a package-relative path, the reporter MUST drop the frame stack entirely and keep type, message, and tags. A frame that keeps an absolute path is worse than no stack.
- **T004 - capture rethrow loop** (severity: critical). An exception inside the reporter itself MUST be swallowed without recursion. Recovery: reporter disables itself for the rest of the process.

All four are transient-with-degrade: none escalates to the user beyond the single T001 notice line.

## Security Considerations

- **Trust boundary**: payloads cross from a user's machine to the operator's Sentry (SaaS or self-hosted - the spec is DSN-agnostic; the operator decision is Open Question 1). The user opts in by setting the DSN; there is no default egress.
- **Data sensitivity**: the allowlist is the control. Prompts (user content) ride argv and MUST NOT leave; environment variables (tokens, keys) MUST NOT leave; decoded child output (possible production-host terminal output - secret material under this machine's privacy override) MUST NOT leave. Stack paths are rewritten to package-relative form so usernames and directory layouts stay local.
- **Blast radius**: worst case is the allowlist itself leaking through SDK auto-context (Sentry attaches request data, process info by default). The reporter MUST configure the SDK with auto-instrumentation and default context attachment off, and pass only the allowlisted event. Verify at implementation time by inspecting the actual envelope on the wire.
- **Injection resistance**: child output never enters the payload, so a compromised or prompt-injected harness cannot exfiltrate through the reporter or poison telemetry content.
- **Permissions**: no new file access; network egress only to the DSN host, only when enabled.

## Alternatives Considered

1. **Sentry client in the library layers.** Attractive because every embedding consumer would get it for free. Rejected: fails the ADR 0007 scope test (cross-process storage is the caller's job), double-captures in hosts that already run Sentry, and a Sentry transport's own network I/O breaks the injected-primitives invariant of `src/execution`.
2. **No in-tree telemetry; hosts wire everything.** Attractive as the narrowest scope. Rejected as the sole option: the CLI binary has no host above it, so nobody would own its crash visibility. Adopted instead for the library layers, which stay sink-free.
3. **OTel SDK with Sentry as an export backend.** Attractive for future tracing. Rejected for v1: the need is crash aggregation, not spans; the OTel surface area dwarfs the payload, and nothing in this RFC's motivation needs distributed context.
4. **Local crash dumps (JSON to a cache dir, no network).** Attractive on privacy. Rejected: no aggregation across installs; each dump waits for a user to find and ship it, which is the status quo failure mode with extra steps.

## Implementation Plan

- **Phase 1 - adapter module.** `src/cli/crash-report.ts` with the allowlist, scrubbing, state machine, and an injectable capture function (default: lazy `@sentry/node`). Verify: unit tests over the injected fake cover T001-T004 and every MUST NOT in the payload section; `pnpm check` green on both lanes.
- **Phase 2 - entry wiring.** Hook `run()`'s catch and the process-level handlers in `src/cli/index.ts`. Verify: a test-only forced exception through `dispatch` produces a captured event with the allowlist payload and exit code 1 unchanged; envelope inspection confirms no argv/env leaked (Security: blast radius).
- **Go/no-go**: after Phase 2, run the binary with a real DSN for one week on the operator's own machine before publishing; any non-allowlisted field found in an envelope is a release blocker.
- **Rollback**: delete the import site in `src/cli/index.ts`; the adapter module becomes dead code and everything else is unchanged. No data migration; no compatibility surface (the env var was never documented as stable until this RFC is Accepted).

## Open Questions

1. **SaaS or self-hosted DSN?** Options: Sentry SaaS org; self-hosted Sentry. Criterion: where the operator accepts user-machine payloads landing. Decide: the operator, at deploy time. The spec is DSN-agnostic, so this does not block Draft → Accepted.
2. **Bun-runtime capture?** Options: no-op on Bun (recommended - the published bin targets Node >= 24, Bun is the dev/test lane); add `@sentry/bun` as a second lazy import. Criterion: whether any production consumer runs the published CLI under Bun. Decide: the author.
3. **`@sentry/node` full SDK vs a minimal `@sentry/core` envelope client.** Recommended: full SDK, lazily imported - less hand-rolled transport code to maintain, and the allowlist plus disabled auto-context is the control surface. Criterion: envelope inspection in Phase 2; if the full SDK cannot be configured to emit the allowlist exactly, the minimal client wins. Decide: implementer, at Phase 2.
4. **Boundary-log breadcrumbs in CLI mode while enabled.** Options: none in v1 (recommended - crash-only keeps the payload contract trivially auditable); forward `deps.log` lines as breadcrumbs. Criterion: whether field crashes turn out to need pre-crash context the scrubbed stack lacks. Decide: revisit after field data exists; not blocking.

## References

**Normative**

- [ADR 0007 - narrow scope, one process at a time](../adr/0007-narrow-scope-one-process-at-a-time.md) - the scope test this RFC's placement passes and the library-layer decline records.
- [RFC 2119](https://www.ietf.org/rfc/rfc2119.txt) - keyword semantics.

**Informative**

- `src/execution/deps.ts` - `BoundaryLog` and `RunnerDeps.log`: the sink-free seam hosts wire (annex).
- `src/execution/failure.ts` - `FailureSummary` taxonomy the annex maps.
- `src/cli/index.ts` - the entry whose `run()` catch is the capture point.
- Fit check on Sentry adoption (session, 2026-09-14) - the two-reading analysis this RFC renders as a decision.
