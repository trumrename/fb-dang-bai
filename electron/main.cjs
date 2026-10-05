const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const path = require("path");
const http = require("http");
const fs = require("fs");
const { spawn } = require("child_process");

app.setAppUserModelId("com.fbdangbai.app");
if (process.env.FB_DANGBAI_USER_DATA) app.setPath("userData", process.env.FB_DANGBAI_USER_DATA);

const PORT = Number(process.env.PORT || 3871);
let serverProc = null;
let win = null;
let updateClaimed = false;
let updateTimer = null;

function userDir() {
  const dir = app.getPath("userData");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function logLine(home, text) {
  try {
    fs.appendFileSync(path.join(home, "desktop.log"), text);
  } catch {
    /* ignore */
  }
}

function refocusWindow() {
  setTimeout(() => {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }, 40);
}

function dialogStart(initialDir) {
  let defaultPath = String(initialDir || "").trim();
  if (defaultPath && !fs.existsSync(defaultPath)) defaultPath = path.dirname(defaultPath);
  if (!defaultPath || !fs.existsSync(defaultPath)) {
    try {
      defaultPath = app.getPath("documents");
    } catch {
      defaultPath = "";
    }
  }
  return defaultPath;
}

ipcMain.handle("fbdangbai:open-external", async (_event, url) => {
  const target = String(url || "").trim();
  if (!/^https:\/\//i.test(target)) return { ok: false };
  await shell.openExternal(target);
  return { ok: true };
});

ipcMain.handle("fbdangbai:apply-update", async () => {
  if (updateClaimed) return { ok: false, error: "Đang cài bản mới." };
  updateClaimed = true;
  return requestApply();
});

ipcMain.handle("fbdangbai:pick-folder", async (_event, options = {}) => {
  const title = String(options.title || "Chọn thư mục").slice(0, 180);
  const dialogOptions = {
    title,
    defaultPath: dialogStart(options.initialDir),
    buttonLabel: "Chọn thư mục này",
    properties: ["openDirectory", "createDirectory"],
  };
  const result = win && !win.isDestroyed()
    ? await dialog.showOpenDialog(win, dialogOptions)
    : await dialog.showOpenDialog(dialogOptions);
  refocusWindow();
  if (result.canceled || !result.filePaths?.[0]) {
    return { ok: false, cancelled: true, path: null };
  }
  return { ok: true, cancelled: false, path: path.resolve(result.filePaths[0]) };
});

ipcMain.handle("fbdangbai:pick-file", async (_event, options = {}) => {
  const title = String(options.title || "Chọn file").slice(0, 180);
  const dialogOptions = {
    title,
    defaultPath: dialogStart(options.initialDir),
    buttonLabel: "Chọn file này",
    properties: ["openFile"],
    filters: [
      { name: "Text và CSV", extensions: ["txt", "csv"] },
      { name: "Tất cả", extensions: ["*"] },
    ],
  };
  const result = win && !win.isDestroyed()
    ? await dialog.showOpenDialog(win, dialogOptions)
    : await dialog.showOpenDialog(dialogOptions);
  refocusWindow();
  if (result.canceled || !result.filePaths?.[0]) {
    return { ok: false, cancelled: true, path: null };
  }
  return { ok: true, cancelled: false, path: path.resolve(result.filePaths[0]) };
});

function startServer() {
  const home = userDir();
  const root = app.getAppPath();
  serverProc = spawn(process.execPath, [path.join(root, "src", "server.js")], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      FB_DANGBAI_HOME: home,
      FB_DANGBAI_PACKAGED: app.isPackaged ? "1" : "",
      FB_DANGBAI_EXE: process.execPath,
      PORT: String(PORT),
      HOST: "127.0.0.1",
    },
    cwd: path.dirname(process.execPath),
    windowsHide: true,
  });
  serverProc.on("error", (err) => logLine(home, `\nspawn ${err.message}\n`));
  serverProc.stdout.on("data", (buf) => logLine(home, buf));
  serverProc.stderr.on("data", (buf) => logLine(home, buf));
  serverProc.on("exit", (code) => logLine(home, `\nserver exit ${code}\n`));
}

function waitHealth() {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const req = http.get(`http://127.0.0.1:${PORT}/api/health`, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          if (res.statusCode !== 200) return retry();
          let version = "";
          try {
            version = JSON.parse(Buffer.concat(chunks).toString("utf8")).version || "";
          } catch {
            version = "";
          }
          resolve(version);
        });
      });
      req.on("error", retry);
      function retry() {
        if (Date.now() - started > 20000) reject(new Error("Không mở được FB Đăng Bài. Xem desktop.log trong thư mục dữ liệu."));
        else setTimeout(tick, 250);
      }
    };
    tick();
  });
}

