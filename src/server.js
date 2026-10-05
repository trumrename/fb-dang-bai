import fs from "fs";
import http from "http";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { deleteAccount, importTokens, listAccounts, listPages, setPageFolder, syncAccount } from "./accounts.js";
import { getDb } from "./db.js";
import { createPickGroup, deletePickGroup, listPickGroups } from "./groups.js";
import {
  createCommentJob,
  createJob,
  createRetryJob,
  previewRetry,
  currentSettings,
  rememberSettings,
  previewJob,
  getJob,
  listJobs,
  listLogs,
  logsCsv,
  pauseJob,
  recoverInterruptedJobs,
  resumeJob,
  stopJob,
} from "./jobs.js";
import { activateLicense, licenseMessage, licenseStatus } from "./license.js";
import { pickFolder, pickTextFile } from "./picker.js";
import { releaseApply, requestApply, settleUpdateState, startUpdateLoop, updateStatus } from "./update.js";

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));

function send(res, status, body, headers = {}) {
  const json = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(json);
}

function sendFile(res, file) {
  const ext = path.extname(file);
  const type = ext === ".css" ? "text/css" : ext === ".js" ? "text/javascript" : "text/html";
  res.writeHead(200, { "Content-Type": `${type}; charset=utf-8`, "Cache-Control": "no-store" });
  fs.createReadStream(file).pipe(res);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 2_000_000) {
        reject(new Error("Dữ liệu quá lớn"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("JSON không hợp lệ"));
      }
    });
    req.on("error", reject);
  });
}

