# Phase 0 evidence: muse category flags

Verified against Muse Code 0.1.0, live runs, 2026-08-18, cwd /tmp.

## Probes

1. **--disable-web-tools**: control run lists `muse.web_search` in the model's
   tool set; with the flag the model answers NONE. Verified removal.
2. **--disable-write (behavioral)**: control run freely rewrites a file.
   With the flag, an explicit instruction to edit the file returns BLOCKED
   and the file is untouched. Verified enforcement.
3. **--disable-write (visibility)**: the tools (`muse.write_file`,
   `muse.edit_file`, `muse.bash`, ...) REMAIN in the model's listed catalog.
   Unlike claude's deny (which removes tools from the visible set), muse's
   category switches are runtime policy gates: tool present, calls denied.
   Model phrasing: "all are currently disabled/denied per session policy."
4. **--disable-write --disable-shell together**: legal, composes; the entire
   modify/run set is policy-gated.

## Facts for the descriptor (Phase 1)

- muse category switches are enforcement gates, not tool-set filters.
  The normalized write/shell toggles map to them cleanly (they already exist
  in the muse descriptor's turnOptions as `--disable-write` /
  `--disable-shell`).
- Tool names follow `muse.<name>` shape (muse.write_file, muse.bash,
  muse.web_search) - relevant to the extensible pass-through vocabulary.
- `--disable-web-tools` is a third category with no hcn turnOption yet;
  candidate for the normalized `web` toggle or passthrough-only.

## Caveat recorded

Claude denies by removing from the model's visible tool set; muse denies by
policy-gating execution while keeping the tool visible. Same caller-facing
outcome (call fails), different model-visible surface. This asymmetry feeds
the D3/D8 hint curation in Phase 3: "category switches gate execution; list
denials reshape the tool set."
