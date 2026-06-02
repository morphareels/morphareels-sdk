import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  // Bundle the pure core (../../src + editor font data) + zod into dist so the
  // package is self-contained. Playwright stays external — it's an optional
  // peer dep, dynamically imported only when renderFrame() is called.
  external: ["playwright"],
});
