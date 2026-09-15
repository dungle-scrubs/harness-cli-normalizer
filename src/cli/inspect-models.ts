/**
 * `hcn inspect <harness> --models`: project pi's installed stores into
 * provider/model pairs (RFC-27 ticket 01). Impure by necessity - it reads
 * two files - so it lives in the CLI layer beside the transcript path,
 * reusing that path's PI_CODING_AGENT_DIR resolution.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { installedModelPairs } from "../interpretation/installed-models.js";
import { EXIT_REFUSAL } from "./exit-codes.js";
import { refuse } from "./refuse.js";

const readStore = (path: string): { readonly value: unknown; readonly read: boolean } => {
  try {
    if (!existsSync(path)) return { value: null, read: false };
    return { value: JSON.parse(readFileSync(path, "utf8")) as unknown, read: true };
  } catch {
    return { value: null, read: false };
  }
};

export const inspectModelsCommand = (harnessName: string, wantJson: boolean): void => {
  if (harnessName !== "pi") {
    refuse(
      {
        issue: "invalid-option-value",
        message: `--models is supported for pi only; ${harnessName} has no installed-model stores`,
      },
      wantJson,
    );
    return;
  }
  const dir = resolve(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi"));
  const agentDir = resolve(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"));
  const custom = readStore(join(dir, "models.json"));
  const builtin = readStore(join(dir, "models-store.json"));
  const builtinAgent =
    agentDir === dir
      ? { value: null, read: false }
      : readStore(join(agentDir, "models-store.json"));
  const skipped: string[] = [];
  if (!custom.read) skipped.push("models.json");
  if (!builtin.read && !builtinAgent.read) skipped.push("models-store.json");
  const models = installedModelPairs({
    custom: custom.value,
    builtin: builtin.read ? builtin.value : builtinAgent.value,
  });
  if (!wantJson) {
    if (models.length === 0) {
      process.stdout.write("No installed pi models found.\n");
      process.exitCode = EXIT_REFUSAL;
      return;
    }
    process.stdout.write("provider\tmodel\n");
    for (const pair of models) process.stdout.write(`${pair.provider}\t${pair.model}\n`);
    return;
  }
  process.stdout.write(
    `${JSON.stringify({ v: 1, source: models.length > 0 || skipped.length === 0 ? "stores" : "unavailable", models, skipped })}\n`,
  );
};
