import { execFileSync } from "node:child_process";
import { join } from "node:path";

// Linked worktrees have a .git file. Their hooks belong to the common directory.
const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
  encoding: "utf8",
}).trim();
execFileSync("git", ["config", "--local", "core.hooksPath", join(common, "hooks")]);
execFileSync("lefthook", ["install", "--force"], { stdio: "inherit" });
