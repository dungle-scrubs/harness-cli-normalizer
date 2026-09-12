import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const source = join(root, "src/execution/transcript/native/clone.c");
const targets = ["darwin-universal", "linux-x64", "linux-arm64"];
const current =
  process.platform === "darwin" ? "darwin-universal" : `${process.platform}-${process.arch}`;
const release = process.argv.includes("--release");
const sha256 = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
const sourceSha256 = sha256(source);
const builderSha256 = sha256(fileURLToPath(import.meta.url));

function verified(target: string): boolean {
  const directory = join(root, ".native-artifacts", target);
  try {
    const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8")) as {
      executableSha256: string;
      sourceSha256: string;
      builderSha256: string;
      target: string;
    };
    return (
      manifest.target === target &&
      manifest.sourceSha256 === sourceSha256 &&
      manifest.builderSha256 === builderSha256 &&
      manifest.executableSha256 === sha256(join(directory, "hcn-transcript-clone"))
    );
  } catch {
    return false;
  }
}

if (!release && targets.includes(current) && !verified(current)) {
  const directory = join(root, ".native-artifacts", current);
  mkdirSync(directory, { recursive: true });
  const executable = join(directory, "hcn-transcript-clone");
  const compiler = spawnSync(
    "cc",
    [
      "-Wall",
      "-Wextra",
      "-Werror",
      "-O2",
      ...(process.platform === "darwin"
        ? ["-arch", "arm64", "-arch", "x86_64", "-mmacosx-version-min=11.0"]
        : ["-static"]),
      source,
      "-o",
      executable,
    ],
    { encoding: "utf8", timeout: 30000 },
  );
  assert.equal(
    compiler.status,
    0,
    compiler.stderr || compiler.error?.message || "Native compiler failed",
  );
  writeFileSync(
    join(directory, "manifest.json"),
    `${JSON.stringify(
      {
        executableSha256: sha256(executable),
        sourceSha256,
        builderSha256,
        target: current,
      },
      null,
      2,
    )}\n`,
  );
}

if (release || process.argv.includes("--stage")) {
  for (const target of targets) {
    const directory = join(root, ".native-artifacts", target);
    if (!existsSync(directory)) {
      assert.ok(!release, `Release snapshot helper missing: ${target}`);
      continue;
    }
    assert.ok(verified(target), `Snapshot helper source or binary mismatch: ${target}`);
    const destination = join(root, "dist/execution/transcript/native", target);
    mkdirSync(destination, { recursive: true });
    cpSync(directory, destination, { recursive: true });
    chmodSync(join(destination, "hcn-transcript-clone"), 0o755);
  }
}
