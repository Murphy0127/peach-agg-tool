import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  target: "node18",
  outDir: "dist",
  outExtension: () => ({ js: ".mjs" }),
  clean: true,
  splitting: true,
  sourcemap: true,
  external: ["ethers", "@pagg/aggregator-sdk", "undici"],
});
