# Claude operation support without an exact-version gate

Research resolution for [Establish Claude operation support without an exact-version gate](https://github.com/dungle-scrubs/harness-cli-normalizer/issues/147). Produced by Codex in the driving session on 2026-09-10. This resolves evidence, not the design decision. Product code and installed binaries remain unchanged.

## Finding

**Observed:** HCN 0.6.5 can run, resume, and account for staged context on installed Claude 2.1.267. Its CLI refuses accounting and marks resume unknown because its descriptor was verified against 2.1.263. A matching version is not needed for those successful operations. Simply deleting the gate is insufficient: the current accounting state machine accepts a later count even after an unexpected assistant frame.

## Evidence and limits

HCN source baseline: release `00e943e`. The research worktree is separate from the older, dirty main checkout. [The original context-inspection change](https://github.com/dungle-scrubs/harness-cli-normalizer/commit/cd2328d) explains the existing non-query probe. The active executable in all CLI recordings is Lucid's installed HCN 0.6.5, not the 0.6.4 executable on PATH. Claude is the already installed native 2.1.267 binary.

| Operation | Evidence | Standing |
| --- | --- | --- |
| Fresh task | [Fresh recording](recordings/fresh.ndjson) returns the synthetic marker and a clean terminal event. | Observed; empty tools/MCP and disabled extension/skill discovery. Not the full Lucid browser flow. |
| Native resume | [Resume recording](recordings/resume.ndjson) recalls the marker without receiving it again. Same native ID. | Observed; recall supports the claim beyond merely echoing an ID. |
| Missing native session | [Missing-session recording](recordings/missing-session.ndjson) fails rather than running the prompt in a fresh session. | Observed for one well-formed nonexistent ID; corruption and provider failures remain separate regression cases. |
| CLI context inspection | [CLI refusal](recordings/context-cli-refusal.json) is `unverified-adapter`. | Observed; no accounting subprocess is allowed past the version gate. |
| CLI resume inspection | [Resume inspection](recordings/resume-inspection.json) reports unknown for the session that successfully resumed. | Observed; this operation checks version/argv, not saved-session existence. |
| Fresh native accounting | [Fresh accounting](context-fresh.json): 79-character staged prompt, 5,681 tokens. | Observed by calling the unchanged release adapter beneath the CLI gate. |
| Larger staged input | [Larger accounting](context-larger.json): 122,959 characters, 42,545 tokens. | Observed with the same explicit model and settings as fresh accounting. The increase is evidence that staged input contributes. It is not proof of exact tokenization or all input forms. |
| Forked native accounting | [Resume accounting](context-resume.json): 24,245 tokens, with the synthetic source session recalled. | Observed. [Before](session-before.sha256) and [after](session-after.sha256) SHA-256 records match. These snapshots bracket accounting, before a later intentional compaction test. |
| Non-query behavior | Explicit-model accounting runs emit zero assistant frames and native success results with zero turns and zero assistant usage. | Observed for these probes. This does not claim that accounting makes no provider-side requests or incurs no hidden counting costs. |

The three explicit-model counts report `claude-opus-5`, a 1,000,000-token window and a 967,000-token input limit. A separate [default-model probe](context-fresh-default-model.json) reports `claude-opus-5[1m]`; observed names and requested choices must remain distinct. It is not the control for the staged-size comparison.

[probe-context.mjs](probe-context.mjs) calls the existing HCN argv builder and execution adapter. It changes no descriptor or CLI code. It explicitly empties native tools and MCP configuration for synthetic inspection. Its counts therefore do not represent Lucid's full tool-bearing prompt. Startup hook lifecycle events still occur; the probe does not claim that inspection has no startup side effects. It records only response structure and usage summaries, not configuration or hook payloads.

## What the official contracts establish

**Documented:** [the headless CLI](https://code.claude.com/docs/en/headless) runs the native agent loop and supports structured output. [Session resume](https://code.claude.com/docs/en/agent-sdk/sessions#resume-by-id) returns to a saved session; fork creates a distinct continuation. [The CLI reference](https://code.claude.com/docs/en/cli-reference) describes resume, fork, stream input/output, replay, and no-session-persistence flags. Sources accessed 2026-09-10.

**Documented:** [SDKUserMessage](https://code.claude.com/docs/en/agent-sdk/typescript#sdkusermessage) defines `shouldQuery: false` as staging without an assistant turn. The official [context-usage method](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/client.py) returns current usage, window and model data. Direct retrieval of the large TypeScript reference failed in this session; its indexed primary-source section supplied the definition.

**Observed:** the initialization response lists commands, models and session state. It contains no explicit declaration of support for the precise combination of non-query staging, replay acknowledgment and subsequent usage inspection. This is a statement about the captured response keys, not an exhaustive claim about all SDK negotiation facilities.

**Unverified:** no source examined promises that arbitrary future executables preserve all those semantics. A successful handshake alone cannot prove that a flag was honored. No finite probe proves all future behavior. The supported documented operation contract plus strict response validation and regression evidence is the defensible boundary; version equality provides neither semantic validation nor proof of session existence.

## Protocol negative controls

[probe-validation.mjs](probe-validation.mjs) feeds explicit synthetic sequences into the unchanged release interpreter. [Results](protocol-validation.json):

- Matching staged UUID plus complete numeric usage yields available accounting.
- Wrong replay UUID does not advance to usage. The execution owner supplies the timeout.
- Missing count fields yields unavailable/protocol.
- An unexpected assistant frame followed by a valid count still yields available accounting. This is a concrete missing guard to address before relying on operation results across versions. The guard must distinguish actual assistant execution from the observed zero-turn success result produced by non-query staging.

Failing after an unexpected assistant event cannot undo effects already performed. Inspection must retain the documented non-query contract, isolated/forked session handling, restricted probe experiments, and bounded termination. Do not claim that an arbitrary incompatible executable can be made side-effect-free by checking its output afterward.

## Contract constraints for the design ticket

These are evidence-derived constraints and proposals, not accepted implementation choices.

1. Separate descriptor verification provenance from current operation results. Do not turn `verifiedAgainst` into a minimum version or guessed compatibility range.
2. Define support per operation. Rendering a valid resume invocation, locating a session, confirming native identity, measuring staged context, and completing a task are different claims. In particular, context accounting must not depend on a general resume version verdict for a fresh request.
3. For accounting, validate matching staged acknowledgment, full usage shape, model/path provenance and absence of unexpected assistant execution. Preserve auth, limit, malformed protocol, missing executable, native exit, cancellation, timeout, transport and cleanup outcomes. A known version must not override a failed operation.
4. For resume, preserve the requested native ID and the native failure path. Existing `--runtime` never proved session existence. Either make its support claim explicitly about the supported invocation contract or provide a bounded non-mutating operation probe. Do not claim saved-session validation from `--help` or a version string. The actual resume and identity/error stream remain authoritative.
5. Keep executable resolution tied to the actual operation. The existing count pins its spawned executable path. Evidence from a replaced path or different model cannot authorize a different request. Avoid a new persistent capability registry or conversation state in HCN.
6. Preserve the complete-context and isolation tests. Add controls for a newer version with a valid operation, an equal version with broken behavior, wrong acknowledgments, unexpected assistant activity, invalid counts, model/path changes, cancellation and cleanup. Test both Node and Bun. Run the hcn skill claim checks against the eventual changed binary.

## Remaining limits

The probes do not establish all Claude models, corrupted transcripts, every native setting, or every provider. Those cases have explicit regression criteria; they do not justify treating a version mismatch as a failed operation. Persistent sessions were not probed here. No automatic fallback or retry was added. No installed version changed, and the descriptor anchor was not bumped.

Source verification used the release files directly because HCN's graph index describes the older checkout. The files carrying the version gate were missing from that index. The current code and the live probes, not graph absence, support this resolution.