function stopServer() {
  if (!serverProc || serverProc.killed) return;
  try {
    serverProc.kill();
  } catch {
    /* already gone */
  }
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function isSetupFile(file) {
  const updates = path.resolve(userDir(), "updates") + path.sep;
  const resolved = path.resolve(String(file || ""));
  return resolved.toLowerCase().endsWith(".exe") && resolved.toLowerCase().startsWith(updates.toLowerCase());
}

function launchInstaller(setupPath) {
  if (!isSetupFile(setupPath)) return false;
  const home = userDir();
  const logFile = path.join(home, "update-install.log");
  const ps1 = path.join(app.getPath("temp"), "fb-dangbai-update.ps1");
  const script = [
    "$ErrorActionPreference = 'Continue'",
    `$log = ${psQuote(logFile)}`,
    `$setup = ${psQuote(setupPath)}`,
    `$exe = ${psQuote(process.execPath)}`,
    `$target = ${process.pid}`,
    "function Write-UpdateLog($message) {",
    "  try { Add-Content -LiteralPath $log -Value ((Get-Date).ToString('s') + ' ' + $message) } catch {}",
    "}",
    "Write-UpdateLog 'start'",
    "$deadline = (Get-Date).AddMinutes(3)",
    "while ((Get-Process -Id $target -ErrorAction SilentlyContinue) -and ((Get-Date) -lt $deadline)) {",
    "  Start-Sleep -Milliseconds 400",
    "}",
    "Write-UpdateLog 'old process gone'",
    "try {",
    "  $proc = Start-Process -FilePath $setup -ArgumentList '/S' -Wait -PassThru",
    "  Write-UpdateLog ('setup ' + $proc.ExitCode)",
    "} catch {",
    "  Write-UpdateLog $_.Exception.Message",
    "}",
    "try {",
    "  Start-Process -FilePath $exe",
    "  Write-UpdateLog 'relaunched'",
    "} catch {",
    "  Write-UpdateLog $_.Exception.Message",
    "}",
  ].join("\r\n");
  fs.writeFileSync(ps1, `\uFEFF${script}`, "utf8");
  let child;
  try {
    child = spawn(
      "powershell.exe",
      ["-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", ps1],
      { detached: true, stdio: "ignore", windowsHide: true }
    );
  } catch {
    return false;
  }
  if (!child || !child.pid) return false;
  child.on("error", () => {});
  child.unref();
  logLine(home, `\nupdate launch ${setupPath}\n`);
  if (updateTimer) clearInterval(updateTimer);
  updateTimer = null;
  stopServer();
  app.quit();
  return true;
}

function postLocal(pathname) {
  const body = "{}";
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: PORT,
        path: pathname,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          let data = {};
          try {
            data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            data = {};
          }
          resolve({ status: res.statusCode || 0, data });
        });
      }
    );
    req.on("error", () => resolve({ status: 0, data: { error: "Không nối được app." } }));
    req.end(body);
  });
}

async function requestApply() {
  const result = await postLocal("/api/update/apply");
  if (result.status !== 200) {
    updateClaimed = false;
    return { ok: false, error: result.data.error || "Chưa cập nhật được." };
  }
  const started = launchInstaller(result.data.file);
  if (!started) {
    updateClaimed = false;
    await postLocal("/api/update/release");
    return { ok: false, error: "Không mở được bộ cài." };
  }
  return { ok: true, version: result.data.version || "" };
}

function watchUpdate() {
  if (!app.isPackaged) return;
  updateTimer = setInterval(() => {
    if (updateClaimed) return;
    const req = http.get(`http://127.0.0.1:${PORT}/api/update`, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        let state = {};
        try {
          state = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          return;
        }
        if (state.phase !== "ready" || updateClaimed) return;
        updateClaimed = true;
        requestApply();
      });
    });
    req.on("error", () => {});
  }, 20000);
}

app.whenReady().then(async () => {
  startServer();
  let version = "";
  try {
    version = await waitHealth();
  } catch (e) {
    dialog.showErrorBox("FB Đăng Bài", e.message);
    stopServer();
    app.quit();
    return;
  }
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: version ? `FB Đăng Bài ${version}` : "FB Đăng Bài",
    autoHideMenuBar: true,
    backgroundColor: "#10140f",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(String(url || ""))) shell.openExternal(url);
    return { action: "deny" };
  });
  win.loadURL(`http://127.0.0.1:${PORT}/`);
  watchUpdate();
});

let quitReady = false;

app.on("window-all-closed", () => {
  if (updateTimer) clearInterval(updateTimer);
  app.quit();
});

app.on("before-quit", (event) => {
  if (updateTimer) clearInterval(updateTimer);
  if (quitReady) {
    stopServer();
    return;
  }
  event.preventDefault();
  setTimeout(() => {
    stopServer();
    quitReady = true;
    app.quit();
  }, 800);
});
