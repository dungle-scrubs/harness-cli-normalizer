import { inspectHookSetup } from "./hook-state.ts";

try {
  const errors = inspectHookSetup(process.cwd());
  if (errors.length > 0) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  }
} catch {
  console.error(
    "hook-setup: cannot inspect the Git hook setup\nRun from a Git checkout and retry; no files were changed.",
  );
  process.exitCode = 1;
}