async function route(req, res) {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const pathname = url.pathname;
  if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
    return sendFile(res, path.join(publicDir, "index.html"));
  }
  if (req.method === "GET" && (pathname === "/app.js" || pathname === "/app.css")) {
    return sendFile(res, path.join(publicDir, pathname.slice(1)));
  }
  if (req.method === "GET" && pathname === "/api/health") {
    return send(res, 200, { ok: true, name: "FB Đăng Bài", version: pkg.version });
  }
  if (req.method === "GET" && pathname === "/api/license") {
    return send(res, 200, licenseStatus());
  }
  if (req.method === "GET" && pathname === "/api/update") {
    return send(res, 200, updateStatus());
  }
  if (req.method === "POST" && pathname === "/api/license/activate") {
    const body = await readJson(req);
    return send(res, 200, activateLicense(body.key));
  }
  if (req.method === "POST" && pathname === "/api/update/apply") {
    const result = requestApply();
    return send(res, result.status, result.body);
  }
  if (req.method === "POST" && pathname === "/api/update/release") {
    releaseApply();
    return send(res, 200, updateStatus());
  }

  const license = licenseStatus();
  if (!license.ok) {
    if (req.method === "POST" || req.method === "PUT" || req.method === "DELETE") req.resume();
    return send(res, 403, { error: licenseMessage(license.reason) });
  }

  if (req.method === "GET" && pathname === "/api/accounts") return send(res, 200, { accounts: listAccounts() });
  if (req.method === "GET" && pathname === "/api/pages") return send(res, 200, { pages: listPages() });
  if (req.method === "GET" && pathname === "/api/groups") return send(res, 200, listPickGroups());
  if (req.method === "GET" && pathname === "/api/settings") return send(res, 200, currentSettings());
  if (req.method === "GET" && pathname === "/api/jobs") return send(res, 200, { jobs: listJobs() });
  if (req.method === "GET" && pathname === "/api/logs") return send(res, 200, { logs: listLogs() });
  if (req.method === "GET" && pathname === "/api/logs.csv") {
    return send(res, 200, logsCsv(), {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": "attachment; filename=nhat-ky-dang.csv",
    });
  }

  if (req.method === "GET" && pathname === "/api/jobs/retry") {
    return send(res, 200, previewRetry());
  }

  const jobGet = pathname.match(/^\/api\/jobs\/([^/]+)$/);
  if (req.method === "GET" && jobGet) {
    const job = getJob(jobGet[1]);
    if (!job) return send(res, 404, { error: "Không thấy job" });
    return send(res, 200, { job });
  }

  const body = ["POST", "PUT", "DELETE"].includes(req.method) ? await readJson(req) : {};

  if (req.method === "POST" && pathname === "/api/settings") {
    rememberSettings(body);
    return send(res, 200, currentSettings());
  }
  if (req.method === "POST" && pathname === "/api/groups") {
    return send(res, 200, createPickGroup(body));
  }
  const removeGroup = pathname.match(/^\/api\/groups\/([^/]+)$/);
  if (req.method === "DELETE" && removeGroup) {
    return send(res, 200, deletePickGroup(removeGroup[1]));
  }
  if (req.method === "POST" && pathname === "/api/accounts/import") {
    const results = await importTokens(body.token, body.name);
    return send(res, 200, { results, accounts: listAccounts(), pages: listPages() });
  }
  const sync = pathname.match(/^\/api\/accounts\/(\d+)\/sync$/);
  if (req.method === "POST" && sync) {
    const result = await syncAccount(Number(sync[1]));
    return send(res, 200, { result, accounts: listAccounts(), pages: listPages() });
  }
  const remove = pathname.match(/^\/api\/accounts\/(\d+)$/);
  if (req.method === "DELETE" && remove) {
    deleteAccount(Number(remove[1]));
    return send(res, 200, { ok: true, accounts: listAccounts(), pages: listPages() });
  }
  const pagePut = pathname.match(/^\/api\/pages\/(\d+)$/);
  if (req.method === "PUT" && pagePut) {
    setPageFolder(Number(pagePut[1]), body.media_folder);
    return send(res, 200, { pages: listPages() });
  }
  if (req.method === "POST" && pathname === "/api/pick-folder") {
    const picked = await pickFolder(body.title, body.initial_dir);
    return send(res, 200, picked
      ? { ok: true, cancelled: false, path: picked }
      : { ok: false, cancelled: true, path: null });
  }
  if (req.method === "POST" && pathname === "/api/pick-file") {
    const picked = await pickTextFile(body.title, body.initial_dir);
    return send(res, 200, picked
      ? { ok: true, cancelled: false, path: picked }
      : { ok: false, cancelled: true, path: null });
  }
  if (req.method === "POST" && pathname === "/api/jobs/preview") {
    return send(res, 200, { preview: previewJob(body) });
  }
  if (req.method === "POST" && pathname === "/api/jobs/now") {
    return send(res, 200, { job: createJob({ ...body, delivery: "now" }) });
  }
  if (req.method === "POST" && pathname === "/api/jobs/schedule") {
    return send(res, 200, { job: createJob({ ...body, delivery: "schedule" }) });
  }
  if (req.method === "POST" && pathname === "/api/jobs/direct") {
    return send(res, 200, { job: createJob({ ...body, delivery: "direct" }) });
  }
  if (req.method === "POST" && pathname === "/api/jobs/retry") {
    return send(res, 200, { job: createRetryJob() });
  }
  if (req.method === "POST" && pathname === "/api/comments/send-pending") {
    return send(res, 200, { job: createCommentJob() });
  }
  const jobAction = pathname.match(/^\/api\/jobs\/([^/]+)\/(stop|pause|resume)$/);
  if (req.method === "POST" && jobAction) {
    const id = jobAction[1];
    const action = jobAction[2];
    const job = action === "stop" ? stopJob(id) : action === "pause" ? pauseJob(id) : resumeJob(id);
    return send(res, 200, { job });
  }
  send(res, 404, { error: "Không có đường dẫn này" });
}

export function startServer(port = Number(process.env.PORT || 3871), host = process.env.HOST || "127.0.0.1") {
  getDb();
  recoverInterruptedJobs();
  settleUpdateState();
  startUpdateLoop();
  const server = http.createServer(async (req, res) => {
    try {
      await route(req, res);
    } catch (e) {
      if (!res.headersSent) send(res, 400, { error: e.message || String(e) });
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  const port = Number(process.env.PORT || 3871);
  startServer(port).then(() => {
    console.log(`FB Đăng Bài http://127.0.0.1:${port}`);
  });
}
