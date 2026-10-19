import { spawnSync } from "node:child_process";
import { constants } from "node:os";
import { dirname, join } from "node:path";
import { ownerFailure, resolveOwner } from "./git-context.ts";

// Deployed by setup:hooks to <git-common-dir>/hcn-hooks/runtime/ and run by the hook shims.
// Jobs run in the committing checkout with Git's hook environment, stdin and arguments intact.

const runtime = import.meta.dirname;
const [hook, ...args] = process.argv.slice(2);
if (!hook) {
  console.error("hook-dispatch: missing hook name");
  process.exit(1);
}
const owner = resolveOwner(dirname(dirname(runtime)));
if (owner.kind !== "registered") {
  console.error(ownerFailure(owner, "hook-dispatch"));
  process.exit(1);
}
// --no-auto-install also covers branches whose lefthook.yml predates no_auto_install.
const child = spawnSync(
  join(runtime, "lefthook"),
  ["run", "--no-auto-install", hook, "--", ...args],
  {
    stdio: "inherit",
  },
);
if (child.error) {
  console.error(
    `hook-dispatch: cannot run the managed Lefthook (${child.error.message})\nRun \`pnpm setup:hooks\` from ${JSON.stringify(owner.root)}.`,
  );
  process.exit(1);
}
const signal = child.signal ? constants.signals[child.signal] : undefined;
process.exit(child.status ?? 128 + (signal ?? 0));
