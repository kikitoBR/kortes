// Starts and stops what the Kortes window needs: Postgres, Redis, the backend
// API, the worker and the Next.js frontend. Everything listens on 127.0.0.1 on
// ports picked at start, so it never clashes with anything else on the PC.

const { spawn, execFile } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const http = require("node:http");

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function run(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, ...options }, (error, stdout, stderr) => {
      if (error) {
        error.message += `\n${stderr || stdout}`;
        reject(error);
      } else {
        resolve(stdout);
      }
    });
  });
}

/**
 * Runs a program that starts a background server and then exits (pg_ctl start).
 * Its output is not captured: on Windows the server it starts inherits those
 * handles and keeps them open, so waiting for them to close would never end.
 */
function runAndForget(file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(file)} terminou com código ${code}`))));
  });
}

function waitFor(check, { timeoutMs, label }) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = async () => {
      try {
        if (await check()) return resolve();
      } catch {
        // not up yet
      }
      if (Date.now() - started > timeoutMs) return reject(new Error(`${label} não respondeu a tempo`));
      setTimeout(attempt, 500);
    };
    attempt();
  });
}

function httpOk(url) {
  return new Promise((resolve) => {
    const request = http.get(url, (response) => {
      response.resume();
      resolve(response.statusCode >= 200 && response.statusCode < 500);
    });
    request.on("error", () => resolve(false));
    request.setTimeout(3000, () => {
      request.destroy();
      resolve(false);
    });
  });
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

/** Secrets made once per install and kept in the data folder. */
function loadSecrets(dataDir) {
  const file = path.join(dataDir, "secrets.json");
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    const secrets = {
      postgresPassword: crypto.randomBytes(24).toString("hex"),
      redisPassword: crypto.randomBytes(24).toString("hex"),
      backendAuthSecret: crypto.randomBytes(32).toString("hex"),
      betterAuthSecret: crypto.randomBytes(32).toString("hex"),
      settingsKey: crypto.randomBytes(32).toString("hex"),
    };
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(secrets, null, 2), { mode: 0o600 });
    return secrets;
  }
}

class Services {
  /**
   * @param {object} layout  paths from paths.js
   * @param {(line: string) => void} log
   * @param {(message: string) => void} status  what the splash screen shows
   */
  constructor(layout, log, status) {
    this.layout = layout;
    this.log = log;
    this.status = status;
    this.children = [];
    this.stopping = false;
  }

  logStream(name) {
    fs.mkdirSync(this.layout.logsDir, { recursive: true });
    return fs.createWriteStream(path.join(this.layout.logsDir, `${name}.log`), { flags: "a" });
  }

  spawnService(name, file, args, { env, cwd } = {}) {
    const out = this.logStream(name);
    const child = spawn(file, args, {
      cwd,
      env: { ...process.env, ...env },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.pipe(out);
    child.stderr.pipe(out);
    child.on("exit", (code) => {
      this.log(`${name} saiu (código ${code})`);
      if (!this.stopping && this.onCrash) this.onCrash(name, code);
    });
    this.children.push({ name, child });
    return child;
  }

  async start() {
    const { layout } = this;
    for (const dir of [layout.dataDir, layout.mediaDir, layout.modelsDir, layout.logsDir]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const secrets = loadSecrets(layout.dataDir);
    this.ports = {
      postgres: await freePort(),
      redis: await freePort(),
      backend: await freePort(),
      frontend: await freePort(),
    };

    this.status("Preparando o banco de dados…");
    await this.startPostgres(secrets);
    this.status("Preparando a fila de trabalho…");
    this.startRedis(secrets);
    await waitFor(() => portOpen(this.ports.redis), { timeoutMs: 20000, label: "Redis" });

    const env = this.backendEnv(secrets);
    this.status("Ligando o Kortes…");
    this.spawnService(
      "backend",
      layout.python,
      ["-m", "uvicorn", "src.main:app", "--host", "127.0.0.1", "--port", String(this.ports.backend)],
      { env, cwd: layout.backendDir },
    );
    await waitFor(() => httpOk(`http://127.0.0.1:${this.ports.backend}/health`), {
      timeoutMs: 180000,
      label: "O backend",
    });
    // After the backend: it applies the database migrations the worker's jobs need.
    this.spawnService(
      "worker",
      layout.python,
      ["-c", "import sys; from arq.cli import cli; sys.argv=['arq','src.workers.tasks.WorkerSettings']; cli()"],
      { env, cwd: layout.backendDir },
    );

    this.spawnService("frontend", process.execPath, [layout.frontendServer], {
      cwd: path.dirname(layout.frontendServer),
      env: {
        ELECTRON_RUN_AS_NODE: "1",
        NODE_ENV: "production",
        PORT: String(this.ports.frontend),
        HOSTNAME: "127.0.0.1",
        DATABASE_URL: this.databaseUrl(secrets, "postgresql"),
        BACKEND_INTERNAL_URL: `http://127.0.0.1:${this.ports.backend}`,
        BACKEND_AUTH_SECRET: secrets.backendAuthSecret,
        BETTER_AUTH_SECRET: secrets.betterAuthSecret,
        BETTER_AUTH_URL: this.url,
        BETTER_AUTH_TRUSTED_ORIGINS: this.url,
        APP_SETTINGS_ENCRYPTION_KEY: secrets.settingsKey,
      },
    });
    await waitFor(() => httpOk(`${this.url}/api/desktop/setup`), { timeoutMs: 120000, label: "A interface" });
    return this.url;
  }

  get url() {
    return `http://127.0.0.1:${this.ports.frontend}`;
  }

  databaseUrl(secrets, scheme) {
    return `${scheme}://kortes:${secrets.postgresPassword}@127.0.0.1:${this.ports.postgres}/kortes`;
  }

  backendEnv(secrets) {
    const { layout } = this;
    return {
      KORTES_EDITION: "desktop",
      KORTES_DATA_DIR: layout.dataDir,
      LOG_DIR: path.join(layout.logsDir, "backend"),
      KORTES_DEVICE_ID: layout.machineId || "",
      KORTES_LICENSE_URL: process.env.KORTES_LICENSE_URL || "https://gemini.kikito.site/v1",
      DATABASE_URL: this.databaseUrl(secrets, "postgresql+asyncpg"),
      REDIS_HOST: "127.0.0.1",
      REDIS_PORT: String(this.ports.redis),
      REDIS_PASSWORD: secrets.redisPassword,
      TEMP_DIR: layout.mediaDir,
      MEDIA_STORAGE: "local",
      CLIP_RENDER_QUEUE: "false",
      SELF_HOST: "true",
      BACKEND_AUTH_SECRET: secrets.backendAuthSecret,
      APP_SETTINGS_ENCRYPTION_KEY: secrets.settingsKey,
      CORS_ORIGINS: this.url,
      // openai-whisper keeps its models under XDG_CACHE_HOME/whisper.
      XDG_CACHE_HOME: layout.modelsDir,
      WHISPER_MODEL_SIZE: process.env.KORTES_WHISPER_MODEL || "base",
      PYTHONUNBUFFERED: "1",
      PYTHONIOENCODING: "utf-8",
      // ffmpeg for the media work; deno for yt-dlp's YouTube JavaScript challenge.
      PATH: [layout.ffmpegDir, layout.denoDir, process.env.PATH].filter(Boolean).join(path.delimiter),
    };
  }

  async startPostgres(secrets) {
    const { layout } = this;
    const bin = (name) => path.join(layout.postgresBin, `${name}.exe`);
    const pgData = layout.postgresDataDir;
    const fresh = !fs.existsSync(path.join(pgData, "PG_VERSION"));
    if (fresh) {
      this.status("Criando o banco de dados (só na primeira vez)…");
      const pwFile = path.join(layout.dataDir, ".pgpass-init");
      fs.writeFileSync(pwFile, secrets.postgresPassword);
      try {
        await run(bin("initdb"), [
          "-D", pgData, "-U", "kortes", "--auth=scram-sha-256", `--pwfile=${pwFile}`,
          "--encoding=UTF8", "--locale=C",
        ]);
      } finally {
        fs.rmSync(pwFile, { force: true });
      }
    }
    await runAndForget(bin("pg_ctl"), [
      "start", "-w", "-t", "60", "-D", pgData, "-l", path.join(layout.logsDir, "postgres.log"),
      "-o", `-p ${this.ports.postgres} -h 127.0.0.1`,
    ]);
    this.postgresStarted = true;
    // Written only once the schema is in: a first run cut short starts the database over.
    const ready = path.join(layout.dataDir, ".database-ready");
    if (!fs.existsSync(ready)) {
      this.status("Criando o banco de dados (só na primeira vez)…");
      const env = { ...process.env, PGPASSWORD: secrets.postgresPassword };
      const psql = (args) => run(bin("psql"), ["-h", "127.0.0.1", "-p", String(this.ports.postgres), "-U", "kortes", ...args], { env });
      await psql(["-d", "postgres", "-c", "DROP DATABASE IF EXISTS kortes"]);
      await psql(["-d", "postgres", "-c", "CREATE DATABASE kortes"]);
      // The same schema the Docker image loads (the backend applies migrations on top).
      await psql(["-d", "kortes", "-v", "ON_ERROR_STOP=1", "-f", layout.initSql]);
      fs.writeFileSync(ready, new Date().toISOString());
    }
  }

  startRedis(secrets) {
    const { layout } = this;
    fs.mkdirSync(layout.redisDataDir, { recursive: true });
    this.spawnService("redis", layout.redisServer, [
      "--port", String(this.ports.redis),
      "--bind", "127.0.0.1",
      "--requirepass", secrets.redisPassword,
      "--dir", layout.redisDataDir,
      "--save", "",
      "--appendonly", "no",
    ]);
  }

  async stop() {
    this.stopping = true;
    for (const { name, child } of [...this.children].reverse()) {
      if (child.exitCode !== null) continue;
      if (process.platform === "win32") {
        // The whole tree: a venv's python.exe is a launcher that starts the real
        // Python as its child, which a plain kill would leave running.
        try {
          await run("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
        } catch (error) {
          this.log(`${name} não fechou: ${error.message}`);
        }
      } else {
        child.kill();
      }
    }
    if (this.postgresStarted) {
      try {
        await run(path.join(this.layout.postgresBin, "pg_ctl.exe"), ["stop", "-D", this.layout.postgresDataDir, "-m", "fast", "-w"]);
      } catch (error) {
        this.log(`Postgres não parou: ${error.message}`);
      }
    }
  }
}

module.exports = { Services, freePort };
