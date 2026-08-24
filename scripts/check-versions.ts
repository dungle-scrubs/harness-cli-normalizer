/**
 * Harness-update detector (the free, no-inference half of the pipeline):
 * for each descriptor, compare `verifiedAgainst` to the latest PUBLISHED
 * version and report drift. npm sources are a pure registry fetch
 * (credential-free, CI-friendly); `installed` sources (muse) fall back to
 * the local `<bin> --version` and are skipped where the CLI is absent.
 *
 *   bun run check:versions          # table + exit 1 if any harness is behind
 *   bun run check:versions --json   # machine output for CI to open an issue
 *
 * A "behind" row means a newer version shipped, so the descriptor's facts
 * (and fixtures) are unverified for it - the trigger to install it and run
 * `check:harnesses`, which re-verifies the claims and can bump the anchor.
 * An "installed-mismatch" drift row means the locally installed CLI
 * version differs from verifiedAgainst - not a CI gate, but local signal.
 */
import type { VersionStatus } from "../src/interpretation/versions.js";
import type { HarnessDescriptor } from "../src/knowledge/descriptor.js";
import { defaultDescriptors } from "../src/knowledge/overrides.js";
import { collectVersionRows } from "./lib/harness-versions.js";

const descriptors = Object.values(defaultDescriptors()).filter(
  (d): d is HarnessDescriptor => d !== undefined,
);

const rows = await collectVersionRows(descriptors);

const behind = rows.filter((r) => r.status === "behind");
const drift = rows.filter((r) => r.status === "drift");

if (process.argv.includes("--json")) {
  console.log(
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        rows,
        behind: behind.map((r) => r.harness),
        drift: drift.map((r) => r.harness),
      },
      null,
      2,
    ),
  );
} else {
  const mark = (s: VersionStatus) =>
    s === "ok"
      ? "✓ ok"
      : s === "behind"
        ? "⬆ NEW"
        : s === "ahead"
          ? "? ahead"
          : s === "drift"
            ? "◐ drift"
            : "– unknown";
  console.log(
    `\n${"harness".padEnd(9)}${"verified".padEnd(12)}${"latest".padEnd(12)}${"installed".padEnd(12)}status`,
  );
  for (const r of rows) {
    console.log(
      `${r.harness.padEnd(9)}${r.verifiedAgainst.padEnd(12)}${(r.latest ?? "?").padEnd(12)}${(r.installed ?? "?").padEnd(12)}${mark(r.status)}`,
    );
  }
  if (drift.length > 0) {
    console.log(
      `\n${drift.length} harness(es) drift (installed != verifiedAgainst): ${drift.map((r) => `${r.harness} ${r.verifiedAgainst}→${r.installed}`).join(", ")}`,
    );
  }
  if (behind.length > 0) {
    console.log(
      `\n${behind.length} harness(es) behind: ${behind.map((r) => `${r.harness} ${r.verifiedAgainst}→${r.latest}`).join(", ")}`,
    );
    console.log(
      "Install the new version, then run `bun run check:harnesses` to re-verify the descriptor against it.",
    );
  } else if (drift.length === 0) {
    console.log("\nall descriptors current with their published versions.");
  }
}

// Exit nonzero when a newer version shipped, so a CI step can gate/notify.
// Drift (installed != verifiedAgainst) is informational only - does not gate CI.
process.exit(behind.length > 0 ? 1 : 0);
