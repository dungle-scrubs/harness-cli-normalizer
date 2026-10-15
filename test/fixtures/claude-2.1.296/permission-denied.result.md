# Denied Bash call, terminal result

`permission-denied.result.ndjson` is one complete terminal `result` record captured from Claude Code 2.1.296 on macOS on 2026-10-15. It is not a full process transcript. Every field in the selected record is unchanged.

The isolated probe asked Claude to run this Bash command once, without retrying or using another tool:

```sh
node -e "require('node:fs').writeFileSync('marker.txt', 'hcn-write-probe\n')"
```

The invocation used headless stream-json, `--safe-mode`, empty setting sources and no autonomy. At the time, hcn's Claude write preset emitted no permission controls. The Bash call was denied, and the marker was absent. Claude reported `is_error: false` and a nonempty `permission_denials` array in its terminal result.

Only the terminal record was selected. Startup hooks and initialization records, which included operator configuration, are not part of this fixture. No selected field was redacted or synthesized. The CLI regression replays this native record to check the denial observation and terminal count, not permission enforcement.
