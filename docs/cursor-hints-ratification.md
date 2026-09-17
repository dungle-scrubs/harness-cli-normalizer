# Cursor hints ratification

Owner ratified 2026-09-17 (see `scratchpad/stages/owner-answers-rfc05-impl.md`):
the hints count test moves 32 to 34 for the two new cursor `tools` /
`excludeTools` entries.

## Entries

Both entries name the cursor config-file allow and deny lists as the
nearest control, so the owner-mandated `--tools` refusal never prints
the codex fallback:

- `cursor/tools`: "cursor has no per-tool name lists; shape the grant
  with the config-file allow and deny lists instead - there is no
  call-time flag"
- `cursor/excludeTools`: same wording.

## Pin

`test/interpretation/hints.test.ts` carries exactly 34 entries
(24 confirmed + 3 issue #48 ratified + 4 tools + 1 memory ratified
2026-08-26 + 2 cursor ratified 2026-09-17) and spot-checks the cursor
wording for drift.
