// Downloads the portable programs Kortes Desktop ships with into desktop/runtime:
//   postgres/  PostgreSQL 15 (same major as the Docker install), trimmed to what runs
//   redis/     Redis 7.2 for Windows (BSD license)
//   ffmpeg/    FFmpeg essentials build (GPL; separate program, license notice shipped)
// Already present parts are skipped. Run: node scripts/fetch-runtime.mjs

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "runtime");
const downloads = path.join(root, ".downloads");

const PARTS = [
  {
    name: "postgres",
    url: "https://get.enterprisedb.com/postgresql/postgresql-15.17-1-windows-x64-binaries.zip",
    // The zip holds pgsql/{bin,lib,share,...}; only these are needed to run.
    keep: ["bin", "lib", "share"],
    inner: "pgsql",
    // Translations (Kortes runs it with the C locale) and import libraries.
    drop: ["share/locale", "lib/*.lib"],
    check: "bin/pg_ctl.exe",
  },
  {
    name: "redis",
    url: "https://github.com/redis-windows/redis-windows/releases/download/7.2.16/Redis-7.2.16-Windows-x64-msys2.zip",
    check: "redis-server.exe",
    drop: ["redis-benchmark.exe", "redis-check-aof.exe", "redis-check-rdb.exe", "redis-sentinel.exe"],
  },
  {
    name: "ffmpeg",
    url: "https://github.com/GyanD/codexffmpeg/releases/download/9.0.2/ffmpeg-9.0.2-essentials_build.zip",
    keep: ["bin", "LICENSE"],
    drop: ["bin/ffplay.exe"], // a video player; Kortes only needs ffmpeg and ffprobe
    check: "bin/ffmpeg.exe",
  },
  {
    // yt-dlp runs YouTube's JavaScript challenge with it (MIT license).
    name: "deno",
    url: "https://github.com/denoland/deno/releases/download/v2.9.7/deno-x86_64-pc-windows-msvc.zip",
    check: "deno.exe",
  },
];

async function download(url, file) {
  if (fs.existsSync(file)) return;
  console.log(`baixando ${url}`);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const partial = `${file}.part`;
  await fs.promises.writeFile(partial, Buffer.from(await response.arrayBuffer()));
  fs.renameSync(partial, file);
}

function extract(zip, into) {
  fs.mkdirSync(into, { recursive: true });
  // Windows' own tar.exe (10+) reads zip files; a GNU tar earlier on PATH (Git Bash)
  // would read "C:" as a remote host.
  const tar = process.platform === "win32"
    ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe")
    : "tar";
  execFileSync(tar, ["-xf", zip, "-C", into], { stdio: "inherit" });
}

function onlyChild(dir) {
  const entries = fs.readdirSync(dir).filter((name) => !name.startsWith("."));
  return entries.length === 1 && fs.statSync(path.join(dir, entries[0])).isDirectory()
    ? path.join(dir, entries[0])
    : dir;
}

async function fetchPart(part) {
  const target = path.join(root, part.name);
  if (fs.existsSync(path.join(target, part.check))) {
    console.log(`${part.name}: já existe`);
    return;
  }
  fs.mkdirSync(downloads, { recursive: true });
  const zip = path.join(downloads, path.basename(new URL(part.url).pathname));
  await download(part.url, zip);
  const sha = createHash("sha256").update(fs.readFileSync(zip)).digest("hex");
  console.log(`${part.name}: sha256 ${sha}`);

  const staging = path.join(downloads, `${part.name}-extract`);
  fs.rmSync(staging, { recursive: true, force: true });
  extract(zip, staging);
  const source = part.inner ? path.join(staging, part.inner) : onlyChild(staging);

  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  const names = part.keep ?? fs.readdirSync(source);
  for (const name of names) {
    const from = path.join(source, name);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(target, name), { recursive: true });
  }
  fs.rmSync(staging, { recursive: true, force: true });
  for (const unused of part.drop ?? []) {
    if (unused.includes("*")) {
      const [dir, pattern] = [path.dirname(unused), path.basename(unused)];
      const suffix = pattern.replace("*", "");
      for (const name of fs.readdirSync(path.join(target, dir))) {
        if (name.endsWith(suffix)) fs.rmSync(path.join(target, dir, name), { force: true });
      }
    } else {
      fs.rmSync(path.join(target, unused), { recursive: true, force: true });
    }
  }
  if (!fs.existsSync(path.join(target, part.check))) throw new Error(`${part.name}: ${part.check} não encontrado`);
  console.log(`${part.name}: pronto em ${target}`);
}

for (const part of PARTS) {
  await fetchPart(part);
}
