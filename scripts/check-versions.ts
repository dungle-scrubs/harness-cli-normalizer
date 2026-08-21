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
 * (and fixtures) are unverified for it - the trigger to run the local
 * capability tripwires and, if a claim flipped, file an issue + PR.
 * An "installed-mismatch" drift row means the locally installed CLI
 * version differs from verifiedAgainst - not a CI gate, but local signal.
 */
import { execFileSync } from "node:child_process";
import { type VersionStatus, versionStatus } from "../src/interpretation/versions.js";
import type { HarnessDescriptor } from "../src/knowledge/descriptor.js";
import { defaultDescriptors } from "../src/knowledge/overrides.js";

interface Row {
  harness: string;
  bin: string;
  verifiedAgainst: string;
  latest: string | null;
  source: string;
  status: VersionStatus;
  installed: string | null;
}

const npmLatest = async (pkg: string): Promise<string | null> => {
  try {
    // The packument (not the /latest tag endpoint, which does not route for
    // scoped names); the abbreviated form still carries dist-tags.
    const res = await fetch(`https://registry.npmjs.org/${pkg}`, {
      headers: { accept: "application/vnd.npm.install-v1+json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { "dist-tags"?: { latest?: unknown } };
    const latest = body["dist-tags"]?.latest;
    return typeof latest === "string" ? latest : null;
  } catch {
    return null;
  }
};

const installedVersion = (bin: string): string | null => {
  try {
    const out = execFileSync(bin, ["--version"], { encoding: "utf8", timeout: 10_000 });
    const match = out.match(/\d+\.\d+\.\d+(?:[.\-+][0-9A-Za-z.-]+)?/);
    return match ? match[0] : null;
  } catch {
    return null;
  }
};

const resolveLatest = async (
  h: HarnessDescriptor,
): Promise<{ latest: string | null; source: string }> => {
  if (h.versionSource.kind === "npm") {
    return {
      latest: await npmLatest(h.versionSource.package),
      source: `npm:${h.versionSource.package}`,
    };
  }
  return { latest: installedVersion(h.bin), source: `installed:${h.bin}` };
};

const descriptors = Object.values(defaultDescriptors()).filter(
  (d): d is HarnessDescriptor => d !== undefined,
);

const rows: Row[] = await Promise.all(
  descriptors.map(async (h) => {
    const { latest, source } = await resolveLatest(h);
    const installed = installedVersion(h.bin);
    let status = versionStatus(h.verifiedAgainst, latest);
    if (installed !== null && installed !== h.verifiedAgainst && status !== "behind") {
      status = "drift";
    }
    return {
      harness: h.name,
      bin: h.bin,
      verifiedAgainst: h.verifiedAgainst,
      latest,
      source,
      status,
      installed,
    };
  }),
);

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
      "Run the local capability tripwires (smoke:seven) against the new version, then file an issue + bump verifiedAgainst.",
    );
  } else if (drift.length === 0) {
    console.log("\nall descriptors current with their published versions.");
  }
}

// Exit nonzero when a newer version shipped, so a CI step can gate/notify.
// Drift (installed != verifiedAgainst) is informational only - does not gate CI.
process.exit(behind.length > 0 ? 1 : 0);
