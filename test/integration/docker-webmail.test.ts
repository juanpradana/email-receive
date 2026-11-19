import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("Docker image packaging", () => {
  it("builds the webmail app into the runtime image", () => {
    const dockerfile = readFileSync(fileURLToPath(new URL("../../Dockerfile", import.meta.url)), "utf8");

    expect(dockerfile).toMatch(/FROM deps AS web-deps/);
    expect(dockerfile).toMatch(/COPY web\/package\.json web\/package-lock\.json \.\//);
    expect(dockerfile).toMatch(/FROM web-deps AS web-build/);
    expect(dockerfile).toMatch(/RUN npm run build/);
    expect(dockerfile).toMatch(/COPY --from=web-build \/app\/web\/dist \.\/web\/dist/);
  });
});
