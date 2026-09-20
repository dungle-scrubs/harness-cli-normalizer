# Junie pricing, promotions, and HCN fit

Checked 2026-09-19. This is research and a candidate assessment, not an implementation decision. Kevin has no Junie account and Junie is not installed in his normal environment. The assessment used public documentation and a temporary installation with an isolated home directory. No authenticated model run was performed.

Standing: **documented** means the owning source states it; **observed** means a public HTTP response or local source was inspected; **unverified** means the question remains open. Recommendations and calculations are identified separately.

## Findings

Junie is technically viable for HCN as a spawn-per-turn harness. Public stable captures confirm streaming JSON, session identity, and resume flags. Authenticated execution remains unverified. Its Gemini 3.8 Flash discount is currently advertised at 75% off base pricing. This does not establish Junie as the cheapest harness for every workload. Official release-status and provider-routing documentation also disagree in places.

## Cost and promotions

**Documented:** The [Junie homepage](https://junie.jetbrains.com/#pricing) advertises 75% off Gemini 3.8 Flash, five starting credits, and BYOK at provider rates without markup. It also describes using different models for planning and implementation. **Observed:** An unauthenticated HTTP GET returned the promotion in the HTML itself; JavaScript rendering was unnecessary.

| Offer | Evidence on 2026-09-19 | Qualification |
|---|---|---|
| Gemini 3.8 Flash, 75% off base pricing | Documented on the current homepage and [September 9 announcement](https://junie.jetbrains.com/blog/junie-gemini-3-8-flash/) | IDE plugin and CLI. No expiry date or full discounted input/output/cache rate table is stated. Account billing was not tested. |
| Gemini 3.7 Flash, 40% off base pricing | Documented in the [August 17 announcement](https://junie.jetbrains.com/blog/junie-gemini-3-7-flash/) | The article remains available, but that alone does not prove the older offer still applies. No expiry date is stated. |
| Targeted 40-credit trial | Documented in [JetBrains support](https://youtrack.jetbrains.com/projects/JUNIE/articles/SUPPORT-A-4511/Junie-CLI-AI-40-Trial-Credits-Trial-Balance-License) | Selected email recipients, CLI only, stable builds, account-specific expiration. Kevin's eligibility is unverified. |

**Calculation:** A 75% reduction means paying 25% of the applicable base rate, or four times the token allowance at the same spend if token mix and all other charges stay equal. It does not mean four times as many completed tasks. The September announcement says 3.8 spends more tokens exploring and verifying, and describes 3.7 as cheaper per token.

**Documented vendor evidence:** The August announcement reports that Gemini 3.7 matched Sonnet 5's solve rate at about one-third of its per-task cost on JetBrains' private evaluation. The underlying private evaluation was not independently reproduced here.

**Documented:** Junie uses additional models for helper work even with BYOK. See [Model selection, How Junie uses models internally](https://junie.jetbrains.com/docs/junie-cli-model-selection.html). Cost assessment must include those calls.

**Documentation conflict:** The [quickstart, authentication](https://junie.jetbrains.com/docs/junie-cli.html) says BYOK takes billing precedence when both routes have the model. The [model-selection page, Provider auto-detection](https://junie.jetbrains.com/docs/junie-cli-model-selection.html) says Junie takes precedence. Both are current official pages. Actual routing is **unverified**. A provider-direct BYOK request must not be assumed to receive a JetBrains promotion; verify the selected billing route and usage before measuring the offer.

## What the benchmark establishes

**Observed:** [SWE-rebench](https://swe-rebench.com/) returned these rows in its initial HTML. The displayed evaluation window is May 15 through July 1, 2026, with 111 problems from 65 repositories. This is a historical evaluation window retrieved today, not a September model comparison.

| Agent row | Resolved rate | Pass@5 | Cost per problem |
|---|---:|---:|---:|
| Junie | 61.8% | 73.9% | $0.81 |
| Claude Code | 60.4% | 75.7% | $3.39 |
| Codex | 58.0% | 73.0% | $1.59 |
| Cursor | 51.7% | 65.8% | $0.41 |

**Inference:** Junie shows a useful accuracy-cost tradeoff in this evaluation. Cursor has a lower per-problem cost, while Junie resolves more problems. This cannot establish universal price leadership or current Gemini 3.8 performance. Pass@5 is a separate metric from the resolved rate. The site's April changelog mentions evaluating Junie with Claude Opus 4.6, further caution against attributing this row to the new Flash promotion.

## Resources to query repeatedly

| Resource | Use | Limitation |
|---|---|---|
| [Junie RSS feed](https://blog.jetbrains.com/junie/feed/) | Detect new announcements, including model promotions | An announcement archive, not a live rate catalogue |
| [Junie homepage](https://junie.jetbrains.com/) | Check the currently advertised headline offer | May omit other active or account-specific offers |
| [Junie blog](https://junie.jetbrains.com/blog/) | Read the dated terms behind announcements | Old posts can remain after offers expire |
| [Central Console model pricing](https://www.jetbrains.com/help/jetbrains-console/plans-and-pricing.html#model-pricing) | Reference provider-base input/output/cache prices | Different billing context; the inspected table lacks 3.7/3.8 and is not a Junie promotion API |

**Observed:** A direct unauthenticated GET of the RSS URL returned parseable RSS XML. Its items contain titles, publication dates, links, and article content, including the September 9 Gemini 3.8 announcement. The web reader failed on this feed, but the direct HTTP request succeeded.

**Recommendation:** Poll RSS for new item links, then read matching articles and check the homepage for current advertising. Store the model, advertised discount, publication date, last checked time, and expiry only when supplied. Unknown expiry stays unknown. Do not turn an old article into a permanently active discount, or a missing headline into proof of expiration.

**Unverified:** No documented public API returning all active Junie model promotions, effective token rates, eligibility, and expiration was found in the pricing, CLI, model-selection, or announcement sources searched. The CLI documents `/usage` for session costs and token counts; authenticated billing was not inspected. This research did not create a recurring monitor.

## Release status

**Documented:** The [June 17 announcement](https://junie.jetbrains.com/blog/junie-coding-agent-out-of-beta/) says Junie left beta and includes the terminal CLI in its availability statement. The [CLI reference, managed launcher options](https://junie.jetbrains.com/docs/parameters.html) lists separate release, EAP, nightly, and experimental channels.

**Conflicting documentation:** The [headless page](https://junie.jetbrains.com/docs/junie-headless.html), dated September 18, still says Junie CLI is in EAP. Treat the product as announced generally available with a stable channel, while recording this unresolved documentation inconsistency. Do not call every feature stable.

**Documented limitation:** The [quickstart, Sandbox mode](https://junie.jetbrains.com/docs/junie-cli.html) says release and EAP builds do not expose sandbox mode. Experimental sandboxing covers terminal commands, not every file edit, MCP server, hook, or git operation.

## HCN candidate assessment

### Decision

Keep Junie on the roadmap as a **qualified candidate blocked on authenticated admission**. Do not create an account only to continue general research. The public CLI proves that Junie has a usable headless process shape, but it also exposes contract gaps that require one bounded authenticated probe before implementation.

This is a good no-account assessment boundary:

1. Read current first-party documentation.
2. Install the public stable binary under a temporary `HOME`.
3. Use an empty temporary project and home, disable default config file locations, and disable automatic update checks.
4. Probe help, version, input, output, authentication failure, and resume failure with no credential or a synthetic invalid credential.
5. Keep all authenticated claims unverified.
6. Remove the temporary installation after the evidence is recorded.
7. Create an account only if the remaining product value justifies the authenticated probe.

This process does not test model quality, billing, promotions, tool execution, approvals, cancellation, or successful resume. Those claims require a real account.

### Fit check

**Observed repository contract:** [CONTEXT.md](../../CONTEXT.md) and [ADR 0007](../adr/0007-narrow-scope-one-process-at-a-time.md) limit HCN to normalizing harness differences and supervising its spawned process. [The descriptor](../../src/knowledge/descriptor.ts) currently accepts Claude and Pi session-input protocols, not ACP.

- Actual user: Kevin, invoking coding harnesses through HCN for his CLI and assistant workflows.
- Product purpose: one stable CLI for harness differences and supervision of each spawned process.
- Candidate fit: translating Junie's invocation, outputs, failures, and native resume serves that purpose.
- Scope direction: adding a sixth harness widens the supported set. Kevin decides whether to widen it.
- Price monitoring and cheapest-model selection belong in the caller or model-selection tooling. They require state and decisions across runs.

### Public stable release observed

The official [installer](https://junie.jetbrains.com/install.sh) was downloaded and inspected before execution. Its SHA-256 was `5c5b1a9359d9bac39a95435a2435e5c4b50a2a864f60bda7fb5e6802b20e9169`. It installed Junie only under a temporary home directory.

After the probes, the temporary home and downloaded installer were moved to Trash. Kevin's normal home, Junie configuration, and credential stores were not changed.

The stable launcher installed build `3294.5`. `junie --version` returned `Junie version: 26.9.21 (3294.5)`. The official [update manifest](https://raw.githubusercontent.com/jetbrains-junie/junie/main/update-info.jsonl) identifies the same macOS arm64 release build and marketing version. The installed application was about 330 MB.

The stable help output exposes:

- A positional task and `--task` for one-shot execution.
- `--output-format text|json|json-stream` and `--input-format text|json`.
- `--session-id` with `--resume`, plus resume-last through `--resume`.
- `--model`, `--provider`, and effort values `low`, `medium`, and `high`.
- `--skip-update-check`.
- Configuration discovery controls for project and user configuration, MCP, skills, commands, custom agents, custom models, and extensions.
- `--acp` for a separate ACP process mode.
- No `--sandbox` option on the stable release.
- `--brave` only for interactive mode.

The [model-selection documentation](https://junie.jetbrains.com/docs/junie-cli-model-selection.html) lists more effort values than this stable build advertises in its help contract. HCN must use the values advertised by the pinned stable build until an authenticated probe proves otherwise.

### Unauthenticated process evidence

All probes ran in a new temporary Git repository with `--skip-update-check`, `--config-default-locations=false`, and `--output-format=json-stream`.

| Probe | Exit | Observed JSON stream | HCN implication |
|---|---:|---|---|
| No authentication | 0 | `error` with `Cannot find authorization`, then `result` | Exit status alone cannot classify failure. |
| Synthetic invalid token | 1 | `session`, `system` with `Authorization failed`, then `result` | Authentication failure can use a different event type and exit status. |
| Text on stdin | 0 | Same missing-authorization `error`, then `result` | Piped input is accepted, but persistence is not established. |
| Invalid effort without authentication | 0 | Missing-authorization `error`, then `result` | Junie did not validate the effort value before authentication. HCN should validate the stable values itself. |
| Resume a synthetic missing session ID | 0 | Only `result` | A requested resume can appear to succeed without identity or an error. Authenticated behavior remains unverified. |

The invalid-token run created `~/.junie/sessions/session-260919-163402-1haz/events.jsonl`, `state.json`, and `transcript.md` inside the isolated home. Its native event store recorded an `AuthorizationFailed` failure. The streamed events did not expose that native error code.

Observed session IDs are not UUIDs. The observed shape was `session-260919-163402-1haz`. Identity arrives as a `session` event with `sessionId`. A `result` event terminates the stream, but it does not prove success.

### Proposed HCN contract

This is a design outline, not implementation authorization.

| HCN concern | Proposed Junie mapping |
|---|---|
| Harness name | `junie` |
| One-shot task | Positional task |
| Stream output | `--output-format json-stream` |
| Stable execution | `--use-version=3294.5 --skip-update-check` |
| Resume by ID | `--session-id <id> --resume` |
| Resume last | `--resume` |
| Model | `--model <alias-or-id>` |
| Provider | `--provider <provider>` |
| Effort | `--effort low|medium|high` |
| Session identity | `type=session`, `sessionId` |
| Terminal event | `type=result`, subject to prior failure events and identity checks |
| Native store | `~/.junie/sessions/<session-id>/events.jsonl` |
| Persistent session mode | None for the first addition |
| Headless autonomy | No stable flag observed |
| Stable sandbox | Unsupported |

Use the build number for exact execution. The [`@jetbrains/junie` npm package](https://www.npmjs.com/package/@jetbrains/junie) reports an older version than the installer release, and [GitHub's latest release](https://github.com/JetBrains/junie/releases/latest) points to a nightly build. Neither is a safe stable-version source. The current HCN version parser would keep `26.9.21` and discard build `3294.5`. That loses information because the official manifest can assign multiple builds to one marketing version.

[ACP support](https://junie.jetbrains.com/docs/junie-cli-acp.html) is intended for editors and ACP clients. The standard headless CLI is the documented CI path. HCN can support Junie first with spawn-per-turn one-shot and resume commands. Piped JSON does not prove a persistent multi-turn process, so it does not justify an `openSession` protocol.

Headless runs are trusted by design. Junie can load project configuration, MCP servers, hooks, agents, skills, and guidelines without prompting. HCN should expose the available discovery controls and document that Junie must run only in trusted repositories. HCN should not edit Junie's native allowlist.

### Authenticated admission gate

One account-backed qualification run must establish all of these before implementation:

1. A harmless one-shot task and the complete authenticated event vocabulary.
2. File edits, shell commands, native approvals, and decision questions.
3. Cancellation and signal handling.
4. Auth, quota, provider, model, and tool failures with their exit statuses.
5. Usage and cost events, if any.
6. Successful explicit resume, resume-last, and missing-session behavior.
7. Provider selection when Junie credits and BYOK are both available.
8. The effect of every configuration and discovery control used for isolation.

If the missing-session probe still returns an empty successful result after authentication, HCN needs either a new resume-on-missing behavior or a general failure when requested resume produces no matching session identity. That decision belongs after the authenticated fixture exists.

### Account decision

An account is justified only if Kevin wants to use Junie's subscription routing or promoted models. The account would fund one bounded admission pass and provide real fixtures. It is not needed to keep Junie on the roadmap.

Only this research file and the existing roadmap candidate status changed. HCN runtime, skill, and tracker state did not change.
