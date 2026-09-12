import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { env } from "node:process";
import { expect, test } from "vitest";
import { claudeCode } from "../../src/knowledge/claude-code.js";

test.each(
  ["claude", "pi"].flatMap((harness) =>
    ["0.0.0", "999.0.0", "unusable version"].map((version) => ({ harness, version })),
  ),
)(
  "$harness persistent resume retains its grammar across version changes: $version",
  ({ harness, version }) => {
    const dir = mkdtempSync(join(tmpdir(), "hcn-runtime-session-"));
    writeFileSync(join(dir, harness), `#!/bin/sh\nprintf '%s\\n' '${version}'\n`, { mode: 0o700 });
    try {
      const result = spawnSync(
        "bun",
        [
          resolve("src/cli/index.ts"),
          "inspect",
          harness,
          "--runtime",
          "--mode",
          "headless-session",
          "--resume",
          "11111111-1111-4111-8111-111111111111",
          "--effort",
          "high",
        ],
        {
          cwd: dir,
          encoding: "utf8",
          timeout: 30_000,
          env: {
            HOME: dir,
            XDG_CONFIG_HOME: dir,
            PATH: `${dir}:${env.PATH ?? ""}`,
          },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      const facts = JSON.parse(result.stdout);
      expect(facts.resume).toEqual({ status: "supported", reason: null });
      expect(facts.argv).toContain(harness === "claude" ? "--input-format" : "rpc");
      expect(facts.argv).toContain(harness === "claude" ? "--resume" : "--session-id");
      expect(facts.argv).not.toContain("[prompt:5ch]");
      expect(result.stderr).not.toContain("[prompt:");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("runtime inspection checks the selected executable and renders a same-session model change without a turn", () => {
  const dir = mkdtempSync(join(tmpdir(), "hcn-runtime-"));
  const executable = join(dir, "claude");
  const calls = join(dir, "calls");
  writeFileSync(
    executable,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nif [ "$1" = '--version' ]; then printf '%s\\n' '${claudeCode.verifiedAgainst}'; else exit 73; fi\n`,
    { mode: 0o700 },
  );
  try {
    const result = spawnSync(
      "bun",
      [
        resolve("src/cli/index.ts"),
        "inspect",
        "claude",
        "--runtime",
        "--resume",
        "11111111-1111-4111-8111-111111111111",
        "--model",
        "opus",
        "--effort",
        "high",
        "--prompt",
        "Check resume",
      ],
      {
        cwd: dir,
        encoding: "utf8",
        timeout: 30_000,
        env: {
          ...process.env,
          HOME: dir,
          XDG_CONFIG_HOME: dir,
          PATH: `${dir}:${process.env.PATH}`,
        },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    const facts = JSON.parse(result.stdout);
    expect(facts).toMatchObject({
      v: 1,
      executable: { path: realpathSync(executable), version: claudeCode.verifiedAgainst },
      resume: { status: "supported" },
    });
    expect(facts.argv).toContain("--resume");
    expect(facts.argv).toContain("11111111-1111-4111-8111-111111111111");
    expect(facts.argv).toContain("--model");
    expect(readFileSync(calls, "utf8").trim()).toBe("--version");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.each(["0.0.0", "unusable version"])(
  "Claude headless-turn invocation ignores version metadata: %s",
  (version) => {
    const dir = mkdtempSync(join(tmpdir(), "hcn-runtime-path-"));
    const selected = join(dir, "selected");
    mkdirSync(selected);
    writeFileSync(
      join(dir, "claude"),
      `#!/bin/sh\nprintf '%s\\n' '${claudeCode.verifiedAgainst}'\n`,
      { mode: 0o700 },
    );
    writeFileSync(join(selected, "claude"), `#!/bin/sh\nprintf '%s\\n' '${version}'\n`, {
      mode: 0o700,
    });
    try {
      const result = spawnSync(
        "bun",
        [
          resolve("src/cli/index.ts"),
          "inspect",
          "claude",
          "--runtime",
          "--prompt",
          "Check",
          "--env",
          `PATH=${selected}`,
        ],
        {
          cwd: dir,
          encoding: "utf8",
          timeout: 30_000,
          env: {
            HOME: dir,
            XDG_CONFIG_HOME: dir,
            PATH: `${dir}:${env.PATH ?? ""}`,
          },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        executable: {
          path: realpathSync(join(selected, "claude")),
          version: version === "0.0.0" ? version : null,
        },
        resume: { status: "supported" },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test.each(
  ["claude", "codex", "pi", "muse"].flatMap((harness) =>
    ["0.0.0", "999.0.0", "unusable version"].map((version) => ({ harness, version })),
  ),
)("$harness headless-turn admission ignores version metadata: $version", ({ harness, version }) => {
  const dir = mkdtempSync(join(tmpdir(), "hcn-other-runtime-"));
  writeFileSync(join(dir, harness), `#!/bin/sh\nprintf '%s\\n' '${version}'\n`, { mode: 0o700 });
  try {
    const result = spawnSync(
      "bun",
      [resolve("src/cli/index.ts"), "inspect", harness, "--runtime", "--prompt", "Check"],
      {
        cwd: dir,
        encoding: "utf8",
        timeout: 30_000,
        env: { HOME: dir, XDG_CONFIG_HOME: dir, PATH: `${dir}:${env.PATH ?? ""}` },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      executable: {
        path: realpathSync(join(dir, harness)),
        version: version === "unusable version" ? null : version,
      },
      resume: { status: "supported", reason: null },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.each(["selected", "missing", ""])(
  "runtime inspection resolves only the selected relative PATH: %s",
  (searchPath) => {
    const dir = mkdtempSync(join(tmpdir(), "hcn-runtime-relative-"));
    mkdirSync(join(dir, "selected"));
    writeFileSync(join(dir, "claude"), `#!/bin/sh\nprintf '${claudeCode.verifiedAgainst}\\n'\n`, {
      mode: 0o700,
    });
    writeFileSync(join(dir, "selected", "claude"), "#!/bin/sh\nprintf '0.0.0\\n'\n", {
      mode: 0o700,
    });
    try {
      const result = spawnSync(
        "bun",
        [
          resolve("src/cli/index.ts"),
          "inspect",
          "claude",
          "--runtime",
          "--cwd",
          dir,
          "--prompt",
          "Check",
          "--env",
          `PATH=${searchPath}`,
        ],
        {
          encoding: "utf8",
          timeout: 30_000,
          env: {
            HOME: dir,
            XDG_CONFIG_HOME: dir,
            PATH: `${dir}:${env.PATH ?? ""}`,
          },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        executable:
          searchPath === "selected"
            ? { path: realpathSync(join(dir, "selected", "claude")), version: "0.0.0" }
            : { path: null, version: null },
        resume: { status: searchPath === "selected" ? "supported" : "unknown" },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("persistent inspection refuses a tool grant that session startup cannot apply", () => {
  const result = spawnSync(
    "bun",
    [
      resolve("src/cli/index.ts"),
      "inspect",
      "claude",
      "--runtime",
      "--mode",
      "headless-session",
      "--resume",
      "11111111-1111-4111-8111-111111111111",
      "--access",
      "read",
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("access");
  expect(result.stdout).toBe("");
});

test.each(["codex", "muse"])("%s still refuses unsupported persistent mode", (harness) => {
  const result = spawnSync(
    "bun",
    [
      resolve("src/cli/index.ts"),
      "inspect",
      harness,
      "--runtime",
      "--mode",
      "headless-session",
      "--resume",
      "11111111-1111-4111-8111-111111111111",
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  expect(result.status).toBe(2);
  expect(result.stdout).toBe("");
});

test.each(["claude", "codex", "pi", "muse"])(
  "%s invocation admission leaves native failure authoritative and never retries",
  (harness) => {
    const dir = mkdtempSync(join(tmpdir(), "hcn-operation-failure-"));
    const calls = join(dir, "calls");
    // Synthetic executable: future version metadata, broken native operation.
    writeFileSync(
      join(dir, harness),
      `#!/bin/sh\nif [ "$1" = '--version' ]; then printf '999.0.0\\n'; exit 0; fi\nprintf 'run\\n' >> '${calls}'\nprintf 'unsupported native operation\\n' >&2\nexit 73\n`,
      { mode: 0o700 },
    );
    const options = {
      cwd: dir,
      encoding: "utf8" as const,
      timeout: 30_000,
      env: { HOME: dir, XDG_CONFIG_HOME: dir, PATH: `${dir}:${env.PATH ?? ""}` },
    };
    try {
      const inspected = spawnSync(
        "bun",
        [
          resolve("src/cli/index.ts"),
          "inspect",
          harness,
          "--runtime",
          "--prompt",
          "Synthetic request",
        ],
        options,
      );
      expect(inspected.status, inspected.stderr).toBe(0);
      expect(JSON.parse(inspected.stdout).resume.status).toBe("supported");
      const run = spawnSync(
        "bun",
        [
          resolve("src/cli/index.ts"),
          "run",
          harness,
          "--json",
          "--questions",
          "none",
          "--prompt",
          "Synthetic request",
        ],
        options,
      );
      expect(run.status, run.stderr).toBe(1);
      const events = run.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(events).toContainEqual(
        expect.objectContaining({
          kind: "failure",
          class: "native",
          nativeExitCode: 73,
        }),
      );
      expect(events.at(-1)).toMatchObject({
        kind: "done",
        failure: { class: "native", nativeExitCode: 73 },
      });
      expect(readFileSync(calls, "utf8")).toBe("run\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test.each([
  { flags: [], configured: undefined, disabled: true, tier: "profile" },
  { flags: ["--memory"], configured: false, disabled: false, tier: "arg" },
  { flags: ["--no-memory"], configured: true, disabled: true, tier: "arg" },
  { flags: [], configured: true, disabled: false, tier: "user-config" },
])(
  "persistent inspection resolves memory like session startup: $tier $disabled",
  ({ flags, configured, disabled, tier }) => {
    const dir = mkdtempSync(join(tmpdir(), "hcn-session-memory-preview-"));
    const calls = join(dir, "calls");
    writeFileSync(
      join(dir, "claude"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nif [ "$1" = '--version' ]; then printf '999.0.0\\n'; else exit 73; fi\n`,
      { mode: 0o700 },
    );
    if (configured !== undefined)
      writeFileSync(join(dir, "config.json"), JSON.stringify({ version: 1, memory: configured }));
    try {
      const result = spawnSync(
        "bun",
        [
          resolve("src/cli/index.ts"),
          "inspect",
          "claude",
          "--runtime",
          "--mode",
          "headless-session",
          "--resume",
          "11111111-1111-4111-8111-111111111111",
          ...flags,
        ],
        {
          cwd: dir,
          encoding: "utf8",
          timeout: 30_000,
          env: {
            HOME: dir,
            HCN_CONFIG_DIR: dir,
            XDG_CONFIG_HOME: dir,
            PATH: `${dir}:${env.PATH ?? ""}`,
          },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr.includes("env: CLAUDE_CODE_DISABLE_AUTO_MEMORY=1")).toBe(disabled);
      expect(result.stderr).toContain(`provenance: memory = ${!disabled} (${tier})`);
      expect(JSON.parse(result.stdout).argv).toContain("--resume");
      expect(readFileSync(calls, "utf8").trim()).toBe("--version");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
