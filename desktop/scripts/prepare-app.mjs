// Puts the backend (code, fonts, transitions) and the database schema into
// desktop/build/app, next to the frontend from build-frontend.mjs, for the installer.
// Run: node scripts/prepare-app.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktop = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = path.join(desktop, "..");
const app = path.join(desktop, "build", "app");
const backend = path.join(app, "backend");

if (!fs.existsSync(path.join(app, "frontend", "server.js"))) {
  throw new Error("Falta o frontend: rode antes node scripts/build-frontend.mjs");
}
for (const part of ["python/python.exe", "postgres/bin/pg_ctl.exe", "redis/redis-server.exe", "ffmpeg/bin/ffmpeg.exe", "deno/deno.exe"]) {
  if (!fs.existsSync(path.join(desktop, "runtime", part))) {
    throw new Error(`Falta runtime/${part}: rode scripts/fetch-runtime.mjs e scripts/build-python.mjs`);
  }
}

// Microsoft Visual C++ runtime, deployed app-locally (these DLLs are redistributable):
// a freshly installed Windows does not have it, and Postgres, PyTorch, NumPy and
// OpenCV need it. Copied from the build machine's System32 next to the programs
// that load them (Windows looks in the program's own folder first).
const VC_RUNTIME = [
  "vcruntime140.dll", "vcruntime140_1.dll", "msvcp140.dll", "msvcp140_1.dll", "msvcp140_2.dll",
  "msvcp140_atomic_wait.dll", "msvcp140_codecvt_ids.dll", "concrt140.dll", "vcomp140.dll",
];
if (process.platform === "win32") {
  const system32 = path.join(process.env.SystemRoot || "C:\\Windows", "System32");
  for (const dir of ["postgres/bin", "python"]) {
    for (const dll of VC_RUNTIME) {
      const source = path.join(system32, dll);
      if (!fs.existsSync(source)) throw new Error(`${dll} não está em ${system32}: instale o Visual C++ Redistributable x64`);
      fs.copyFileSync(source, path.join(desktop, "runtime", dir, dll));
    }
  }
  console.log(`Visual C++ runtime copiado para runtime/postgres/bin e runtime/python (${VC_RUNTIME.length} DLLs)`);
}

fs.rmSync(backend, { recursive: true, force: true });
const skip = new Set(["__pycache__", ".pytest_cache"]);
for (const dir of ["src", "fonts", "transitions"]) {
  fs.cpSync(path.join(repo, "backend", dir), path.join(backend, dir), {
    recursive: true,
    filter: (source) => !skip.has(path.basename(source)),
  });
}
fs.copyFileSync(path.join(repo, "init.sql"), path.join(app, "init.sql"));
console.log(`app pronto em ${app}`);
