# Limits of Claude native context handling

Research resolution for [Establish the limits of Claude native context handling](https://github.com/dungle-scrubs/harness-cli-normalizer/issues/148). Produced by Codex in the driving session on 2026-09-10. This is evidence for the design decision, not approval to enable native handling for every Claude turn.

## Finding

**Observed and documented:** Claude can compact a resumed native session and continue it under the same ID. **Observed in Lucid's existing preparation:** even a tiny pending prompt with no imported history is held if a synthetic count says native occupancy exceeds the preparation limit. An HCN version-policy fix alone leaves this second obstacle to native session growth.

**Not established:** automatic compaction does not provide a general admission guarantee for a new prompt containing arbitrary imported history, a huge current artifact, or oversized attachments. Keep the distinction between the native session's existing history and new context Lucid must deliver.

## Four required cases

| Case | What is covered | What remains with Lucid |
| --- | --- | --- |
| Ordinary fresh prompt | **Documented:** headless execution uses the native context-management loop. **Observed:** the installed HCN/Claude pair completes a synthetic first turn. | Preserve the complete pending prompt, required artifact protocol and current content. A fresh task does not need resume support. A small synthetic prompt is not full browser-flow evidence. |
| Native-session continuation | **Documented:** native resume preserves session identity and restores stored history; compaction summarizes growing context. **Observed:** both ordinary resume and a resumed turn crossing a lowered compaction threshold recall the marker under the same ID. | Select the actual native ID, require the correct owner and route, preserve missing-record coverage, and retain explicit failure/uncertain recovery. Native compaction does not authorize a replacement session. |
| Cross-harness transfer, first use of a harness with history, or explicit fresh recovery | **Observed in Lucid:** a new session gets full projected history; a resumed session gets context since its confirmed boundary. That context is embedded in one incoming prompt. | Preserve roles, authorship, source IDs, artifact versions, mandatory content, summaries and source retrieval. Another harness's history is not already in Claude's native transcript. Large transfer needs bounded preparation or proven equivalent behavior. No such equivalence was established here. |
| Oversized initial request or mandatory current content | **Documented:** native prompt-size, byte-size and compaction failures exist. | Preserve the input and required content. A native runtime failure may be reported, but must not silently trim content, retry, switch models, or create a new session. The design must state which cases remain preflight holds. |

Official sources, accessed 2026-09-10: [headless execution](https://code.claude.com/docs/en/headless), [session resume](https://code.claude.com/docs/en/agent-sdk/sessions#resume-by-id), [automatic compaction](https://code.claude.com/docs/en/agent-sdk/agent-loop#automatic-compaction), and [request errors](https://code.claude.com/docs/en/errors#request-errors). The last source explicitly lists oversized prompt/request and compaction failure. This is enough to reject a universal fit guarantee; it does not prove that every large incoming prompt fails.

## Live compaction evidence

The [recording](recordings/compaction.ndjson) comes from installed HCN 0.6.5 and Claude 2.1.267. The prompt asks for the original marker without repeating it. The stream contains `progress` with label `compact_boundary`, the correct answer, and a clean terminal event. The native session ID matches the [earlier resume](recordings/resume.ndjson). No tool events occur.

The run sets `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=2` for that one child process. The official [environment-variable reference](https://code.claude.com/docs/en/env-vars) documents a percentage override for triggering compaction earlier. This is a synthetic threshold test on a small test session, not evidence of behavior at the model's full capacity. It does not establish every constraint survived compaction, all providers, or all models. It changed no installation or persistent settings. HCN already exposes the native boundary as a progress label; this experiment does not require a new event kind.

The [context-window documentation](https://code.claude.com/docs/en/how-claude-code-works#when-context-fills-up) warns that early detailed instructions can be lost. A retained native transcript, canonical Lucid record, and everything visible to the active model are different guarantees. Native handling can preserve durable history and session identity without promising lossless active context.

## Oversized transport probe

**Observed:** an additional fresh request containing more than 11 MiB of synthetic text failed through installed HCN with `class: transport` and `native prompt stdin failed`. See [the recording](recordings/oversized.ndjson). No assistant message or native identity was emitted. This establishes a failed oversized transport attempt, not a measured token-capacity rejection or successful compaction of a large initial request. The HCN result does not identify a precise size-limit cause. The eventual failure regression must preserve a useful operation explanation and must not blindly retry this unchanged request because the current transport classification says retryable.

## Why mandatory preflight is a separate responsibility

Lucid baseline: `61733ba` plus the user's existing diagnostic and unrelated dirty work, all preserved. The relevant selection path was read directly in `src/modes/managed-preparation.ts`; the diagnostic addition affects error detail, not the route choice.

[Current drivers](https://github.com/dungle-scrubs/lucid/blob/61733ba/docs/drivers.md) specify both native management and bounded preparation. [Current compatibility](https://github.com/dungle-scrubs/lucid/blob/61733ba/docs/compatibility.md) delegates operation support to HCN without version policy. [Historical RFC 15 R7/R8](https://github.com/dungle-scrubs/lucid/blob/51014fc/docs/rfc/15_local-hub-conversation-integration.rfc.md#r8-context-bounds-and-automatic-summaries) explains why full context, mandatory content, bounded summaries, and confirmed coverage must remain. Its historical version-admission language is superseded by the current compatibility contract.

**Observed source behavior:** the current [projection](https://github.com/dungle-scrubs/lucid/blob/61733ba/src/store/conversation-context.ts) separates `history`, mandatory artifact entries, and pending input. The caller chooses the history start from the target native session's confirmed coverage. The renderer embeds the chosen history and mandatory material as quoted context in the incoming prompt. There is already enough information to distinguish no new history from some transferred history; no cross-process store in HCN is needed for that distinction.

**Observed synthetic control:** [probe-lucid-preflight.mjs](probe-lucid-preflight.mjs) invokes the unchanged current preparer with empty imported history, no mandatory artifact, and the prompt `Continue.` A fake native count reports 970,000 tokens against a 967,000-token input limit. [The result](lucid-native-occupancy.json) is a context-preparation hold after one count. No task can start and therefore the native process cannot compact that thread. These numbers are synthetic and intentionally isolate policy; they are not a live measurement of the test session.

**Observed source behavior:** Lucid summarizes entries in its captured `history`. It cannot remove already-recalled native history by summarizing an empty imported history. Even when some new history exists, native occupancy can consume the measured budget before local summarization can help. A count of the combined request does not itself separate irreducible incoming content from native history that can be compacted.

The existing [Codex native-management RFC](https://github.com/dungle-scrubs/lucid/blob/61733ba/docs/rfc/19_codex-native-context-management.rfc.md) delegates growing-thread management but accepts native rejection of oversized incoming work. It leaves Claude on preflight. Copying its broad declaration to Claude would bypass all Claude local summaries, including history transfers. That would change an existing protection and is not a research conclusion.

## Smallest candidate supported by the evidence

This is a proposal for the decision ticket:

- HCN reports operation support rather than turning verification-version mismatch into failure. Accounting and resume have distinct evidence and failures; see [operation findings](operations.md).
- Lucid retains context capture, current mandatory content, offered full copies, native identity and coverage, and the prepared execution fence.
- For a route HCN declares able to handle its native context, a fresh turn with no imported history or a native continuation with no missing record history need not require a count of the existing native thread before dispatch. Preserve the full incoming request and report any actual failure.
- When Lucid must import recorded history, keep bounded preparation and automatic summaries. Determine eligibility from captured context, not a model table, version comparison, character threshold, or a prior accounting error.
- An overflowing current artifact or user request remains mandatory. The decision must explicitly accept a native failure for that case or retain a preflight hold. Native handling cannot promise to fix it.

This holds the products' requested scope and reuses existing components. It has one deliberate remaining limitation: transferred history into a nearly full native session can still hold if the count/summary path cannot establish room. Solving that case by compacting a fork, separately measuring incoming material, or staging transfer incrementally would need its own evidence and design. It is not silently included in the ordinary-startup fix. The user must choose whether that remaining case blocks the destination or belongs in later work.

## Regression evidence for the handoff

Already observed here: short fresh task, native recall, missing-session failure, native accounting with staged-size sensitivity, source-session hash preservation during forked accounting, and native compaction followed by recall. All use synthetic content. Full Lucid browser startup and the existing diagnostic's reported 1,425-test run were not repeated in this research phase.

The implementation handoff must require:

1. **Fresh startup:** New artifact, No project, Claude, short prompt, complete artifact rendered. A compatible version change must not block task startup. Use the actual selected model and installed/built HCN path.
2. **Continuity:** same native ID, recall after process loss, recall across compaction, missing/corrupt session, native identity mismatch, smaller-capacity model selection, and uncertainty without automatic replay. Confirm coverage only on existing acknowledgment evidence.
3. **Transfer:** first use of a harness with a large record; return after another harness contributes; explicit fresh recovery; quote roles/source IDs; current artifact and comparison material; recent constraints and failure state; bounded summaries and full-source retrieval. Include native occupancy already near its limit so the remaining hold is explicit.
4. **Failures:** oversized pending input, oversized current artifact, transport byte limit, disabled compaction, compaction failure, malformed/missing capability declaration, auth and provider failure, cancellation, timeout, cleanup, and stale executor/settings/folder/context. Preserve the accepted input and distinguish pre-start hold from an attempted native failure. Never make an automatic second task call.
5. **Isolation of change:** non-Claude behavior and persistent sessions retain their defined paths. Native eligibility must not arise from a failed count. Observed model agreement remains unmeasured where no native count is taken.
6. **Gates:** HCN's Node/Bun checks, package/build validation and source skill claim scripts against the changed binary; Lucid's full check and compiled build; fixture capture from the intended HCN release; and browser evidence. Keep the diagnostic patch separate from the startup fix until reviewed integration.

Token-capacity overflow, history transfer, disabled-compaction, provider and full browser cases above are not claimed as live-verified. The separate oversized-byte attempt has the narrower result stated above. Native documentation and current source establish the limits; the eventual change must supply its own deterministic regressions and targeted live confirmation.

## Decision left open

Whether to accept native failure for oversized mandatory initial input, and whether the nearly-full-session transfer limitation blocks this map, are user-facing policy choices. Research cannot approve them. The blocked design ticket now has enough evidence to compare the narrow split with retaining universal preflight or adopting broader native handling.

Graph coverage for the context projection and coverage modules matched recorded metadata; their relevant source was also read. The preparer and HCN release files were checked directly where graph metadata was stale or missing. No exhaustive absence claim depends on the graph.
