import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

const HOST_PROVIDED_PACKAGES = [
  "@earendil-works/pi-ai",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "typebox",
];

describe("package manifest", () => {
  it("declares the Pi extension entry point", () => {
    expect(packageJson.name).toBe("pi-guardrails-explain");
    expect(packageJson.type).toBe("module");
    expect(packageJson.pi).toEqual({ extensions: ["./index.ts"] });
  });

  it("is eligible as a Pi package and installable from GitHub", () => {
    expect(packageJson.keywords).toContain("pi-package");
    expect(packageJson.files).toContain("index.ts");
    expect(readme).toContain("pi install git:github.com/pcaro/pi-guardrails-explain");
  });

  it("keeps the MIT license", () => {
    expect(packageJson.license).toBe("MIT");
    expect(readFileSync(new URL("../LICENSE", import.meta.url), "utf8")).toContain("MIT License");
  });

  it("declares host-provided packages as peers, not runtime dependencies", () => {
    for (const pkg of Object.keys(packageJson.peerDependencies ?? {})) {
      expect(HOST_PROVIDED_PACKAGES).toContain(pkg);
    }
    for (const pkg of Object.keys(packageJson.dependencies ?? {})) {
      expect(HOST_PROVIDED_PACKAGES).not.toContain(pkg);
    }
  });

  it("exposes the minimal test and typecheck scripts", () => {
    expect(packageJson.scripts.typecheck).toBe("tsc --noEmit");
    expect(packageJson.scripts.test).toBe("vitest run");
  });
});

describe("README documentation", () => {
  it("documents the Guardrails 0.23.0 minimum", () => {
    expect(readme).toMatch(/0\.23\.0 or newer/);
  });

  it("documents the guardrailsExplain.models settings key", () => {
    expect(readme).toContain("guardrailsExplain.models");
    expect(readme).toContain("provider/modelId");
    expect(readme).toContain("active session model");
  });

  it("documents Bash-only scope and the [guardrails] explanation line", () => {
    expect(readme).toContain("Bash only");
    expect(readme).toContain("`[guardrails]`");
  });

  it("documents that the decision always stays with the human", () => {
    expect(readme).toContain("always answers `ask`");
    expect(readme).toContain("never allows or blocks");
  });

  it("documents the privacy boundary", () => {
    expect(readme).toContain("No session history");
    expect(readme).toContain("raw command");
  });

  it("documents the delegation deadline and timeoutMs option", () => {
    expect(readme).toContain("10 seconds");
    expect(readme).toContain('"timeoutMs"');
  });
});
