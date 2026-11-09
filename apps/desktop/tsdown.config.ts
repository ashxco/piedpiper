import { defineConfig } from "tsdown";

const shared = {
  format: "cjs" as const,
  outDir: "dist-electron",
  sourcemap: true,
  outExtensions: () => ({ js: ".js" }),
};

export default defineConfig([
  {
    ...shared,
    entry: ["src/main.ts"],
    clean: true,
    noExternal: (id) => id.startsWith("@piedpiper/"),
  },
  {
    ...shared,
    entry: ["src/preload.ts"],
  },
  {
    // Packaged entry: boot.js requires compileCache.js then main.js at runtime, so they stay separate files.
    ...shared,
    entry: ["src/boot.ts", "src/compileCache.ts"],
    external: (id) => id === "./main.js" || id === "./compileCache.js",
  },
]);
