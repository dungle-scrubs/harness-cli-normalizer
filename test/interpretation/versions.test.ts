import { describe, expect, test } from "vitest";
import { compareVersions, versionStatus } from "../../src/interpretation/versions.js";

describe("compareVersions", () => {
  test("orders dotted-numeric versions", () => {
    expect(compareVersions("2.1.226", "2.1.227")).toBe(-1);
    expect(compareVersions("2.1.227", "2.1.226")).toBe(1);
    expect(compareVersions("0.84.1", "0.84.1")).toBe(0);
    expect(compareVersions("1.0", "1.0.0")).toBe(0); // missing part = 0
    expect(compareVersions("0.147.0", "0.148.0")).toBe(-1);
  });

  test("tolerates prerelease/build suffixes", () => {
    expect(compareVersions("0.1.0-R708.1", "0.1.0")).toBe(1); // extra numeric part
    expect(compareVersions("1.2.3+build", "1.2.3")).toBe(0);
  });
});

describe("versionStatus", () => {
  test("classifies verified-vs-latest", () => {
    expect(versionStatus("2.1.226", "2.1.227")).toBe("behind"); // new version shipped
    expect(versionStatus("0.147.0", "0.147.0")).toBe("ok");
    expect(versionStatus("1.0.0", "0.9.0")).toBe("ahead");
  });

  test("unknown when latest is unavailable or unparseable", () => {
    expect(versionStatus("2.1.226", null)).toBe("unknown");
    expect(versionStatus("2.1.226", "")).toBe("unknown");
    expect(versionStatus("", "2.1.227")).toBe("unknown");
  });
});
