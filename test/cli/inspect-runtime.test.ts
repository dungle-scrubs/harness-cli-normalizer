import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { env } from "node:process";
import { expect, test } from "vitest";
import { claudeCode } from "../../src/knowledge/claude-code.js";

test.each([claudeCode.verifiedAgainst, "0.0.0"])(
  "persistent session resume retains version admission and its grammar: %s",
  (version) => {
    const dir = mkdtempSync(join(tmpdir(), "hcn-runtime-session-"));
    writeFileSync(join(dir, "claude"), `#!/bin/sh\nprintf '%s\\n' '${version}'\n`, { mode: 0o700 });
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
          "--model",
          "opus",
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
      expect(facts.resume.status).toBe(
        version === claudeCode.verifiedAgainst ? "supported" : "unknown",
      );
      expect(facts.argv).toContain("--input-format");
      expect(facts.argv).toContain("--resume");
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

test.each(["codex", "pi", "muse"])("%s retains exact version admission", (harness) => {
  const dir = mkdtempSync(join(tmpdir(), "hcn-other-runtime-"));
  writeFileSync(join(dir, harness), "#!/bin/sh\nprintf '0.0.0\\n'\n", { mode: 0o700 });
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
      executable: { path: realpathSync(join(dir, harness)), version: "0.0.0" },
      resume: { status: "unknown" },
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
