# Popeye 0.2.0 verification

Captured 2026-10-11 from the npm-distributed `@dungle-scrubs/popeye@0.2.0`
with `qwen3.6-35b-a3b-ud-mlx` through the existing loopback inference endpoint.
The six applicable `smoke:seven` scenarios passed: fresh turn, streaming,
single-process continuation, separate-process resume, interrupted resume, and
missing-executable failure. Tool use remains the suite's intentional skip.
`smoke:questions` omits Popeye; escalation remains unverified and false. No
native context-accounting or automatic-context-management declaration is added.

`fresh.ndjson` is the complete first native stdout capture, unchanged.
`seven.snapshot.json` is the live suite's receipt. `version.txt` is native
`--version` output. The prompts and workspace were synthetic; the capture
contains no operator instruction files, skill bodies, tool descriptions, or
credentials. Historical Popeye fixtures are retained.

The published package and installation surface are documented in the
[official README](https://github.com/dungle-scrubs/popeye/blob/main/README.md#install).
The version source is now npm, not an installed-only comparison.
