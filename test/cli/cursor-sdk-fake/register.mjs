// Test-only module loader (issue #440): maps the "@cursor/sdk" specifier
// onto the scripted fake below, so built-CLI tests exercise the REAL
// worker (dist/execution/cursor-sdk-worker.js) end to end without network,
// credentials, or billed runs. Registered through NODE_OPTIONS="--import
// <register.mjs>" which the spawned CLI passes to its worker child. This
// file ships in test/fixtures only; the production worker has no
// environment knob that could swap its SDK.
import { register } from "node:module";

register(new URL("./fake-sdk-loader.mjs", import.meta.url));
