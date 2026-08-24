/**
 * The combined harness check: version drift and live re-verification in
 * one run.
 *
 * 1. For every descriptor, look up the latest published version and the
 *    locally installed version (lib/harness-versions.ts).
 * 2. A harness is DUE when the installed CLI differs from `verifiedAgainst`.
 *    For each due harness, run the seven scenarios and the escalation probe
 *    against the installed CLI and report pass/fail per descriptor claim.
 * 3. A harness whose published latest is newer but whose installed CLI still
 *    equals `verifiedAgainst` gets one action line: install the new version,
 *    then re-run. Nothing is re-verified against a CLI that is not here.
 * 4. With --bump, a due harness whose claims all pass has `verifiedAgainst`
 *    and `escalation.observedOn` rewritten in its descriptor file. Fixture
 *    re-capture stays manual and is named in the output.
 *
 * Live model turns: needs the CLIs installed and authenticated, runs only
 * locally, never in CI. Evidence -> .smoke/check-harnesses.json.
 *
 *   bun run check:harnesses                   # due harnesses only
 *   bun run check:harnesses --all             # every installed harness
 *   bun run check:harnesses --harness codex   # one harness, due or not
 *   bun run check:harnesses --bump            # rewrite the anchors on a full pass
 *   bun run check:harnesses --json            # machine output
 *
 * Exit 1 when any claim failed; exit 0 otherwise, including when nothing
 * was due.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { compareVersions } from "../src/interpretation/versions.js";
import { claudeCode } from "../src/knowledge/claude-code.js";
import { codexCli } from "../src/knowledge/codex.js";
import type { HarnessDescriptor } from "../src/knowledge/descriptor.js";
import { museCode } from "../src/knowledge/muse.js";
import { piCli } from "../src/knowledge/pi.js";
import { collectVersionRows, type VersionRow } from "./lib/harness-versions.js";
import { type ProbeCell, probeAsk } from "./lib/question-probe.js";
import { type Cell, runScenarios, SCENARIOS, withTimeout } from "./lib/seven-scenarios.js";

delete process.env.HERDR_ENV;

const HARNESSES: HarnessDescriptor[] = [claudeCode, codexCli, piCli, museCode];

const { values: flags } = parseArgs({
  args: process.argv.slice(2),
  options: {
    all: { type: "boolean", default: false },
    harness: { type: "string" },
    bump: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
  },
  strict: true,
});

if (flags.harness !== undefined && !HARNESSES.some((h) => h.name === flags.harness)) {
  console.error(
    `unknown harness "${flags.harness}"; one of ${HARNESSES.map((h) => h.name).join(", ")}`,
  );
  process.exit(2);
}

type Due = "due" | "install" | "current" | "absent";

interface Verification {
  version: string;
  scenarios: Record<string, Cell>;
  escalation: ProbeCell;
  allPassed: boolean;
}

interface Report {
  checkedAt: string;
  versions: VersionRow[];
  due: Record<string, Due>;
  verified: Record<string, Verification>;
  bumped: string[];
}

const dueOf = (row: VersionRow): Due => {
  if (row.installed === null) return "absent";
  if (row.installed !== row.verifiedAgainst) return "due";
  if (row.status === "behind") return "install";
  return "current";
};

const selected = (h: HarnessDescriptor, due: Due): boolean => {
  if (due === "absent") return false;
  if (flags.harness !== undefined) return h.name === flags.harness;
  if (flags.all) return true;
  return due === "due";
};

const descriptorFile = (h: HarnessDescriptor): string =>
  `src/knowledge/${h.name === "claude" ? "claude-code" : h.name}.ts`;

/** Rewrite `verifiedAgainst` and the single-line `escalation.observedOn`
 * record in the descriptor source. Both are matched by shape, so a
 * descriptor that moves either off one line makes this refuse loudly
 * instead of editing the wrong text. */
const bumpDescriptor = (h: HarnessDescriptor, v: Verification): string[] => {
  const file = descriptorFile(h);
  let src = readFileSync(file, "utf8");
  const notes: string[] = [];

  const anchor = new RegExp(`verifiedAgainst: "${h.verifiedAgainst.replace(/\./g, "\\.")}"`);
  if (!anchor.test(src)) {
    throw new Error(`${file}: verifiedAgainst: "${h.verifiedAgainst}" not found on one line`);
  }
  src = src.replace(anchor, `verifiedAgainst: "${v.version}"`);
  notes.push(`verifiedAgainst ${h.verifiedAgainst} -> ${v.version}`);

  const obs = v.escalation.observedOn;
  if (obs !== undefined) {
    const record =
      /observedOn: \{ harness: "[^"]*", model: "[^"]*", version: "[^"]*", date: "[^"]*" \}/;
    if (!record.test(src)) {
      throw new Error(`${file}: escalation.observedOn not found as a one-line record`);
    }
    src = src.replace(
      record,
      `observedOn: { harness: "${obs.harness}", model: "${obs.model}", version: "${obs.version}", date: "${obs.date}" }`,
    );
    notes.push(`escalation.observedOn -> ${obs.version} on ${obs.date}`);
  }

  writeFileSync(file, src);
  return notes;
};

