const { app, BrowserWindow, dialog } = require("electron");
const path = require("path");
const http = require("http");
const fs = require("fs");
const { spawn } = require("child_process");

app.setAppUserModelId("com.fbdangbai.admin");
app.setName("fb-dang-bai-admin");
if (process.env.FB_DANGBAI_USER_DATA) app.setPath("userData", process.env.FB_DANGBAI_USER_DATA);

const PORT = Number(process.env.PORT || 3872);
let serverProc = null;

function userDir() {
  const dir = app.getPath("userData");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function startServer() {
  const home = userDir();
  const root = app.getAppPath();
  const log = path.join(home, "desktop.log");
  const write = (buf) => {
    try { fs.appendFileSync(log, buf); } catch { /* ignore */ }
  };
  serverProc = spawn(process.execPath, [path.join(root, "admin", "server.js")], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      FB_DANGBAI_ADMIN_HOME: home,
      PORT: String(PORT),
      HOST: "127.0.0.1",
    },
    cwd: path.dirname(process.execPath),
    windowsHide: true,
  });
  serverProc.on("error", (err) => write(Buffer.from(`\nspawn ${err.message}\n`)));
  serverProc.stdout.on("data", write);
  serverProc.stderr.on("data", write);
}

function waitHealth() {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const req = http.get(`http://127.0.0.1:${PORT}/`, (res) => {
        res.resume();
        if (res.statusCode === 200) resolve();
        else retry();
      });
      req.on("error", retry);
      function retry() {
        if (Date.now() - started > 20000) reject(new Error("Không mở được FB Đăng Bài Admin."));
        else setTimeout(tick, 250);
      }
    };
    tick();
  });
}

function stopServer() {
  if (!serverProc || serverProc.killed) return;
  try { serverProc.kill(); } catch { /* already gone */ }
}

app.whenReady().then(async () => {
  startServer();
  try {
    await waitHealth();
  } catch (e) {
    dialog.showErrorBox("FB Đăng Bài Admin", e.message);
    stopServer();
    app.quit();
    return;
  }
  const win = new BrowserWindow({
    width: 860,
    height: 760,
    minWidth: 720,
    minHeight: 560,
    title: "FB Đăng Bài Admin",
    autoHideMenuBar: true,
    backgroundColor: "#10140f",
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.loadURL(`http://127.0.0.1:${PORT}/`);
});

app.on("window-all-closed", () => {
  stopServer();
  app.quit();
});

app.on("before-quit", stopServer);
