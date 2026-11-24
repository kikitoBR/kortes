// Builds the Kortes Desktop frontend (Next.js standalone server) into
// desktop/build/app/frontend. Run: node scripts/build-frontend.mjs
//
// It builds from a copy of frontend/ installed with a flat node_modules
// (node-linker=hoisted): Next's standalone output of a pnpm (symlinked)
// install needs symlinks, which Windows only allows to administrators.

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktop = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const frontend = path.join(desktop, "..", "frontend");
const work = path.join(desktop, "build", "frontend-src");
const output = path.join(desktop, "build", "app", "frontend");

const SKIP = new Set(["node_modules", ".next", "generated", "test-results", "playwright-report", "coverage"]);

function copySources() {
  fs.mkdirSync(work, { recursive: true });
  for (const name of fs.readdirSync(work)) {
    if (name !== "node_modules") fs.rmSync(path.join(work, name), { recursive: true, force: true });
  }
  fs.cpSync(frontend, work, {
    recursive: true,
    filter: (source) => !SKIP.has(path.basename(source)),
  });
}

function run(command, env = {}) {
  console.log(`> ${command}`);
  execSync(command, { cwd: work, stdio: "inherit", env: { ...process.env, ...env } });
}

copySources();
// The copy brings frontend/pnpm-workspace.yaml (the pinned patched versions), so it is
// its own workspace root: no --ignore-workspace, or pnpm would drop those versions.
run("pnpm install --frozen-lockfile --config.node-linker=hoisted");
run("pnpm exec prisma generate");
// Next's file tracing (@vercel/nft) follows paths built from the home folder; on the
// Windows release runner that folder holds protected WindowsApps entries and the
// build stops on them. An empty home for the build leaves it nothing to scan there.
const home = path.join(desktop, "build", "build-home");
for (const dir of ["AppData/Local", "AppData/Roaming"]) fs.mkdirSync(path.join(home, dir), { recursive: true });
// Next itself, through node (not pnpm, whose cache lives in the real AppData).
run(`node "${path.join("node_modules", "next", "dist", "bin", "next")}" build`, {
  USERPROFILE: home,
  HOME: home,
  LOCALAPPDATA: path.join(home, "AppData", "Local"),
  APPDATA: path.join(home, "AppData", "Roaming"),
  NEXT_PUBLIC_KORTES_EDITION: "desktop",
  NEXT_PUBLIC_SELF_HOST: "true",
  NEXT_PUBLIC_APP_URL: "http://127.0.0.1",
  NEXT_TELEMETRY_DISABLED: "1",
  // Only read at runtime; the build needs a syntactically valid URL.
  DATABASE_URL: "postgresql://build:build@127.0.0.1:5/build",
});

fs.rmSync(output, { recursive: true, force: true });
fs.cpSync(path.join(work, ".next", "standalone"), output, { recursive: true });
fs.cpSync(path.join(work, ".next", "static"), path.join(output, ".next", "static"), { recursive: true });
fs.cpSync(path.join(work, "public"), path.join(output, "public"), { recursive: true });
console.log(`frontend pronto em ${output}`);
