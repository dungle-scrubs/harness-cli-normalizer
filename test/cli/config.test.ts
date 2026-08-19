/**
 * User config parsing: hard-fail discipline. Unknown keys, malformed JSON,
 * version mismatch, wrong types - all refuse with the offender named.
 * Absent file means no config (empty tier), never an error.
 */
import { describe, expect, it } from "vitest";
import { ConfigError, parseUserConfig, userConfigPath } from "../../src/cli/config.js";

describe("parseUserConfig", () => {
  it("valid config with version parses", () => {
    expect(parseUserConfig('{"version":1,"effort":"high"}')).toEqual({ effort: "high" });
  });

  it("malformed JSON refuses naming the parse failure", () => {
    expect(() => parseUserConfig("{not json")).toThrow(ConfigError);
  });

  it("missing version refuses", () => {
    expect(() => parseUserConfig('{"effort":"high"}')).toThrow(/missing required field: version/);
  });

  it("wrong version refuses with both versions named", () => {
    expect(() => parseUserConfig('{"version":99,"effort":"high"}')).toThrow(
      /version 99 not supported \(expected 1\)/,
    );
  });

  it("unknown key refuses with the key named", () => {
    expect(() => parseUserConfig('{"version":1,"sandboxx":"read-only"}')).toThrow(
      /unknown config key: "sandboxx"/,
    );
  });

  it("wrong value type refuses", () => {
    expect(() => parseUserConfig('{"version":1,"effort":true}')).toThrow(
      /"effort" must be a string or number/,
    );
    expect(() => parseUserConfig('{"version":1,"tools":"read"}')).toThrow(
      /"tools" must be an array of strings/,
    );
  });

  it("list and bool keys validate their shapes", () => {
    expect(parseUserConfig('{"version":1,"tools":["read","bash"]}')).toEqual({
      tools: ["read", "bash"],
    });
    expect(parseUserConfig('{"version":1,"autonomy":false}')).toEqual({ autonomy: false });
    expect(() => parseUserConfig('{"version":1,"autonomy":"yes"}')).toThrow(
      /"autonomy" must be a boolean/,
    );
  });

  it("root must be an object", () => {
    expect(() => parseUserConfig("[1,2]")).toThrow(/root must be a JSON object/);
  });
});

describe("userConfigPath", () => {
  it("honors HCN_CONFIG_DIR for the test seam", () => {
    process.env.HCN_CONFIG_DIR = "/tmp/hcn-test-config";
    try {
      expect(userConfigPath()).toBe("/tmp/hcn-test-config/config.json");
    } finally {
      delete process.env.HCN_CONFIG_DIR;
    }
  });

  it("defaults under ~/.config/hcn", () => {
    delete process.env.HCN_CONFIG_DIR;
    expect(userConfigPath()).toMatch(/\.config\/hcn\/config\.json$/);
  });
});
