import { checkTaskState } from "./task-state.ts";

try {
  const errors = checkTaskState(process.cwd());
  if (errors.length > 0) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  }
} catch {
  console.error(
    "task-state: cannot inspect checkout structure\nCheck directory access and retry; no files were changed.",
  );
  process.exitCode = 1;
}
