import { execFileSync } from "node:child_process";
import { type VersionStatus, versionStatus } from "../interpretation/versions.js";
import type { HarnessDescriptor } from "../knowledge/descriptor.js";
import { defaultDescriptors } from "../knowledge/overrides.js";

interface Row {
  harness: string;
  bin: string;
  verifiedAgainst: string;
  latest: string | null;
  source: string;
  status: VersionStatus;
}

const npmLatest = async (pkg: string): Promise<string | null> => {
  try {
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
    const match = out.match(/\d+\.\d+\.\d+(?:[.+-][0-9A-Za-z.-]+)?/);
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

export const check = async (rawArgs: string[]): Promise<void> => {
  const wantJson = rawArgs.includes("--json");
  const wantHelp = rawArgs.includes("--help") || rawArgs.includes("-h");
  if (wantHelp) {
    const { CHECK_HELP } = await import("./help.js");
    process.stdout.write(CHECK_HELP);
    return;
  }

  const descriptors = Object.values(defaultDescriptors()).filter(
    (d): d is HarnessDescriptor => d !== undefined,
  );

  const rows: Row[] = await Promise.all(
    descriptors.map(async (h) => {
      const { latest, source } = await resolveLatest(h);
      return {
        harness: h.name,
        bin: h.bin,
        verifiedAgainst: h.verifiedAgainst,
        latest,
        source,
        status: versionStatus(h.verifiedAgainst, latest),
      };
    }),
  );

  const behind = rows.filter((r) => r.status === "behind");
  const unknown = rows.filter((r) => r.status === "unknown");

  if (wantJson) {
    process.stdout.write(
      `${JSON.stringify({ checkedAt: new Date().toISOString(), rows, behind: behind.map((r) => r.harness) }, null, 2)}\n`,
    );
  } else {
    const mark = (s: VersionStatus) =>
      s === "ok" ? "✓ ok" : s === "behind" ? "⬆ NEW" : s === "ahead" ? "? ahead" : "– unknown";
    process.stdout.write(
      `\n${"harness".padEnd(9)}${"verified".padEnd(12)}${"latest".padEnd(12)}status\n`,
    );
    for (const r of rows) {
      process.stdout.write(
        `${r.harness.padEnd(9)}${r.verifiedAgainst.padEnd(12)}${(r.latest ?? "?").padEnd(12)}${mark(r.status)}\n`,
      );
    }
    if (behind.length > 0) {
      process.stdout.write(
        `\n${behind.length} harness(es) behind: ${behind.map((r) => `${r.harness} ${r.verifiedAgainst}→${r.latest}`).join(", ")}\n`,
      );
      process.stdout.write(
        "Run the local capability tripwires (smoke:seven) against the new version, then file an issue + bump verifiedAgainst.\n",
      );
    } else if (unknown.length > 0) {
      process.stdout.write(`\n${unknown.length} harness(es) unknown (network or missing bin)\n`);
    } else {
      process.stdout.write("\nall descriptors current with their published versions.\n");
    }
  }

  // Exit logic: behind => 1, unknown (network failure) => 1 with partial results, else 0
  // But we must not exit 1 for unknown if behind already counts? We'll handle:
  if (behind.length > 0) {
    process.exitCode = 1;
  } else if (unknown.length > 0 && rows.some((r) => r.latest === null)) {
    // network failure at least one
    // Per spec: network failure prints warning and exits 1 with partial results
    // We'll check if any latest is null and that we attempted npm fetch (could be network)
    // Simpler: if unknown and not all ok, exit 1
    // But spec says check should reuse versions.ts and not crash; exit 1 with partial results
    // We'll exit 1 if any harness has unknown and at least one npm source failed - but we can't distinguish installed missing vs network.
    // For now, exit 1 if unknown.length >0 and at least one behind==0? Actually spec says network failure => exit 1.
    // We'll exit 1 if unknown includes npm harnesses (they shouldn't be unknown without network).
    const npmUnknown = rows.filter((r) => r.source.startsWith("npm:") && r.status === "unknown");
    if (npmUnknown.length > 0) process.exitCode = 1;
    else if (behind.length === 0 && unknown.length > 0) {
      // installed unknown (muse missing) is not necessarily failure? But spec says network failure case is 1.
      // For installed missing, we treat as unknown but not failure - keep 0 to not break CI where muse not installed.
      // However spec says check prints partial results and exits 1 on network failure.
      // We'll only exit 1 for npmUnknown, otherwise 0.
      process.exitCode = 0;
    }
  } else {
    process.exitCode = 0;
  }
};
