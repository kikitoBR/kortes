// Where everything lives. Installed: inside the app's resources folder (replaced
// by each update) and %LOCALAPPDATA%\Kortes (the customer's data, never touched
// by updates). In development (`pnpm dev`): the repository and desktop/runtime.

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

function machineId() {
  // Windows' own id for this installation; survives reinstalling Kortes.
  try {
    const output = execFileSync(
      "reg",
      ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"],
      { windowsHide: true, encoding: "utf8" },
    );
    const match = output.match(/MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]+)/);
    return match ? match[1].toLowerCase() : "";
  } catch {
    return "";
  }
}

function layout(app) {
  const packaged = app.isPackaged;
  const repo = path.resolve(__dirname, "..", "..");
  const resources = packaged ? process.resourcesPath : path.join(repo, "desktop", "runtime");
  const dataDir = process.env.KORTES_DATA_DIR || path.join(process.env.LOCALAPPDATA || app.getPath("userData"), "Kortes");

  const backendDir = packaged ? path.join(resources, "app", "backend") : path.join(repo, "backend");
  const python = packaged
    ? path.join(resources, "python", "python.exe")
    : path.join(repo, "backend", ".venv-win", "Scripts", "python.exe");
  // Built by scripts/build-frontend.mjs (packaged under resources/app).
  const frontendServer = packaged
    ? path.join(resources, "app", "frontend", "server.js")
    : path.join(repo, "desktop", "build", "app", "frontend", "server.js");

  const result = {
    packaged,
    resources,
    dataDir,
    mediaDir: path.join(dataDir, "media"),
    modelsDir: path.join(dataDir, "models"),
    logsDir: path.join(dataDir, "logs"),
    postgresDataDir: path.join(dataDir, "postgres"),
    redisDataDir: path.join(dataDir, "redis"),
    backendDir,
    python,
    frontendServer,
    initSql: packaged ? path.join(resources, "app", "init.sql") : path.join(repo, "init.sql"),
    postgresBin: path.join(resources, "postgres", "bin"),
    redisServer: path.join(resources, "redis", "redis-server.exe"),
    ffmpegDir: path.join(resources, "ffmpeg", "bin"),
    denoDir: path.join(resources, "deno"),
    machineId: machineId(),
  };

  const missing = ["python", "frontendServer", "initSql", "redisServer"]
    .filter((key) => !fs.existsSync(result[key]))
    .concat(fs.existsSync(path.join(result.postgresBin, "pg_ctl.exe")) ? [] : ["postgresBin"]);
  result.missing = missing;
  return result;
}

module.exports = { layout };
