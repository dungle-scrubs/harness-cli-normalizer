#!/usr/bin/env bash
# Tests for check-claims.sh.
# A default or explicit working CLI passes; a known-bad expectation or broken
# CLI fails; a missing binary yields "blocked: ..." and exit 2.
set -u

dir=$(cd "$(dirname "$0")" && pwd)
script="$dir/../../skills/hcn/scripts/check-claims.sh"
fails=0
fixture_dir=$(mktemp -d) || exit 1
trap 'rm -rf "$fixture_dir"' EXIT
mkdir "$fixture_dir/working" "$fixture_dir/broken" "$fixture_dir/invalid" "$fixture_dir/pi-settings" "$fixture_dir/muse-evidence" "$fixture_dir/aliases"

# Test 1: a working binary passes through both selection paths, and a known-bad
# expectation exits 1.
working_hcn=${HCN_BIN:-}
if [ -z "$working_hcn" ] && command -v hcn >/dev/null 2>&1; then
  working_hcn=$(command -v hcn)
fi
if [ -n "$working_hcn" ]; then
  ln -s "$working_hcn" "$fixture_dir/working/hcn"
  if env -u HCN_BIN PATH="$fixture_dir/working:$PATH" /bin/bash "$script"; then
    echo "ok: default PATH binary passes"
  else
    echo "FAIL: default PATH binary did not pass"
    fails=$((fails + 1))
  fi
  CHECK_CLAIMS_EXTRA="no-such-flag-injected-by-test" HCN_BIN="$working_hcn" \
    "$script" >/dev/null 2>&1
  rc=$?
  if [ "$rc" -eq 1 ]; then
    echo "ok: bad expectation exits 1"
  else
    echo "FAIL: bad expectation gave exit $rc, want 1"
    fails=$((fails + 1))
  fi

  if HCN_BIN="$working_hcn" "$script" >/dev/null 2>&1; then
    echo "ok: explicit working binary passes"
  else
    echo "FAIL: explicit working binary did not pass"
    fails=$((fails + 1))
  fi
else
  echo "skip: no working hcn selected, working-binary tests not run"
fi

# Alias targets must be selectable explicit IDs in the reported vocabulary.
if [ -n "$working_hcn" ]; then
  case "$("$working_hcn" inspect claude --json)" in
    *'"compactionReporting"'*)
      {
        printf '#!/usr/bin/env bash\n'
        printf 'working_hcn=%q\n' "$working_hcn"
        cat <<'EOF'
if [ "$1 $2 $3" = "inspect claude --json" ]; then
  "$working_hcn" "$@" | node -e 'const fs=require("node:fs"); const doc=JSON.parse(fs.readFileSync(0,"utf8")); doc.vocabulary.aliases[Object.keys(doc.vocabulary.aliases)[0]]="fixture-unlisted-model"; process.stdout.write(JSON.stringify(doc)+"\n");'
  exit "${PIPESTATUS[0]}"
fi
exec "$working_hcn" "$@"
EOF
      } > "$fixture_dir/aliases/hcn"
      chmod +x "$fixture_dir/aliases/hcn"
      HCN_BIN="$fixture_dir/aliases/hcn" /bin/bash "$script" >/dev/null 2>&1
      rc=$?
      if [ "$rc" -eq 1 ]; then
        echo "ok: unlisted alias target fails verification"
      else
        echo "FAIL: unlisted alias target gave exit $rc"
        fails=$((fails + 1))
      fi
      ;;
  esac
fi

# Test 2: missing binary -> "blocked" and exit 2.
out=$(env -u HCN_BIN PATH="/var/empty" /bin/bash "$script" 2>&1)
rc=$?
if [ "$rc" -eq 2 ] && [ "${out#blocked:}" != "$out" ]; then
  echo "ok: missing binary exits 2 with blocked message"
else
  echo "FAIL: missing binary gave exit $rc, output: $out"
  fails=$((fails + 1))
fi

# A missing explicit binary keeps the blocked exit contract.
out=$(HCN_BIN="$fixture_dir/missing-hcn" /bin/bash "$script" 2>&1)
rc=$?
if [ "$rc" -eq 2 ] && [ "${out#blocked:}" != "$out" ]; then
  echo "ok: missing explicit binary exits 2 with blocked message"
