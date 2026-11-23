// Kortes Desktop: a window around the local Kortes. Starts the services, shows
// the app, checks for updates, and shuts everything down on exit.

const { app, BrowserWindow, dialog, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const { layout } = require("./paths");
const { Services } = require("./services");

let mainWindow = null;
let services = null;
let quitting = false;

const UPDATE_CHECK_HOURS = 4;

function log(line) {
  const paths = services?.layout;
  const message = `[${new Date().toISOString()}] ${line}\n`;
  process.stdout.write(message);
  if (paths) fs.appendFile(path.join(paths.logsDir, "kortes.log"), message, () => {});
}

function showSplash(window, message) {
  const html = `<!doctype html><html lang="pt-BR"><meta charset="utf-8">
    <body style="margin:0;height:100vh;display:grid;place-items:center;background:#faf8f5;
      font:15px system-ui,sans-serif;color:#1c1917">
      <div style="text-align:center">
        <div style="font-size:28px;font-weight:700;letter-spacing:-.02em">Kortes</div>
        <div id="m" style="margin-top:12px;color:#78716c">${message}</div>
      </div></body></html>`;
  window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

function setStatus(message) {
  log(message);
  if (!mainWindow) return;
  mainWindow.webContents
    .executeJavaScript(`document.getElementById("m") && (document.getElementById("m").textContent = ${JSON.stringify(message)})`)
    .catch(() => {});
}

function setupUpdates() {
  if (!app.isPackaged) return;
  let autoUpdater;
  try {
    ({ autoUpdater } = require("electron-updater"));
  } catch (error) {
    log(`Atualizações indisponíveis: ${error.message}`);
    return;
  }
  autoUpdater.logger = { info: log, warn: log, error: log, debug: () => {} };
  // Downloads in the background; installs when the person closes Kortes, or now if they choose.
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("update-downloaded", async (info) => {
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: "info",
      buttons: ["Reiniciar agora", "Depois"],
      defaultId: 0,
      cancelId: 1,
      title: "Atualização pronta",
      message: `O Kortes ${info.version} está pronto para instalar.`,
      detail: "Seus vídeos, clipes e a licença continuam como estão. Se escolher Depois, a atualização entra quando você fechar o Kortes.",
    });
    if (response === 0) {
      quitting = true;
      await services?.stop();
      autoUpdater.quitAndInstall();
    }
  });
  const check = () => autoUpdater.checkForUpdates().catch((error) => log(`Falha ao procurar atualização: ${error.message}`));
  check();
  setInterval(check, UPDATE_CHECK_HOURS * 3600 * 1000);
}

async function start() {
  const paths = layout(app);
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 1024,
    minHeight: 680,
    title: "Kortes",
    backgroundColor: "#faf8f5",
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  showSplash(mainWindow, "Abrindo o Kortes…");

  // Links to other sites (AssemblyAI sign-up, help) open in the person's browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith("http://127.0.0.1:")) shell.openExternal(url);
    return { action: "deny" };
  });

  if (paths.missing.length) {
    await dialog.showMessageBox(mainWindow, {
      type: "error",
      title: "Instalação incompleta",
      message: "Faltam arquivos do Kortes. Reinstale o programa.",
      detail: paths.missing.join(", "),
    });
    app.quit();
    return;
  }

  services = new Services(paths, log, setStatus);
  services.onCrash = (name, code) => {
    if (quitting) return;
    dialog.showMessageBox(mainWindow, {
      type: "error",
      title: "O Kortes parou",
      message: `Uma parte do Kortes (${name}) parou de funcionar. Feche e abra o programa de novo.`,
      detail: `Os detalhes estão em ${paths.logsDir}`,
    });
  };

  try {
    const url = await services.start();
    await mainWindow.loadURL(url);
  } catch (error) {
    log(`Falha ao iniciar: ${error.stack || error.message}`);
    await dialog.showMessageBox(mainWindow, {
      type: "error",
      title: "Não foi possível abrir o Kortes",
      message: error.message,
      detail: `Os detalhes estão em ${paths.logsDir}`,
    });
    quitting = true;
    await services.stop();
    app.quit();
    return;
  }
  setupUpdates();
}

// One Kortes at a time: a second launch brings the open window forward.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.whenReady().then(start);
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", (event) => {
    if (quitting || !services) return;
    event.preventDefault();
    quitting = true;
    services.stop().finally(() => app.quit());
  });
}