// 1. Versions.
const rows = await collectVersionRows(HARNESSES);
const byName = new Map(rows.map((r) => [r.harness, r]));
const due: Record<string, Due> = {};
for (const r of rows) due[r.harness] = dueOf(r);

const log = (line = ""): void => {
  if (!flags.json) console.log(line);
};

log();
log(
  `${"harness".padEnd(9)}${"verified".padEnd(12)}${"installed".padEnd(12)}${"latest".padEnd(12)}state`,
);
for (const r of rows) {
  const state = due[r.harness];
  const note =
    state === "due"
      ? compareVersions(r.installed ?? "0", r.verifiedAgainst) > 0
        ? "due: installed is newer than verified"
        : "due: installed is older than verified"
      : state === "install"
        ? `behind: install ${r.latest}, then re-run`
        : state === "absent"
          ? "not installed"
          : "current";
  log(
    `${r.harness.padEnd(9)}${r.verifiedAgainst.padEnd(12)}${(r.installed ?? "-").padEnd(12)}${(r.latest ?? "?").padEnd(12)}${note}`,
  );
}

// 2. Re-verify the selected harnesses.
const verified: Record<string, Verification> = {};
const targets = HARNESSES.filter((h) => selected(h, due[h.name] ?? "absent"));

if (targets.length === 0) {
  log();
  log(
    flags.harness !== undefined
      ? `${flags.harness} is not installed; nothing to verify.`
      : "nothing due: every installed CLI matches its verifiedAgainst.",
  );
}

for (const h of targets) {
  const row = byName.get(h.name);
  const version = row?.installed;
  if (version === undefined || version === null) continue;
  log();
  log(`${h.name} ${version}`);
  log(`  ${"claim".padEnd(46)}${"scenario".padEnd(22)}result`);

  const scenarios = await runScenarios(h);
  for (const s of SCENARIOS) {
    const c = scenarios[s.name] ?? { status: "fail", detail: "no result" };
    const mark = c.status === "pass" ? "✓" : c.status === "skip" ? "–" : "✗";
    log(`  ${s.claim.padEnd(46)}${s.name.padEnd(22)}${mark} ${c.detail}`);
  }

  let escalation: ProbeCell;
  try {
    escalation = await withTimeout(probeAsk(h, version));
  } catch (cause) {
    escalation = { status: "fail", detail: String(cause).slice(0, 120) };
  }
  const emark = escalation.status === "pass" ? "✓" : escalation.status === "skip" ? "–" : "✗";
  log(
    `  ${"escalation.supported".padEnd(46)}${"escalation".padEnd(22)}${emark} ${escalation.detail}`,
  );

  const allPassed =
    Object.values(scenarios).every((c) => c.status !== "fail") && escalation.status !== "fail";
  verified[h.name] = { version, scenarios, escalation, allPassed };
}

// 3. Bump where asked and earned.
const bumped: string[] = [];
for (const h of targets) {
  const v = verified[h.name];
  if (v === undefined) continue;
  if (v.version === h.verifiedAgainst) {
    log();
    log(`${h.name}: every claim holds on ${v.version}; verifiedAgainst already matches.`);
    continue;
  }
  if (!v.allPassed) {
    const failed = [
      ...SCENARIOS.filter((s) => v.scenarios[s.name]?.status === "fail").map((s) => s.claim),
      ...(v.escalation.status === "fail" ? ["escalation.supported"] : []),
    ];
    log();
    log(`${h.name}: ${failed.length} claim(s) failed on ${v.version}: ${failed.join("; ")}`);
    log(
      `  fix the claim (${descriptorFile(h)} or the runner) and re-run; verifiedAgainst stays ${h.verifiedAgainst}.`,
    );
    continue;
  }
  log();
  if (flags.bump) {
    for (const note of bumpDescriptor(h, v)) log(`${h.name}: ${note}`);
    log(`  re-capture fixtures under test/fixtures/ for ${v.version}, then run pnpm check.`);
    bumped.push(h.name);
  } else {
    log(
      `${h.name}: every claim holds on ${v.version}; re-run with --bump to write it into ${descriptorFile(h)}.`,
    );
  }
}

const report: Report = {
  checkedAt: new Date().toISOString(),
  versions: rows,
  due,
  verified,
  bumped,
};
mkdirSync(".smoke", { recursive: true });
writeFileSync(".smoke/check-harnesses.json", JSON.stringify(report, null, 2));
if (flags.json) console.log(JSON.stringify(report, null, 2));

const anyFailed = Object.values(verified).some((v) => !v.allPassed);
process.exit(anyFailed ? 1 : 0);
