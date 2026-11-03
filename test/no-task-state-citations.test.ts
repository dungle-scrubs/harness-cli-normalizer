import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

/** Citations of machine-local task evidence in shipped source: a
 * `.scratch/<task>/evidence|reports/` path, or the sibling class observed
 * on the Cursor SDK descriptor - a bare `native-sdk-*.log` task-log
 * filename, the probe logs that exist only under `.scratch/`. Committed
 * evidence stays legal: a filename qualified by a directory path -
 * `.evidence/...` committed, or any `.scratch/` path the first arm
 * already rejects - is not a bare citation. The bare-filename arm reads
 * comment lines only, so real logging code that names such a file in a
 * statement is not a citation. */
const taskStateCitationsIn = (source: string): string[] => {
  const citations: string[] = [];
  if (/\.scratch\/[^\s"'`)]*\/(?:evidence|reports)\//.test(source)) {
    citations.push("a .scratch/<task>/evidence|reports/ path");
  }
  for (const line of source.split("\n")) {
    const comment = line.trim();
    if (!/^(?:\/\/|\*)/.test(comment)) continue;
    for (const hit of comment.matchAll(/\bnative-sdk-[A-Za-z0-9._-]*\.log\b/g)) {
      const before = comment.slice(0, hit.index ?? 0);
      // A directory-qualified filename is a path citation, not a bare
      // one: `.scratch/` paths are the first arm's violation, and
      // `.evidence/` paths are committed evidence.
      if (/\/\s*$/.test(before)) continue;
      citations.push(hit[0] as string);
    }
  }
  return citations;
};

test("shipped source does not cite machine-local task evidence", () => {
  const root = join(import.meta.dirname, "../src");
  const files = readdirSync(root, { recursive: true, encoding: "utf8" }).filter((file) =>
    file.endsWith(".ts"),
  );
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    const citations = taskStateCitationsIn(readFileSync(join(root, file), "utf8"));
    expect(
      citations,
      `src/${file}: cite the finding, or commit its evidence under .evidence/ instead of ${citations.join(", ")}`,
    ).toEqual([]);
  }
});

test("handwritten capture provenance does not cite machine-local evidence", () => {
  const root = join(import.meta.dirname, "fixtures");
  const files = readdirSync(root, { recursive: true, encoding: "utf8" }).filter((file) =>
    file.endsWith(".provenance.json"),
  );
  for (const file of files) {
    expect(
      taskStateCitationsIn(readFileSync(join(root, file), "utf8")),
      `${file}: cite a finding or committed evidence, not a machine-local task artifact`,
    ).toEqual([]);
  }
});

test("the citation matcher rejects the observed violation shapes and nothing legal", () => {
  // The first observed shape: a machine-local .scratch evidence path.
  expect(
    taskStateCitationsIn("// verified against .scratch/cursor-sdk/evidence/native-sdk-session.log"),
  ).toHaveLength(1);
  // The repeat: the same citation with the path stripped, leaving a bare
  // task-log filename the path-only check missed.
  expect(
    taskStateCitationsIn("// Issue #440, verified 1.0.38 (native-sdk-session.log): a fact"),
  ).toEqual(["native-sdk-session.log"]);
  expect(taskStateCitationsIn("* native-sdk-questions.log says sessions deliver tokens")).toEqual([
    "native-sdk-questions.log",
  ]);
  // Committed evidence and real logging code stay legal.
  expect(
    taskStateCitationsIn("// captured in .evidence/cursor-sdk/native-sdk-session.log"),
  ).toEqual([]);
  expect(taskStateCitationsIn("const logPath = 'native-sdk-session-' + stamp + '.log';")).toEqual(
    [],
  );
});
