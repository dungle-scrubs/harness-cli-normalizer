# Antigravity CLI harness assessment

Checked 2026-09-19. This assessment uses current Google documentation, the
public release manifest, an isolated installation, and authenticated probes on
the free Individual plan. It does not assess model quality.

Standing in this report:

- **Observed** means a local command or repository file was checked.
- **Documented** means an official Google source states the behavior.
- **Unverified** means runtime evidence is still unavailable.

## Decision

**Decision: add Antigravity CLI as a native HCN harness.** The authenticated
qualification passed against 1.2.7. The integration uses one descriptor, one
event reader, and one persistent-session input codec. It adds no supervisor or
transcript reader.

The scope direction is **widen** because HCN gains a sixth harness. Kevin is the
current user. The feature serves HCN's stated purpose: one stable interface over
different coding-agent CLIs, plus supervision of the process HCN starts.

Antigravity's headless permission denials can exit with code `0`. HCN therefore
reads the structured tool step and does not use exit status alone.

## Product status

**Documented:** Antigravity is generally available. Google's
[pricing page](https://antigravity.google/pricing) labels the product "Generally
Available" and includes the CLI in its plans. The CLI is not documented as a
beta.

**Observed:** the official installer fetched Antigravity CLI `1.2.7` for
`darwin_arm64`. The installed `agy --version` command also returned `1.2.7`.
The public
[release manifest](https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/darwin_arm64.json)
reported the same version and supplied a SHA-512 checksum. The official
[changelog](https://www.antigravity.google/changelog) records the CLI's initial
public `1.0.0` release on 2026-01-01 and active 1.x releases since then.

**Documented:** Gemini 3.8 Flash is available on Free, Google AI Plus, Google AI
Pro, Google AI Ultra, and Enterprise plans. Claude and GPT-OSS availability
depends on the plan. The current matrix is on Google's
[models page](https://antigravity.google/docs/models). Google's plan change
announcement says the shared quota is drawn down according to API-price ratios.
It uses an example where Flash is eight times cheaper than Pro. That is a quota
weighting rule, not a temporary CLI promotion. See
[Changes to Antigravity Plans](https://antigravity.google/blog/changes-to-antigravity-plans).

## Local observations

The official installer was downloaded and run under an isolated temporary home.
It did not read or change the user's Antigravity profile.

- The installer selected `darwin_arm64` and installed `agy` version `1.2.7`.
- `agy --help` lists print mode, NDJSON input and output, model, effort, resume,
  sandbox, autonomy, and structured-output flags.
- `agy --print "Reply with exactly OK." --output-format stream-json` accepted
  the documented one-shot grammar.
- With no cached account, the command emitted a structured `result` with status
  `ERROR`, zero usage, and an authentication error. It also opened an interactive
  OAuth flow and waited for an authorization code. HCN must treat first-time
  sign-in as native setup that occurs before an unattended run.
- Before sign-in, `agy models` failed with exit code `1` and told the user to
  sign in. The later authenticated capture is recorded below.
- The isolated profile created data under
  `~/.gemini/antigravity-cli/`, including a conversation summary database,
  logs, an updater directory, and project configuration.

The one-shot grammar fits HCN's current builder. A descriptor can use
`baseFlags: ["--print"]`; HCN then places the positional prompt before the
stream flags. This produces the required order:

```text
agy --print <prompt> --output-format stream-json
```

The CLI deliberately rejects `agy --print --output-format stream-json <prompt>`
because `--print` consumes the next argument as its prompt. The first installed
HCN probe found that turn options could still split this required pair, producing
`agy --print --effort medium --sandbox <prompt>`. The implementation therefore
adds descriptor-owned prompt placement for turn options. Antigravity places
`--effort` and `--sandbox` after the prompt, without a harness-name branch in the
argv builder.

The CLI was then installed for the user with Google's official installer at
`~/.local/bin/agy`. The binary reports `1.2.7`, is a native arm64 executable, and
has a valid Google LLC Developer ID signature. A corrected HCN one-shot run
reached the native authentication result. HCN classified the structured event as
`auth/not-logged-in` before the process ended with exit code `1`. This validates
the unauthenticated path. The authorization URL and code remain outside the
captured report.

## Authenticated qualification

**Observed on 2026-09-19:** Antigravity CLI 1.2.7 completed the qualification
with `gemini-3.8-flash-medium` on the free Individual plan.

- A fresh one-shot run emitted `init`, token deltas, a final message, usage, a
  harness-minted UUID, and a clean result.
- `view_file`, `write_to_file`, and `run_command` produced structured tool
  records. The read and workspace write had verified filesystem effects.
- The native `request-review` preset emitted a tool step with `state: "ERROR"`
  and `tool_info.error.type: "TOOL_ERROR"` when a shell command was denied. The
  terminal result still said `SUCCESS`, included `denied_actions`, and exited 0.
  HCN emits a non-terminal error with structured denial data and keeps the clean
  terminal result.
- The same command succeeded with `--dangerously-skip-permissions`.
- With `--sandbox` and autonomy both enabled, a shell write outside the
  workspace failed with `operation not permitted`, and the target file stayed
  absent. The native result still said `SUCCESS`, so HCN does not parse the
  assistant's prose to invent a tool failure.
- Named resume and resume last retained the native conversation ID. An unknown
  conversation ID started a fresh conversation and announced a different ID.
- A two-turn stream-json session retained one conversation ID.
- Cancellation, timeout, malformed stream input, unknown-model refusal, and an
  externally killed process all terminated and were reaped. Antigravity emits
  `context canceled` during HCN-initiated shutdown, so HCN gives its known
  caller-cancel or timeout cause precedence over that native shutdown record.
- The native transcript appeared at the documented brain path. HCN records the
  store template but still has no Antigravity transcript reader.
- `bun run smoke:seven` passed all seven Antigravity scenarios, and
  `bun run smoke:questions` observed the HCN question block.

`agy models` returned 14 account-eligible selectors: the high, medium, and low
variants of Gemini 3.8, 3.7, and 3.6 Flash; Gemini 3.1 Pro high and low;
Claude Sonnet 4.6; Claude Opus 4.6 Thinking; and GPT-OSS 120B Medium. The
descriptor remains extensible because plan eligibility and configured models
can change.

## Contract map

| HCN dimension | Antigravity CLI behavior | Integration result |
|---|---|---|
| Binary and version | `agy`; `agy --version` returned `1.2.7` | Fits. Start with `versionSource: installed`, as used for other non-npm CLIs. |
| One-shot launch | `agy -p <prompt> --output-format stream-json` | Fits the existing positional-prompt builder. |
| Streaming | `init`, zero or more `step_update` records, then one `result` | Add an Antigravity content reader. Token deltas come from agent-response step updates. |
| Identity | `conversation_id` on `init` and `result` | Fits harness-minted UUID identity. |
| Named resume | `--conversation <uuid>` | Fits flag-style resume. An unknown ID creates a fresh native conversation. |
| Resume last | `--continue` or `-c` | Fits HCN's resume-last contract. Google documents fresh-session fallback when its workspace cache is missing or stale. |
| Persistent session | `--input-format stream-json --output-format stream-json` | Fits `openSession`, with one new session-input kind for `{event:"user",message:{content}}`. |
| Turn delimiter | `event: "result"` once per input prompt | Fits after the session decoder reads `result.status` and `result.error`. |
| Model | `--model`; `agy models` listed 14 account-eligible values | Fits an extensible vocabulary with captured free-plan examples. |
| Effort | `--effort low\|medium\|high` | Fits the existing effort option. |
| Autonomy | `--dangerously-skip-permissions` | Fits the existing autonomy field. |
| Sandbox | `--sandbox` | Fits the existing sandbox turn option after its exact normalized value is chosen. |
| Permissions | Deny, Ask, and Allow rules in native settings | Keep native policy in Antigravity. Normalize observed denials and the autonomy switch. |
| Transcript | `~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/transcript.jsonl` | The store path is documented. Transcript parsing can remain `null` until issue 154 defines HCN's read contract. |
| Usage | Result records contain input, output, thinking, cache-read, and total tokens | Capture as evidence. HCN currently has no usage event in `HarnessEvent`. |
| Cancellation | HCN sends its normal signal escalation; 1.2.7 reports `context canceled` while exiting | HCN preserves the explicit caller-cancel or timeout cause and reaps the process. |

The protocol facts above come from Google's
[headless-mode documentation](https://antigravity.google/docs/cli/headless/),
[resume documentation](https://antigravity.google/docs/cli/commands/resume),
[hooks documentation](https://antigravity.google/docs/hooks), and
[permissions documentation](https://antigravity.google/docs/permissions?tab=cli).

## Official documentation recheck before implementation

Rechecked 2026-09-19 against the current official Google pages and public
release manifest. The manifest still reports CLI `1.2.7`. The headless page
still defines `init`, `step_update`, and `result` records, and it now makes the
terminal status vocabulary explicit: `SUCCESS`, `ERROR`, `CANCELED`,
`INTERRUPTED`, `INVALID`, `WAITING`, and `RUNNING`. It also confirms that
malformed session input ends with an `ERROR` result and a nonzero process exit.

The current command reference documents `--sandbox` as one boolean switch,
not a value-taking mode. HCN therefore maps only its existing
`workspace-write` normalized value to that flag. The headless and models pages
publish example model slugs. The authenticated `agy models` capture now
supplies the free-plan list used by the descriptor.

Google documents completed tool failures through `tool_info.error` and
documents soft permission denial as a process that can still exit successfully.
The pages do not publish the complete structured permission-denial record. The
authenticated fixture now supplies it. The implementation decodes the
structured tool error. General assistant prose is not permission evidence.

## Implemented HCN changes

1. Added `antigravity` to the closed harness-name vocabulary and added
   `src/knowledge/antigravity.ts`.
2. Registered the descriptor in the default descriptor set and CLI surfaces.
3. Added a pure Antigravity reader in `src/interpretation/content.ts` for:
   - `step_update` token deltas;
   - completed tool calls and tool denials from `tool_info`;
   - the final `result.response` message;
   - non-success `result.status` values and `result.error`.
4. Added an `antigravity-stream-user` session-input kind. Its encoder writes one
   NDJSON user event per turn. Its decoder treats each `result` as the turn end
   and preserves non-success status as a failed turn.
5. Added authentication and permission-denial classification from captured
   output. The observed unauthenticated result supplies the auth evidence.
6. Added exact model slugs and effort combinations from `agy models` and harmless
   authenticated runs. Keep the vocabulary extensible because Antigravity also
   accepts configured custom models.
7. Added the documented brain path as the native store template. Did not add a
   transcript reader until HCN's transcript contract is decided.
8. Used the installed binary for version drift. The public Google
   manifest can support a general HTTP JSON version source later if a second
   harness needs the same mechanism.

No Antigravity-specific process supervisor is needed. HCN's existing
`streamTurn` and `openSession` boundaries remain the owners of process lifetime,
stdin, stdout, stderr, cancellation, and terminal `done` events.

## Permission edge

Google documents a headless soft denial as a successful process exit with a
notice on `stderr`. This is the main integration risk.

HCN should surface a soft denial as an `error` carrying structured denial data.
It should not invent a failed task when the native `result` says `SUCCESS` and
the agent completed useful work after the denial. The final `done` event should
retain the native clean exit. This matches HCN's existing distinction between
diagnostic errors and terminal failure.

The authenticated fixture shows that `tool_info.error` contains the denial.
The reader uses that structured record and does not parse general model prose
to infer permission outcomes.

## Native features outside the first HCN addition

Antigravity also has custom agents, projects, remote control, scheduled tasks,
plugins, MCP management, and JSON-schema output. Those features do not block
harness support.

- `--agent`, `--project`, and `--json-schema` can travel through native
  passthrough until HCN has a cross-harness dimension for them.
- Remote control and scheduled tasks cross process and time boundaries. They
  stay with Antigravity or the caller.
- Plugin and MCP configuration stays in Antigravity's native configuration.
- HCN should supervise the one process it starts. It should not reproduce
  Antigravity's background daemon or task scheduler.

## Qualification gate

The pinned 1.2.7 qualification produced repository fixtures and external raw
captures for:

1. Fresh one-shot text with `init`, token deltas, final message, identity, and
   usage.
2. A read, workspace write, shell command, and a denied shell command.
3. The same denied command with `--dangerously-skip-permissions`.
4. `--sandbox` with a command that proves the sandbox boundary.
5. Named resume, resume last, and an unknown conversation ID.
6. A two-turn persistent stdin session with one stable conversation ID.
7. Valid model and effort selection, plus an unknown model refusal.
8. Authentication failure, cancellation, timeout,
   malformed input, and unexpected process exit.
9. Transcript creation at the documented brain path.

Quota failure was not available without deliberately exhausting the free plan,
so no quota fixture is claimed. The descriptor records the question probe in
`escalation.observedOn` and is verified against 1.2.7.

## Remaining unknowns

- The exact rate-limit and quota error records for this plan.
- Model availability on paid and enterprise plans.

These unknowns do not block the qualified free-plan contract or change the fit
decision.
