import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import esbuild from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";

/**
 * Playwright transpiles this file to CommonJS (the package is not
 * `type: "module"`), so `import.meta.url` is unavailable and paths are anchored
 * to the working directory instead. `npm run test:layout` and the CI step both
 * run from the package root; anything else is a mistake worth naming loudly
 * rather than resolving into a confusing "no such file".
 */
const REPO_ROOT = process.cwd();
if (!existsSync(path.join(REPO_ROOT, "package.json"))) {
  throw new Error(
    `The layout harness must be run from the package root; cwd is ${REPO_ROOT}.`,
  );
}

const HARNESS_DIR = path.join(REPO_ROOT, "e2e", "layout", "harness");
const OUT_DIR = path.join(REPO_ROOT, "e2e", "layout", ".artifacts");

/**
 * Builds the layout harness: the app's **real** stylesheet plus a browser
 * bundle of the app's **real** page shell.
 *
 * Why a bundle rather than `next start`: the running app reads every tenant
 * from Supabase over PostgREST, so exercising `/<slug>` needs a live project
 * and secrets — which is exactly why the existing e2e suite skips without
 * them. A layout regression must fail CI on every pull request, so this suite
 * has to be hermetic. It gets there without weakening the thing under test:
 * the CSS is compiled from `src/app/globals.css` by the same Tailwind plugin
 * `postcss.config.mjs` names, and the markup comes from the same
 * `TenantBookingPage` component tree the routes render.
 *
 * Two modules are stubbed, both at the edge of that tree and neither of them
 * an element with a width — see `stubs/`.
 */
export async function buildHarness(): Promise<string> {
  await mkdir(OUT_DIR, { recursive: true });

  const cssSource = path.join(REPO_ROOT, "src", "app", "globals.css");
  const css = await postcss([
    // `base` is the project root, matching what Next's PostCSS pass gives the
    // plugin — Tailwind v4 scans it for utility usage. Pointed at `src/app`
    // instead, it would never see `src/components`, and every class under test
    // would silently compile to nothing.
    tailwind({ base: REPO_ROOT }),
  ]).process(await readFile(cssSource, "utf8"), { from: cssSource });

  const bundle = await esbuild.build({
    absWorkingDir: REPO_ROOT,
    entryPoints: [path.join(HARNESS_DIR, "entry.tsx")],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "es2022",
    // `tsconfig.json` sets `jsx: "preserve"` because Next does the transform;
    // esbuild has to do it here instead.
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    alias: {
      "@/app/[customerSlug]/actions": path.join(HARNESS_DIR, "stubs", "booking-action.ts"),
      "@/lib/email/provider": path.join(HARNESS_DIR, "stubs", "email-provider.ts"),
    },
    logLevel: "silent",
  });

  const js = bundle.outputFiles[0]?.text;
  if (!js) throw new Error("esbuild produced no output for the layout harness.");

  // Emitted as separate files rather than inlined so the bundle's own text can
  // never terminate the tag that carries it.
  await writeFile(path.join(OUT_DIR, "harness.css"), css.css, "utf8");
  await writeFile(path.join(OUT_DIR, "harness.js"), js, "utf8");

  // `<html>`/`<body>` mirror `src/app/layout.tsx` exactly — `min-h-dvh` and the
  // font classes are part of the chain the shell sits in.
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Booking page layout harness</title>
    <link rel="stylesheet" href="./harness.css" />
  </head>
  <body class="min-h-dvh font-sans antialiased">
    <div id="root"></div>
    <script src="./harness.js"></script>
  </body>
</html>`;

  const htmlPath = path.join(OUT_DIR, "index.html");
  await writeFile(htmlPath, html, "utf8");
  return htmlPath;
}

export const HARNESS_HTML = path.join(OUT_DIR, "index.html");
