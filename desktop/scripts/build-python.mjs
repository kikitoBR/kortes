// Builds the portable Python Kortes Desktop ships with into desktop/runtime/python:
// a standalone CPython 3.12 (python-build-standalone, via uv) with the backend's
// locked dependencies (uv.lock, CPU build of PyTorch) installed into it.
// Run: node scripts/build-python.mjs   (needs uv on PATH)

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PYTHON_VERSION = "3.12.16";

const desktop = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const backend = path.join(desktop, "..", "backend");
const runtime = path.join(desktop, "runtime");
const target = path.join(runtime, "python");
const downloads = path.join(runtime, ".python-install");
const requirements = path.join(runtime, ".backend-requirements.txt");

function uv(args, options = {}) {
  console.log(`> uv ${args.join(" ")}`);
  return execFileSync("uv", args, { stdio: options.capture ? "pipe" : "inherit", encoding: "utf8", ...options });
}

// 1. A standalone interpreter, copied so the app owns it.
if (!fs.existsSync(path.join(target, "python.exe"))) {
  uv(["python", "install", PYTHON_VERSION, "--install-dir", downloads, "--no-bin"]);
  const installed = fs.readdirSync(downloads).find((name) => name.startsWith(`cpython-${PYTHON_VERSION}`));
  if (!installed) throw new Error(`Python ${PYTHON_VERSION} não apareceu em ${downloads}`);
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(path.join(downloads, installed), target, { recursive: true });
  // Installers may refuse an interpreter marked as managed by another tool.
  for (const marker of ["EXTERNALLY-MANAGED", path.join("Lib", "EXTERNALLY-MANAGED")]) {
    fs.rmSync(path.join(target, marker), { force: true });
  }
}

// 2. The exact versions the backend is tested with.
uv([
  "export", "--project", backend, "--frozen", "--no-hashes", "--no-dev",
  "--extra", "cpu", "--no-emit-project", "--output-file", requirements,
]);

// 3. Installed into the portable interpreter itself (copies, no links to uv's cache).
//    No precompiled .pyc: Python writes them itself on the first start, and every
//    file left out makes the installer faster (it unpacks, and Windows scans, one by one).
uv([
  "pip", "install", "--python", path.join(target, "python.exe"),
  "--link-mode", "copy", "--requirement", requirements,
]);

// 4. Nothing the app never runs: tests, C headers and static libraries (only for
//    compiling extensions), cached bytecode, and Python's own GUI and test suite.
let removed = 0;
const drop = (file) => {
  fs.rmSync(file, { recursive: true, force: true });
  removed += 1;
};
for (const name of ["include", "libs", "tcl", "Lib/test", "Lib/idlelib", "Lib/tkinter", "Lib/turtledemo"]) {
  if (fs.existsSync(path.join(target, name))) drop(path.join(target, name));
}
const DROP_DIRS = new Set(["__pycache__", "tests", "test", "include"]);
const DROP_EXT = new Set([".pyc", ".h", ".hpp", ".hxx", ".cuh", ".inl", ".lib", ".pyi"]);
const KEEP_DIRS_IN = new Set(["numpy", "torch"]); // their "test(s)" modules are imported at runtime
function prune(dir, pkg) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const isTestDir = entry.name === "tests" || entry.name === "test";
      if (DROP_DIRS.has(entry.name) && !(isTestDir && KEEP_DIRS_IN.has(pkg))) drop(full);
      else prune(full, pkg ?? entry.name);
    } else if (DROP_EXT.has(path.extname(entry.name).toLowerCase())) {
      drop(full);
    }
  }
}
prune(path.join(target, "Lib", "site-packages"), null);
console.log(`python pronto em ${target} (${removed} itens desnecessários removidos)`);
