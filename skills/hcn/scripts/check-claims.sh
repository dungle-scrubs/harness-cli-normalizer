#!/usr/bin/env bash
# check-claims.sh - re-verify the hcn skill's binary-checkable claims
# against the selected hcn CLI.
#
# Run it with bash from any directory:
#   bash "<skill-dir>/scripts/check-claims.sh"
#   HCN_BIN=/absolute/path/to/hcn bash "<skill-dir>/scripts/check-claims.sh"
#
# Exit codes:
#   0  every check ran and every expectation was found.
#   1  at least one claim mismatch: the CLI disagrees with the skill. Each
#      mismatch prints a MISS line. A mismatch outranks any blocked check.
#   2  blocked before any check ran: Bash, Node or a launchable hcn is
#      missing. Each "blocked:" line names what to provide.
#   3  every check that ran passed, but some checks could not run here.
#      Each "blocked:" line names the operations it covers and the fix;
#      nothing else is affected.
# An environment that cannot run a check never exits 1.
#
# HCN_BIN selects the binary under test and defaults to hcn on PATH.
# CHECK_CLAIMS_REQUIRE_SNAPSHOT=1 turns a blocked snapshot check into a
# MISS, so a maintainer or CI run cannot pass without exercising it.
# CHECK_CLAIMS_EXTRA adds one expectation to the top-level help check.
# The test file uses it to prove a bad expectation fails with exit 1.

# A POSIX sh that is not bash stops here, before any bash-only syntax.
if [ -z "${BASH_VERSION:-}" ]; then
  echo 'blocked: this check needs Bash; run it as: bash "<skill-dir>/scripts/check-claims.sh"'
  exit 2
fi
set -u

# hcn's own runtime floor (package.json "engines"); the checker needs it too.
node_floor=24
if ! command -v node >/dev/null 2>&1; then
  printf 'blocked: node is not on PATH; install Node %s or newer (hcn requires it)\n' "$node_floor"
  exit 2
fi
node_version=$(node -p 'process.versions.node' 2>/dev/null)
node_major=${node_version%%.*}
case "$node_major" in
  '' | *[!0-9]*)
    printf 'blocked: node on PATH did not report a version; install Node %s or newer\n' "$node_floor"
    exit 2
    ;;
esac
if [ "$node_major" -lt "$node_floor" ]; then
  printf 'blocked: node %s is older than hcn'"'"'s floor; install Node %s or newer and rerun\n' \
    "$node_version" "$node_floor"
  exit 2
fi

