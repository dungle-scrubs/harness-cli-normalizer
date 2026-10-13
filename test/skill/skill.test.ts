import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * The hcn agent skill ships in this repository and in the npm package.
 * This test guards the skill's structural shape: frontmatter, link
 * integrity, and absence of private pointers the skill no longer carries.
 */

const repoRoot = join(import.meta.dirname, "../..");
const skillDir = join(repoRoot, "skills/hcn");
const skillFile = join(skillDir, "SKILL.md");

function listAllFiles(dir: string, ext?: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listAllFiles(full, ext));
    } else if (!ext || entry.name.endsWith(ext)) {
      out.push(full);
    }
  }
  return out;
}

function readFrontmatter(text: string): string {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m || m[1] === undefined) throw new Error("frontmatter not found");
  return m[1];
}

function stripOuterQuotes(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

describe("hcn skill", () => {
  const skillText = readFileSync(skillFile, "utf8");
  const frontmatter = readFrontmatter(skillText);

  test("SKILL.md starts with frontmatter open", () => {
    expect(skillText.startsWith("---\n")).toBe(true);
  });

  test("frontmatter has exactly the top-level keys name, description, metadata", () => {
    const topLevelKeys = new Set<string>();
    for (const line of frontmatter.split("\n")) {
      const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:/);
      const key = m?.[1];
      if (key) topLevelKeys.add(key);
    }
    expect([...topLevelKeys].sort()).toEqual(["description", "metadata", "name"]);
  });

  test("name is hcn, equals the folder name, and matches the kebab-case pattern", () => {
    const m = frontmatter.match(/^name:\s*(.+?)\s*$/m);
    expect(m, "name capture").not.toBeNull();
    const name = m?.[1] ?? "";
    expect(name).toBe("hcn");
    expect(name).toBe(basename(skillDir));
    expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  test("description is non-empty and at most 1024 characters", () => {
    const m = frontmatter.match(/^description:\s*(.+?)\s*$/m);
    expect(m, "description capture").not.toBeNull();
    const description = stripOuterQuotes(m?.[1] ?? "");
    expect(description.length).toBeGreaterThan(0);
    expect(description.length).toBeLessThanOrEqual(1024);
  });

  test("metadata.upstream is the repository URL", () => {
    const m = frontmatter.match(/^\s+upstream:\s*(.+?)\s*$/m);
    expect(m, "upstream capture").not.toBeNull();
    expect(m?.[1] ?? "").toBe("https://github.com/dungle-scrubs/harness-cli-normalizer");
  });

  test("SKILL.md has at most 500 lines", () => {
    const lineCount = skillText.split("\n").length;
    expect(lineCount).toBeLessThanOrEqual(500);
  });

  test("no file under skills/hcn contains a forbidden private pointer", () => {
    const forbidden = ["/Users/", "decision-ledger", "skills/vendor", "established local-model"];
    const files = listAllFiles(skillDir);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      for (const needle of forbidden) {
        expect(
          content.includes(needle),
          `${file} contains forbidden string ${JSON.stringify(needle)}`,
        ).toBe(false);
      }
    }
  });

  test("every relative Markdown link under skills/hcn resolves to a file inside skills/hcn", () => {
    const mdFiles = listAllFiles(skillDir, ".md");
    expect(mdFiles.length).toBeGreaterThan(0);
    const linkRe = /\]\(([^)]+)\)/g;
    for (const md of mdFiles) {
      const text = readFileSync(md, "utf8");
      const mdDir = dirname(md);
      const matches = text.matchAll(linkRe);
      for (const match of matches) {
        const rawTarget = (match[1] ?? "").trim();
        if (/^https?:\/\//i.test(rawTarget)) continue;
        if (/^mailto:/i.test(rawTarget)) continue;
        if (rawTarget.startsWith("#")) continue;
        const pathPart = rawTarget.split("#")[0] ?? "";
        if (pathPart === "") continue;
        const resolved = join(mdDir, pathPart);
        let isFile = false;
        try {
          if (existsSync(resolved)) isFile = statSync(resolved).isFile();
        } catch {
          isFile = false;
        }
        expect(
          isFile,
          `link ${JSON.stringify(rawTarget)} in ${md} does not resolve to a file under skills/hcn`,
        ).toBe(true);
      }
    }
  });

  test("package.json files includes skills", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      files?: unknown;
    };
    const files = Array.isArray(pkg.files) ? (pkg.files as string[]) : [];
    expect(files).toContain("skills");
  });
});
