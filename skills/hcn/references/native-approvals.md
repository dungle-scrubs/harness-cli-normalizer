# Native approvals for one resumed response

Check `hcn run --help` for `--native-approvals`. An older binary refuses the
flag; keep the input held rather than falling back to ordinary exec.

1. Inspect `hcn inspect codex --native-settings --resume ID --cwd ABSOLUTE --json`.
2. Require available saved settings with recorded read-only filesystem,
   restricted network, user reviewer, and on-request or never policy.
3. Use the returned fingerprint in
   `hcn run codex --json --native-approvals --resume ID --cwd ABSOLUTE --native-settings-fingerprint HASH --prompt TEXT`.
   File-backed prompts use `--prompt-file PATH`. Stdin is reserved for decisions.
4. Read approval details and offered choices. Surface the exact request to
   the person unless their existing instruction already authorizes that
   precise action and scope.
5. Send the selected IDs on the same process's stdin as one newline-ended JSON
   object. Keep stdin open while the response continues.

```json
{"v":1,"op":"approval","id":"<new decision UUID>","requestId":"<offered request UUID>","choiceId":"<offered choice ID>"}
```

HCN rechecks saved evidence, restores supported settings and compares effective
identity/settings before submitting the prompt. After this native confirmation,
the identity event carries `authority: "harness-minted"`; it confirms the resumed
session, not creation of a new session or response completion. Fresh sessions, competing
model/effort/provider/permission flags, explicit --memory or --no-memory,
native passthrough and unsupported
harnesses are refused. Most-recent resume is refused here too: the plan
binds one exact session turn, so pass `--resume ID`, never
`--resume-last`. The transport runs one response, not a persistent
conversation service.

`approval-request` supplies version 1, request/session/turn IDs, category,
complete plain-text details, and choices with ID, label and scope.
`approval-disposition` reports sent or rejected with a reason.
`approval-cleared` means the request stopped waiting, not that its tool worked.
Render subsequent output for the result. `tool-result` retains each completed
native command/file item; match it to `tool.callId` when present. Inspect the
result for workflow status rather than treating a clean turn as tool success.
`usage` reports cumulative session `tokenUsage.total`, even on thread-only
updates; keep the latest snapshot instead of adding it to earlier snapshots.

Command choices can grant once, for the native session, or through an offered
persistent command-prefix rule. File session grants cover future changes to
the same files. Permission choices grant the exact shown subset for the
response or native session. HCN owns each native payload; send only offered IDs.
Currently unsupported: non-local environments, grouped network command grants,
symbolic/glob/legacy permission scopes, file grantRoot, native model questions
and MCP elicitation. HCN terminates these with owned cleanup.

Duplicate decision ID/content returns the recorded disposition without another
write. Conflicting content is rejected. Save a durable write intent before
sending when acting as a host. Missing acknowledgement never authorizes replay
or sending a choice to a replacement process. HCN retains no approval state
across processes.

Bounds: 4 KiB per decision including newline, 64 KiB UTF-8 details, 16 choices,
32 pending requests, 4096 request identities and recorded decisions per process.
Human waits pause inactivity detection; explicit `--timeout` keeps running.
Initialize, resume and turn acknowledgement each have a 30-second deadline.
EOF on decision stdin ends the response and cleans up the child.

Failure `nativeApproval` evidence separates phase, process creation and prompt
submission. Only `not-attempted`/`not-started` establish absence of a child;
`not-submitted` establishes absence of a prompt write. `submission-unknown`
means the prompt may have arrived. `acknowledged` records native turn ACK.
Never infer these facts from exit code, elapsed time or an empty transcript.
