#!/usr/bin/env bash
# Tests for check-claims.sh.
# A default or explicit working CLI passes; a known-bad expectation or broken
# CLI fails with exit 1; a missing binary, an old Node or an unlaunchable CLI
# yields "blocked: ..." and exit 2; a TMPDIR that cannot clone blocks only the
# snapshot checks (exit 3) unless CHECK_CLAIMS_REQUIRE_SNAPSHOT=1 makes it a
# failure.
set -u

dir=$(cd "$(dirname "$0")" && pwd)
script="$dir/../../skills/hcn/scripts/check-claims.sh"
fails=0
fixture_dir=$(mktemp -d) || exit 1
noclone_dir=""
noclone_mount=""
# shellcheck disable=SC2329 # the EXIT trap invokes it
cleanup() {
  if [ -n "$noclone_mount" ]; then
    hdiutil detach -quiet "$noclone_mount" || hdiutil detach -force -quiet "$noclone_mount"
  fi
  case "$noclone_dir" in /dev/shm/*) rm -rf "$noclone_dir" ;; esac
  rm -rf "$fixture_dir"
}
trap cleanup EXIT
mkdir "$fixture_dir/working" "$fixture_dir/broken" "$fixture_dir/invalid" "$fixture_dir/pi-settings" "$fixture_dir/muse-evidence" "$fixture_dir/aliases" "$fixture_dir/denial-count" "$fixture_dir/claude-write" \
  "$fixture_dir/node-only" "$fixture_dir/old-node" "$fixture_dir/no-interpreter" "$fixture_dir/home-launcher"
real_node=$(node -p 'process.execPath')
ln -s "$real_node" "$fixture_dir/node-only/node"

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

# A CLI that advertises denial counts must emit them for reported denials.
if [ -n "$working_hcn" ]; then
  case "$("$working_hcn" run --help)" in
    *"done.denialCount"*)
      {
        printf '#!/usr/bin/env bash\n'
        printf 'working_hcn=%q\n' "$working_hcn"
        cat <<'EOF'
json=0
for arg in "$@"; do
  if [ "$arg" = "--json" ]; then json=1; fi
done
if [ "$1" = "run" ] && [ "$json" -eq 1 ]; then
  "$working_hcn" "$@" | node -e 'const fs=require("node:fs"); for(const line of fs.readFileSync(0,"utf8").trim().split("\n")){const event=JSON.parse(line); if(event.kind==="done")delete event.denialCount; console.log(JSON.stringify(event));}'
  exit "${PIPESTATUS[0]}"
fi
exec "$working_hcn" "$@"
EOF
      } > "$fixture_dir/denial-count/hcn"
      chmod +x "$fixture_dir/denial-count/hcn"
      if [ "$("$fixture_dir/denial-count/hcn" run --help)" != "$("$working_hcn" run --help)" ]; then
        echo "FAIL: denial-count wrapper changed help instead of only JSON events"
        fails=$((fails + 1))
      fi
      HCN_BIN="$fixture_dir/denial-count/hcn" /bin/bash "$script" >/dev/null 2>&1
      rc=$?
      if [ "$rc" -eq 1 ]; then
        echo "ok: omitted advertised denial count fails verification"
      else
        echo "FAIL: omitted advertised denial count gave exit $rc, want 1"
        fails=$((fails + 1))
      fi
      ;;
  esac
fi

# Claude write must retain its sandbox and selected skills in the native argv.
if [ -n "$working_hcn" ]; then
  case "$("$working_hcn" run --help)" in
    *"strict native sandbox"*)
      {
        printf '#!/usr/bin/env bash\n'
        printf 'working_hcn=%q\n' "$working_hcn"
        cat <<'EOF'
if [ "$1 ${2:-}" = "run claude" ]; then
  args=()
  while [ "$#" -gt 0 ]; do
    if [ "$1 ${2:-}" = "--access write" ]; then
      shift 2
    else
      args+=("$1")
      shift
    fi
  done
  exec "$working_hcn" "${args[@]}"
fi
exec "$working_hcn" "$@"
EOF
      } > "$fixture_dir/claude-write/hcn"
      chmod +x "$fixture_dir/claude-write/hcn"
      if [ "$("$fixture_dir/claude-write/hcn" run --help)" != "$("$working_hcn" run --help)" ]; then
        echo "FAIL: Claude-write wrapper changed help instead of only Claude write requests"
        fails=$((fails + 1))
      fi
      HCN_BIN="$fixture_dir/claude-write/hcn" /bin/bash "$script" >/dev/null 2>&1
      rc=$?
      if [ "$rc" -eq 1 ]; then
        echo "ok: omitted Claude write preset fails verification"
      else
        echo "FAIL: omitted Claude write preset gave exit $rc, want 1"
        fails=$((fails + 1))
      fi
      ;;
  esac
fi

# Test 2: missing binary -> "blocked" and exit 2. PATH holds only node, so
# the hcn lookup is what blocks.
out=$(env -u HCN_BIN PATH="$fixture_dir/node-only" /bin/bash "$script" 2>&1)
rc=$?
if [ "$rc" -eq 2 ] && [ "${out#blocked: hcn not on PATH}" != "$out" ]; then
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

# Node older than hcn's floor blocks every check with exit 2.
cat >"$fixture_dir/old-node/node" <<'EOF'
#!/bin/sh
echo 22.12.0
EOF
chmod +x "$fixture_dir/old-node/node"
out=$(PATH="$fixture_dir/old-node:$PATH" HCN_BIN="$fixture_dir/missing-hcn" /bin/bash "$script" 2>&1)
rc=$?
if [ "$rc" -eq 2 ] && [ "${out#blocked: node 22.12.0}" != "$out" ]; then
  echo "ok: old Node exits 2 with blocked message"
else
  echo "FAIL: old Node gave exit $rc, output: $out"
  fails=$((fails + 1))
fi

# A CLI whose launcher cannot start (missing interpreter) is blocked, not a MISS.
printf '#!/nonexistent/interpreter\n' >"$fixture_dir/no-interpreter/hcn"
chmod +x "$fixture_dir/no-interpreter/hcn"
out=$(HCN_BIN="$fixture_dir/no-interpreter/hcn" /bin/bash "$script" 2>&1)
rc=$?
if [ "$rc" -eq 2 ] && [ "${out#blocked:}" != "$out" ]; then
  echo "ok: unlaunchable CLI exits 2 with blocked message"
else
  echo "FAIL: unlaunchable CLI gave exit $rc, output: $out"
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

# Environment blocks on the transcript checks. They need a CLI with transcripts.
if [ -n "$working_hcn" ]; then
  case "$("$working_hcn" --help)" in
    *"transcript read"*)
      # A launcher that needs the caller's HOME starts for the help checks but
      # not under the transcript checks' isolated HOME: blocked, exit 3.
      {
        printf '#!/usr/bin/env bash\n'
        # shellcheck disable=SC2016 # the generated script expands $HOME
        printf 'if [ "$HOME" != %q ]; then echo "launcher needs HOME" >&2; exit 1; fi\n' "$HOME"
        printf 'exec %q "$@"\n' "$working_hcn"
      } >"$fixture_dir/home-launcher/hcn"
      chmod +x "$fixture_dir/home-launcher/hcn"
      out=$(env -u CHECK_CLAIMS_REQUIRE_SNAPSHOT HCN_BIN="$fixture_dir/home-launcher/hcn" \
        /bin/bash "$script" 2>&1)
      rc=$?
      case "$out" in
        *"blocked: transcript checks:"*"isolated HOME"*) found=1 ;;
        *) found=0 ;;
      esac
      if [ "$rc" -eq 3 ] && [ "$found" -eq 1 ]; then
        echo "ok: HOME-dependent launcher blocks the transcript checks with exit 3"
      else
        echo "FAIL: HOME-dependent launcher gave exit $rc, output: $out"
        fails=$((fails + 1))
      fi

      # Find a writable directory that cannot take a copy-on-write clone:
      # tmpfs on Linux, a small HFS+ disk image on macOS.
      case "$(uname -s)" in
        Linux)
          if [ -d /dev/shm ] && [ -w /dev/shm ]; then
            candidate=$(mktemp -d /dev/shm/hcn-noclone.XXXXXX)
            echo probe >"$candidate/a"
            if cp --reflink=always "$candidate/a" "$candidate/b" 2>/dev/null; then
              rm -rf "$candidate"
            else
              rm -f "$candidate/a"
              noclone_dir=$candidate
            fi
          fi
          ;;
        Darwin)
          if command -v hdiutil >/dev/null 2>&1 &&
            hdiutil create -size 16m -fs HFS+ -volname hcn-noclone -quiet "$fixture_dir/noclone.dmg" &&
            mkdir "$fixture_dir/noclone" &&
            hdiutil attach -nobrowse -mountpoint "$fixture_dir/noclone" -quiet "$fixture_dir/noclone.dmg"; then
            noclone_mount="$fixture_dir/noclone"
            noclone_dir="$noclone_mount"
          fi
          ;;
      esac
      if [ -n "$noclone_dir" ]; then
        # Portable checks pass; snapshot checks report blocked; exit 3, not 1.
        out=$(env -u CHECK_CLAIMS_REQUIRE_SNAPSHOT TMPDIR="$noclone_dir" HCN_BIN="$working_hcn" \
          /bin/bash "$script" 2>&1)
        rc=$?
        case "$out" in
          *"blocked: snapshot checks"*) found=1 ;;
          *) found=0 ;;
        esac
        if [ "$rc" -eq 3 ] && [ "$found" -eq 1 ] && [ "${out#*MISS:}" = "$out" ]; then
          echo "ok: clone-incapable TMPDIR blocks only the snapshot checks with exit 3"
        else
          echo "FAIL: clone-incapable TMPDIR gave exit $rc, output: $out"
          fails=$((fails + 1))
        fi

        # The opt-in turns the blocked snapshot checks into a failure.
        CHECK_CLAIMS_REQUIRE_SNAPSHOT=1 TMPDIR="$noclone_dir" HCN_BIN="$working_hcn" \
          /bin/bash "$script" >/dev/null 2>&1
        rc=$?
        if [ "$rc" -eq 1 ]; then
          echo "ok: CHECK_CLAIMS_REQUIRE_SNAPSHOT=1 turns blocked snapshot checks into exit 1"
        else
          echo "FAIL: required snapshot checks on a clone-incapable TMPDIR gave exit $rc"
          fails=$((fails + 1))
        fi

        # A claim mismatch still exits 1 when snapshot checks are blocked.
        env -u CHECK_CLAIMS_REQUIRE_SNAPSHOT CHECK_CLAIMS_EXTRA="no-such-flag-injected-by-test" \
          TMPDIR="$noclone_dir" HCN_BIN="$working_hcn" /bin/bash "$script" >/dev/null 2>&1
        rc=$?
        if [ "$rc" -eq 1 ]; then
          echo "ok: a claim mismatch outranks blocked snapshot checks"
        else
          echo "FAIL: claim mismatch with blocked snapshot checks gave exit $rc, want 1"
          fails=$((fails + 1))
        fi
      else
        echo "skip: no clone-incapable filesystem available, blocked-snapshot tests not run"
      fi
      ;;
  esac
fi

if [ "$fails" -gt 0 ]; then
  exit 1
fi
echo "all check-claims tests passed"
exit 0
