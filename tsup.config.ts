import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    cli: "src/cli.ts",
    index: "src/index.ts",
  },
  format: ["esm"],
  target: "node18",
  outDir: "dist",
  clean: true,
  dts: true,
  sourcemap: true,
  splitting: false,
  // Shebang is stripped by Node when a module is imported, so it is harmless on index.js.
  banner: { js: "#!/usr/bin/env node" },
});