else
  echo "FAIL: missing explicit binary gave exit $rc, output: $out"
  fails=$((fails + 1))
fi

# A present but broken explicit CLI must not count as verified.
cat >"$fixture_dir/broken/hcn" <<'EOF'
#!/bin/sh
exit 1
EOF
chmod +x "$fixture_dir/broken/hcn"
out=$(HCN_BIN="$fixture_dir/broken/hcn" /bin/bash "$script" 2>&1)
rc=$?
if [ "$rc" -eq 1 ] && [ "${out#MISS:}" != "$out" ]; then
  echo "ok: broken explicit CLI exits 1 with diagnostic"
else
  echo "FAIL: broken explicit CLI gave exit $rc, output: $out"
  fails=$((fails + 1))
fi

# A CLI advertising transcripts but emitting an invalid capability document fails.
if [ -n "$working_hcn" ]; then
  case "$("$working_hcn" inspect --help)" in
    *"Codex or Pi"*)
      {
        printf '#!/usr/bin/env bash\n'
        printf 'working_hcn=%q\n' "$working_hcn"
        cat <<'EOF'
if [ "$1 $2" = "inspect --help" ]; then
  "$working_hcn" "$@" | sed 's/parent chain/unverified branch/'
  exit "${PIPESTATUS[0]}"
fi
exec "$working_hcn" "$@"
EOF
      } > "$fixture_dir/pi-settings/hcn"
      chmod +x "$fixture_dir/pi-settings/hcn"
      HCN_BIN="$fixture_dir/pi-settings/hcn" /bin/bash "$script" >/dev/null 2>&1
      rc=$?
      if [ "$rc" -eq 1 ]; then
        echo "ok: missing Pi restoration rule fails verification"
      else
        echo "FAIL: missing Pi restoration rule gave exit $rc"
        fails=$((fails + 1))
      fi
      ;;
  esac
  case "$("$working_hcn" --help)" in
    *"transcript read"*)
      {
        printf '#!/usr/bin/env bash\n'
        printf 'if [ "$1 $2 $3" = "inspect pi --transcript" ]; then printf "{}\\n"; exit 0; fi\n'
        printf 'exec %q "$@"\n' "$working_hcn"
      } > "$fixture_dir/invalid/hcn"
      chmod +x "$fixture_dir/invalid/hcn"
      HCN_BIN="$fixture_dir/invalid/hcn" /bin/bash "$script" >/dev/null 2>&1
      rc=$?
      if [ "$rc" -eq 1 ]; then
        echo "ok: invalid transcript capability fails verification"
      else
        echo "FAIL: invalid transcript capability gave exit $rc"
        fails=$((fails + 1))
      fi
      {
        printf '#!/usr/bin/env bash\n'
        printf 'working_hcn=%q\n' "$working_hcn"
        cat <<'EOF'
if [ "$1 $2 $3" = "inspect muse --transcript" ]; then
  "$working_hcn" "$@" | node -e 'const fs=require("node:fs"); const doc=JSON.parse(fs.readFileSync(0,"utf8")); doc.capabilities.history.evidence.unshift({...doc.capabilities.history.evidence[0], standing:"observed", reference:"test/fixtures/muse-invalid/ABSENT.md"}); process.stdout.write(JSON.stringify(doc)+"\n");'
  exit "${PIPESTATUS[0]}"
fi
exec "$working_hcn" "$@"
EOF
      } > "$fixture_dir/muse-evidence/hcn"
      chmod +x "$fixture_dir/muse-evidence/hcn"
      HCN_BIN="$fixture_dir/muse-evidence/hcn" /bin/bash "$script" >/dev/null 2>&1
      rc=$?
      if [ "$rc" -eq 1 ]; then
        echo "ok: invalid observed Muse evidence fails verification"
      else
        echo "FAIL: invalid observed Muse evidence gave exit $rc"
        fails=$((fails + 1))
      fi
      ;;
  esac
fi

if [ "$fails" -gt 0 ]; then
  exit 1
fi
echo "all check-claims tests passed"
exit 0
