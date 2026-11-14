import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");

const HOST_PROVIDED_PACKAGES = [
  "@earendil-works/pi-ai",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "typebox",
];

describe("package manifest", () => {
  it("declares the Pi extension entry point and changelog path", () => {
    expect(packageJson.name).toBe("pi-guardrails-explain");
    expect(packageJson.type).toBe("module");
    expect(packageJson.pi).toEqual({
      extensions: ["./index.ts"],
      changelogPath: "./CHANGELOG.md",
    });
  });

  it("is eligible as a Pi package and installable from the tagged Git release", () => {
    expect(packageJson.keywords).toContain("pi-package");
    expect(packageJson.version).toBe("0.2.0");
    expect(packageJson.files).toContain("CHANGELOG.md");
    expect(packageJson.files).toContain("index.ts");
    expect(packageJson.files).toContain("assets");
    expect(readme).toContain("pi install git:github.com/pcaro/pi-guardrails-explain@v0.2.0");
    expect(readme).toContain("pi -e git:github.com/pcaro/pi-guardrails-explain@v0.2.0");
  });

  it("ships a CHANGELOG.md entry matching package.json version in Pi's heading format", () => {
    const escapedVersion = String(packageJson.version).replaceAll(".", "\\.");
    const headingPattern = new RegExp(`^##\\s+\\[?${escapedVersion}\\]?(?:\\s|$)`, "m");
    expect(changelog).toMatch(headingPattern);
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
  it("includes the example screenshot", () => {
    expect(readme).toContain("![pi-guardrails-explain screenshot](./assets/screenshot.svg)");
    expect(existsSync(new URL("../assets/screenshot.svg", import.meta.url))).toBe(true);
  });

  it("documents the Guardrails 0.23.0 minimum", () => {
    expect(readme).toMatch(/0\.23\.0 or newer/);
  });

  it("documents the guardrailsExplain settings keys and fallback order", () => {
    expect(readme).toContain("guardrailsExplain");
    expect(readme).toContain("provider/modelId");
    expect(readme).toContain("guardrailsExplain.language");
    expect(readme).toContain("longer than 64 characters");
    expect(readme).toContain("always tried last unless it is already in the list");
  });

  it("documents the in-memory session cache and runtime toggle command", () => {
    expect(readme).toContain("Session cache");
    expect(readme).toContain("64 commands");
    expect(readme).toContain("/guardrails-explain");
  });

  it("warns that the active model can use a different provider", () => {
    expect(readme).toContain("not a provider allowlist");
    expect(readme).toContain("active session model is tried last");
    expect(readme).toContain("strict provider boundary");
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

  it("distinguishes model failures from the Guardrails delegate timeout", () => {
    expect(readme).toContain("all candidates fail before the shared deadline");
    expect(readme).toContain("Guardrails marks the delegate as timed out");
    expect(readme).toContain("10 seconds");
    expect(readme).toContain('"timeoutMs"');
  });

  it("describes the implemented test coverage", () => {
    expect(readme).toContain("model selection");
    expect(readme).toContain("delegate registration and approval behavior");
    expect(readme).not.toContain("Extension logic and its tests are added on top");
  });
});
