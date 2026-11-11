// scripts/check-server-json.mjs guards what the MCP Registry and Adobe's
// trademark rules would refuse at publish time. Here it runs against the real
// package.json / server.json, as `npm run check` does.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../scripts/check-server-json.mjs", import.meta.url));
const read = (file: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), "utf8"));

describe("check-server-json", () => {
  it("accepts the package as it is", () => {
    const result = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("names the package parlez everywhere, under the owner's GitHub namespace", () => {
    const pkg = read("package.json");
    const srv = read("server.json");
    expect(pkg.name).toBe("parlez");
    expect(pkg.bin.parlez).toBe("dist/index.js");
    expect(srv.packages[0].identifier).toBe("parlez");
    expect(srv.name).toBe("io.github.anotherperspective/parlez");
    expect(srv.repository.url).toBe("https://github.com/AnotherPerspective/Parlez");
  });
});