bin=${HCN_BIN:-hcn}
case "$bin" in
  */*)
    if [ ! -f "$bin" ] || [ ! -x "$bin" ]; then
      printf 'blocked: %s is missing or not executable; set HCN_BIN to the hcn executable\n' "$bin"
      exit 2
    fi
    ;;
  *)
    if ! command -v "$bin" >/dev/null 2>&1; then
      printf 'blocked: %s not on PATH; install hcn (npm install -g @dungle-scrubs/harness-cli-normalizer) or set HCN_BIN\n' "$bin"
      exit 2
    fi
    bin=$(command -v "$bin")
    ;;
esac

# 126 and 127 come from the launcher (bad interpreter, missing node), not
# from hcn, whose own exit codes are 0, 1, 2 and 4.
launch_output=$("$bin" --version 2>&1)
launch_rc=$?
if [ "$launch_rc" -eq 126 ] || [ "$launch_rc" -eq 127 ]; then
  printf 'blocked: %s could not be launched (exit %s): %s\n' \
    "$bin" "$launch_rc" "$(printf '%s' "$launch_output" | head -n 1)"
  exit 2
fi

misses=0
blocked=0

require() {
  # require <label> <haystack> <needle>...
  label=$1
  hay=$2
  shift 2
  for needle in "$@"; do
    case "$hay" in
      *"$needle"*) ;;
      *)
        printf 'MISS: "%s" not found in %s\n' "$needle" "$label"
        misses=$((misses + 1))
        ;;
    esac
  done
}

read_help() {
  if ! output=$("$bin" "$@" --help 2>&1); then
    printf 'MISS: hcn %s --help failed\n' "$*" >&2
    return 1
  fi
  printf '%s' "$output"
}

help_top=$(read_help) || exit 1
help_run=$(read_help run) || exit 1
help_session=$(read_help session) || exit 1
help_inspect=$(read_help inspect) || exit 1

# The passive reader is additive; an older binary leaves it unavailable.
case "$help_inspect" in
  *"--native-settings"*)
    require "hcn inspect --help" "$help_inspect" \
      "--resume" "--cwd" "source fingerprint" \
      "64 MiB" "1 MiB per line" "16384 directory entries" \
      "No conversation text, permission grant or ownership claim"
    case "$help_inspect" in
      *"Codex or Pi"*)
        require "hcn inspect --help (Pi settings)" "$help_inspect" \
          "saved leaf's parent chain" "model and thinking level"
        ;;
      *) require "hcn inspect --help (older settings)" "$help_inspect" "Codex only" ;;
    esac
    ;;
esac

case "$help_run" in
  *"--native-settings-fingerprint"*)
    require "hcn run --help" "$help_run" \
      "explicit --cwd" "inspect --native-settings" \
      "competing model/effort/provider" "Grants no permissions"
    case "$help_inspect" in
      *"Codex or Pi"*) require "hcn run --help (Pi settings)" "$help_run" "Codex or Pi resume only" ;;
      *) require "hcn run --help (older settings)" "$help_run" "Codex resume only" ;;
    esac
    require "hcn inspect --help" "$help_inspect" \
      "--native-settings-fingerprint" "headless-turn previews"
    ;;
esac

# The native operation is additive; older binaries correctly leave it unavailable.
case "$help_run" in
  *"--native-approvals"*)
    require "hcn run --help" "$help_run" \
      "One verified Codex response through app-server" \
      "Stdin carries NDJSON approval decisions" \
      "no automatic grants" "owned cleanup"
    ;;
esac

# The native terminal operation is independently additive.
case "$help_top" in
  *"interactive <harness>"*)
    help_interactive=$(read_help interactive) || exit 1
    require "hcn interactive --help" "$help_interactive" \
      "--interface" "--launch-id" "--resume" "--cwd" "--control-fd" "--env" \
      "version 1 NDJSON" "spawn-not-attempted" "Started does not prove native" \
      "Exit code alone is not no-child evidence"
    case "$help_interactive" in
      *"--startup-prompt"*)
        require "hcn interactive --help startup" "$help_interactive" \
          "at most 8192 bytes" "no NUL" "passed once as data" \
          "Omit it for idle resume" "refuses before spawn"
        ;;
    esac
    ;;
esac

# Operation-based admission is explicit in newer builds' runtime help.
case "$help_inspect" in
  *"All harnesses use invocation support"*)
    require "hcn inspect --help (runtime)" "$help_inspect" \
      "Version metadata never rejects a supported invocation" \
      "A resolved executable is required" \
      "does not run a model or prove the saved session exists"
    ;;
esac

# The one command shape, session mode, and inspect (SKILL.md).
require "hcn --help" "$help_top" \
  "run <harness>" \
  "session <harness>" \
  "inspect <harness>"

if [ -n "${CHECK_CLAIMS_EXTRA:-}" ]; then
  require "hcn --help" "$help_top" "$CHECK_CLAIMS_EXTRA"
fi

# Flags the SKILL.md body and references/reference.md flag table print.
require "hcn run --help" "$help_run" \
  "claude | codex | pi | muse | cursor | antigravity" \
  "--prompt-file" \
  "--model" \
  "--effort" \
  "--sandbox" \
  "--context-window" \
  "--provider" \
  "--tools" \
  "--exclude-tools" \
  "--autonomy" \
  "--questions <ask|assume|none>" \
  "--system-prompt" \
  "--append-system-prompt" \
  "--max-steps" \
  "--timeout" \
  "--no-tools" \
  "--no-instruction-files" \
  "--no-extensions" \
  "--no-skills" \
  "--skills" \
  "--session-id" \
  "--access" \
  "--cwd" \
  "--env" \
  "--resume" \
  "--resume-last" \
  "--json"

# Defaults the body quotes: effort medium, sandbox workspace-write,
# questions/contextWindow config keys, awaiting-input done cause, config chain.
# The tilde path is a literal quoted from the help text (SC2088 is wrong here).
# shellcheck disable=SC2088
require "hcn run --help (Defaults section)" "$help_run" \
  "effort medium" \
  "workspace-write" \
  "launch default 272000" \
  "questions" \
  "contextWindow" \
  "claude and codex narrow" \
  "awaiting-input" \
  ".hcn/config.json" \
  "~/.config/hcn/config.json"

# Older supported binaries leave Claude context-window support out of their help.
case "$help_run" in
  *"--autocompact"*)
    require "hcn run --help (context window)" "$help_run" \
      "codex 1-272000" \
      "popeye 1-10000000" \
      "claude 100000-1000000" \
      "--autocompact" \
      "auto-compact window" \
      "CLAUDE_CODE_AUTO_COMPACT_WINDOW" \
      "auto-compaction default - the profile window does not transfer"
    ;;
esac

# Memory controls are conditional for installed pre-memory builds.
case "$help_run" in
  *"--no-memory"*)
    require "memory run help" "$help_run" "--memory" "native memory setting"
    require "memory session help" "$help_session" "--memory" "--no-memory"
    ;;
  *)
    if [ "${CHECK_CLAIMS_REQUIRE_MEMORY:-0}" = 1 ]; then
      printf 'MISS: memory controls required for this verification\n'
      misses=$((misses + 1))
    fi
    ;;
esac

# Session claims: claude, pi, and Antigravity, plus questions, effort, and write-through sends.
require "hcn session --help" "$help_session" \
  "claude | pi | antigravity" \
  "--session-id" \
  "--questions <ask|assume|none>" \
  "--effort" \
  "started | rejected"

# Older supported binaries leave session context-window out of their help.
case "$help_session" in
  *"--context-window"*)
    require "hcn session --help (context window)" "$help_session" \
      "--context-window" "--autocompact" "auto-compact window"
    ;;
esac

# Skills at session spawn is additive (issue #332); older supported binaries
# correctly leave it out of the session help.
case "$help_session" in
  *"--skills"*)
    require "hcn session --help (skills)" "$help_session" \
      "\$HCN_SKILLS_ROOT" "exit 2" "spawn property"
    ;;
esac

# Conditional until isolation is released; older supported binaries lack it.
if printf '%s' "$help_run" | grep -q -- '--isolation'; then
  require "hcn run --help (isolation)" "$help_run" \
    "--isolation <tool-free>" "Fresh tool-free turn (claude)" "discovery" "native authentication"
fi

# Accounting remains conditional while older supported builds lack it.
case "$help_inspect" in
  *"--context "*)
    require "hcn inspect --help (context)" "$help_inspect" \
      "headless-turn only" "Native estimate" "persistence disabled" \
      "8 MiB" "--timeout/config timeout" "Interruption exits 1"
    ;;
esac

# Transcript claims are conditional while older installed builds remain in use.
case "$help_top" in
  *"transcript read"*)
    help_transcript=$(read_help transcript) || exit 1
    require "hcn transcript --help" "$help_transcript" "--since" "--limit" "--accept-limits"
    # The Codex reader reports the writer build instead of admitting one.
    case "$help_transcript" in
      *"reports the cli_version its own header names"*)
        require "hcn transcript --help (codex writer build)" "$help_transcript" \
          "the reader gates on the rollout's structure, not on that version"
        ;;
    esac
    # Listing is additive; an older installed binary reads but does not list.
    case "$help_transcript" in
      *"hcn transcript ls"*)
        require "hcn transcript --help (ls)" "$help_transcript" \
          "--all-workspaces" "--headless" "--harness <names>" "--limit <rows>" \
          "Only sessions whose workspace is exactly this"
        require "hcn --help (ls)" "$help_top" \
          "List saved native sessions, newest first"
        ;;
    esac
    # The time window is additive; a build that lists may still predate it.
    case "$help_transcript" in
      *"--since-time"*)
        require "hcn transcript --help (since-time)" "$help_transcript" \
          "Only sources written at or after this UTC instant" \
          "never opened"
        ;;
    esac
    script_dir=$(cd "$(dirname "$0")" && pwd)
    HCN_BIN="$bin" node "$script_dir/check-transcripts.mjs"
    case $? in
      0) ;;
      3) blocked=$((blocked + 1)) ;;
      *) misses=$((misses + 1)) ;;
    esac
    ;;
  *)
    if [ "${CHECK_CLAIMS_REQUIRE_TRANSCRIPT:-0}" = 1 ]; then
      printf 'MISS: transcript command required for this verification\n'
      misses=$((misses + 1))
    else
      printf 'skip: installed hcn has no transcript command\n'
    fi
    ;;
esac

# ADR 0009: the compaction-reporting roster in references/reference.md is a
# per-harness fact, not help text, so it is checked against the binary's own
# `inspect --json` rather than against a --help string. A binary predating the
# field prints nothing for it and the block skips, so an older hcn is not a
# miss. Without this the roster could drift silently, which is exactly the
# failure a claim check exists to stop.
if probe=$("$bin" inspect claude --json 2>/dev/null) && \
   printf '%s' "$probe" | grep -q '"compactionReporting"'; then
  if ! printf '%s' "$probe" | node -e '
    const fs = require("node:fs");
    const vocabulary = JSON.parse(fs.readFileSync(0, "utf8")).vocabulary;
    process.exit(Object.values(vocabulary.aliases).every(
      target => vocabulary.models.includes(target)) ? 0 : 1);
  '; then
    printf 'MISS: Claude alias targets are absent from the listed vocabulary\n'
    misses=$((misses + 1))
  fi
  for pair in \
    "claude:stream" "pi:stream" "antigravity:stream" "muse:view"; do
    harness=${pair%%:*}
    want=${pair##*:}
    got=$("$bin" inspect "$harness" --json 2>/dev/null |
      tr ',' '\n' | grep -A2 '"compactionReporting"' | grep '"source"' |
      sed 's/.*"source"[^"]*"\([a-z]*\)".*/\1/')
    if [ "$got" != "$want" ]; then
      printf 'MISS: %s compactionReporting.source is %s, skill says %s\n' \
        "$harness" "${got:-absent}" "$want"
      misses=$((misses + 1))
    fi
  done
  for harness in codex cursor; do
    if ! "$bin" inspect "$harness" --json 2>/dev/null |
         grep -q '"compactionReporting": *null'; then
      printf 'MISS: %s compactionReporting is not null; skill says it reports nothing\n' \
        "$harness"
      misses=$((misses + 1))
    fi
  done
  printf 'ok: compaction-reporting roster matches the binary\n'
else
  printf 'skip: installed hcn has no compactionReporting field\n'
fi

if [ "$misses" -gt 0 ]; then
  printf '%d expectation(s) missing\n' "$misses"
  exit 1
fi
if [ "$blocked" -gt 0 ]; then
  printf 'partial: every check that ran passed; the blocked lines above name what did not run\n'
  exit 3
fi
printf 'ok: all hcn expectations found\n'
exit 0
