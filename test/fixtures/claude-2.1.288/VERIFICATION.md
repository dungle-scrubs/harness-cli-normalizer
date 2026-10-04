# Claude Code 2.1.288 verification

Captured on pro, 2026-10-03, from the native installer executable
`/Users/kevin/.local/share/claude/versions/2.1.288`. The npm latest tag agrees
with that build; `version-source.snapshot.json` records the registry observation.

## Live suites

The absolute checkout smoke scripts ran from two separate synthetic working
directories, with `SMOKE_HARNESS=claude`, `SMOKE_CWD` set to each directory and
separate `SMOKE_CAPTURE_DIR` values. The seven and questions snapshots are new
captures, not copies of an older version. All seven scenarios pass; the
question observation is sonnet, 2.1.288, 2026-10-03. Snapshots and native outputs
never share directories with another worker or suite.

## Native accounting

`context-native.ndjson` and `context-resume-native.ndjson` contain the native
usage control-response lines, extracted byte-for-byte from each recording.
Initialize responses remain in the local task evidence, not in these usage
fixtures. The fresh estimate is 5792 tokens; the forked resume is 24651 tokens.
Both report model `claude-opus-5`, window 1000000 and input limit 967000.

The proof files record argv, staged-prompt character count, native frame types
and the accounting result. Both stage exactly one complete user frame, use
`shouldQuery:false` through the existing adapter, emit no assistant frame and
finish with `num_turns:0`. Before/after SHA-256 digests are identical, proving
that accounting did not write the source session. The adapter disables
persistence and forks the resume. These isolated native probes additionally
supply `--tools "" --strict-mcp-config --mcp-config {"mcpServers":{}}`; those
flags are probe isolation, not an adapter default. No user settings or
authentication files were changed.

`context-public.ndjson` is the source CLI's `inspect claude --context --json
--model claude-opus-5 --no-extensions --no-skills` result on another synthetic
prompt. Its executable version and descriptor anchor are 2.1.288.

## Native compaction

The synthetic marker HERON-1029 was stored through an opus turn and followed
by two haiku turns requesting 40 imaginary-planet descriptions each. The
resume recall ran with `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=2`; all probes unset
`CLAUDE_CODE_AUTO_COMPACT_WINDOW`. Native stdout is kept in
`compaction.native.ndjson`; the decoded event stream is `compaction.ndjson`.

Three compacting statuses precede one successful automatic boundary:
24097 tokens before, 6703 after, 64634 ms. The model recalls HERON-1029.
`post-compaction.native.ndjson` and `post-compaction.ndjson` record a separate
later process, with no lowered-threshold override, recalling the marker again.
No failed compaction occurred in this run. Native failures and malformed
accounting remain covered by the focused adapter regressions.

This lowered-threshold probe proves the trigger, replacement installation and
later-process marker recall. It does not prove full-capacity behavior or
lossless recall. Operator configuration echoed in nonempty hook `output` and
`stdout` fields is replaced with field-and-original-length redaction markers.
The native compaction summary also has 20 operator-configuration spans,
totaling 3482 original characters, replaced with the same markers. Local
baseline and source comparisons distinguish those spans from native content,
including one mixed excerpt whose native portion remains intact. Exact byte
checks confirm preservation outside the selected spans, and all five fixture
consumer tests pass in both Vitest and Bun after the redactions.

Empty hook responses and all other native bytes are preserved. The initial
pattern audit missed the hook fields; independent review found them and the
field audit corrected the fixture copies. Fixtures predating 2.1.288 remain
unchanged.
