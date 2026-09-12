#!/bin/sh
# Re-capture the claude evidence (needs a logged-in claude; runs 3 turns).
set -e
d="$(dirname "$0")"
cd "$d"
extract_init() {
  python3 -c "
import json,sys
for line in sys.stdin:
    try: d=json.loads(line)
    except: continue
    if d.get('subtype')=='init':
        print(json.dumps(d, indent=2, sort_keys=True)); break
"
}
CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 claude -p --output-format stream-json --verbose --effort medium "say exactly: ok" 2>/dev/null | extract_init > claude-disabled-init.ndjson
CLAUDE_CODE_DISABLE_AUTO_MEMORY=false claude -p --output-format stream-json --verbose --effort medium "say exactly: ok" 2>/dev/null | extract_init > claude-false-init.ndjson
claude -p --output-format stream-json --verbose --effort medium "say exactly: ok" 2>/dev/null | extract_init > claude-bare-init.ndjson
echo "recaptured; check: disabled must lack memory_paths, bare and =false must carry it"
