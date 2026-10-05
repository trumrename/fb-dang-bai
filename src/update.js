import crypto from "crypto";
import fs from "fs";
import http from "http";
import https from "https";
import path from "path";
import { homeDir } from "./home.js";
import { hasBusyJob } from "./jobs.js";

const MAX_BYTES = 250 * 1024 * 1024;
const DEFAULT_URL = "https://github.com/trumrename/fb-dang-bai/releases/latest/download/latest.json";
const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));

export function currentVersion() {
  return pkg.version;
}

export function compareVersions(left, right) {
  const parse = (value) => String(value || "").split(".").map((part) => {
    const n = parseInt(part, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  });
  const a = parse(left);
  const b = parse(right);
  const count = Math.max(a.length, b.length, 3);
  for (let i = 0; i < count; i += 1) {
    const da = a[i] || 0;
    const db = b[i] || 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

function allowedUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  return url.protocol === "http:" && local;
}

function manifestUrl() {
  const override = process.env.FB_DANGBAI_UPDATE_URL || "";
  if (override.startsWith("http://") && allowedUrl(override)) return override;
  return DEFAULT_URL;
}

function statePath() {
  return path.join(homeDir(), "update-state.json");
}

function idleState() {
  return { phase: "idle", version: "", file: "", notes: "", error: "", checked_at: 0 };
}

function readState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(), "utf8"));
    if (!parsed || typeof parsed !== "object") return idleState();
    return { ...idleState(), ...parsed };
  } catch {
    return idleState();
  }
}

function writeState(state) {
  const next = { ...idleState(), ...state, error: "" };
  fs.writeFileSync(statePath(), JSON.stringify(next));
  return next;
}

export function updateStatus() {
  const state = readState();
  return { phase: state.phase, version: state.version, notes: state.notes || "" };
}

export function settleUpdateState() {
  const state = readState();
  if (state.phase === "downloading") return writeState(idleState());
  const installed = compareVersions(state.version, currentVersion()) <= 0;
  if ((state.phase === "ready" || state.phase === "applying") && installed) {
    if (state.file) fs.rmSync(state.file, { force: true });
    return writeState(idleState());
  }
  if (state.phase === "applying" && state.file && fs.existsSync(state.file)) {
    return writeState({ ...state, phase: "ready" });
  }
  return state;
}

function requestRaw(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!allowedUrl(url)) {
      reject(new Error("url"));
      return;
    }
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err instanceof Error ? err : new Error("network"));
    };
    const lib = url.startsWith("https:") ? https : http;
    const req = lib.get(url, { headers: { "User-Agent": "FBDangBai" }, timeout: timeoutMs }, (res) => {
      if (settled) {
        res.resume();
        return;
      }
      settled = true;
      resolve(res);
    });
    req.on("error", fail);
    req.on("timeout", () => req.destroy(new Error("timeout")));
  });
}

async function follow(url, timeoutMs, redirects = 0) {
  const res = await requestRaw(url, timeoutMs);
  const code = res.statusCode || 0;
  if ([301, 302, 303, 307, 308].includes(code) && res.headers.location && redirects < 4) {
    res.resume();
    const next = new URL(res.headers.location, url).href;
    if (!allowedUrl(next)) throw new Error("url");
    return follow(next, timeoutMs, redirects + 1);
  }
  return res;
}

async function fetchJson(url) {
  const res = await follow(url, 8000);
  if (res.statusCode !== 200) {
    res.resume();
    throw new Error("http");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of res) {
    size += chunk.length;
    if (size > 65536) {
      res.destroy();
      throw new Error("big");
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function setupFile(version) {
  const safe = String(version).replace(/[^0-9A-Za-z._-]/g, "");
  if (!safe) return "";
  return path.join(homeDir(), "updates", `FB-DangBai-Setup-v${safe}.exe`);
}

async function downloadFile(url, partPath, hash) {
  const res = await follow(url, 20000);
  if (res.statusCode !== 200) {
    res.resume();
    throw new Error("http");
  }
  const declared = Number(res.headers["content-length"] || 0);
  if (Number.isFinite(declared) && declared > MAX_BYTES) {
    res.resume();
    throw new Error("size");
  }
  await fs.promises.mkdir(path.dirname(partPath), { recursive: true });
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(partPath);
    let size = 0;
    let failed = null;
    const fail = (err) => {
      if (failed) return;
      failed = err instanceof Error ? err : new Error("download");
      res.destroy();
      out.destroy();
      reject(failed);
    };
    res.on("data", (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > MAX_BYTES) {
        fail(new Error("size"));
        return;
      }
      hash.update(chunk);
      if (!out.write(chunk)) res.pause();
    });
    out.on("drain", () => {
      if (!failed) res.resume();
    });
    res.on("end", () => {
      if (failed) return;
      out.end(resolve);
    });
    res.on("error", fail);
    out.on("error", fail);
  });
}

async function downloadVerified(manifest, previous) {
  const version = String(manifest.version).trim();
  const sha = String(manifest.sha256).trim().toLowerCase();
  const finalPath = setupFile(version);
  if (!finalPath) return previous.phase === "ready" ? previous : writeState(idleState());
  const partPath = `${finalPath}.part`;
  fs.rmSync(partPath, { force: true });
  writeState({ phase: "downloading", version, file: "", notes: "", checked_at: Date.now() });
  const hash = crypto.createHash("sha256");
  try {
    await downloadFile(manifest.url, partPath, hash);
    if (hash.digest("hex") !== sha) {
      fs.rmSync(partPath, { force: true });
      fs.rmSync(finalPath, { force: true });
      if (previous.phase === "ready" && previous.file && previous.file !== finalPath && fs.existsSync(previous.file)) {
        return writeState(previous);
      }
      return writeState(idleState());
    }
    fs.rmSync(finalPath, { force: true });
    fs.renameSync(partPath, finalPath);
    return writeState({
      phase: "ready",
      version,
      file: finalPath,
      notes: String(manifest.notes || "").slice(0, 400),
      checked_at: Date.now(),
    });
  } catch {
    fs.rmSync(partPath, { force: true });
    if (previous.phase === "ready" && previous.file && fs.existsSync(previous.file)) return writeState(previous);
    return writeState(idleState());
  }
}

function keepReady(previous) {
  if (previous.phase === "ready" || previous.phase === "applying") return previous;
  return writeState({ ...idleState(), checked_at: Date.now() });
}

export async function checkOnce(url = manifestUrl()) {
  const previous = readState();
  if (!allowedUrl(url)) return previous;
  let manifest;
  try {
    manifest = await fetchJson(url);
  } catch {
    return keepReady(previous);
  }
  const version = manifest && typeof manifest.version === "string" ? manifest.version.trim() : "";
  const fileUrl = manifest && typeof manifest.url === "string" ? manifest.url.trim() : "";
  const sha = manifest && typeof manifest.sha256 === "string" ? manifest.sha256.trim().toLowerCase() : "";
  if (!version || !fileUrl || !/^[0-9a-f]{64}$/.test(sha) || !allowedUrl(fileUrl)) return keepReady(previous);
  if (compareVersions(version, currentVersion()) <= 0) return keepReady(previous);
  if (previous.phase === "ready" && previous.version === version && previous.file && fs.existsSync(previous.file)) {
    return previous;
  }
  return downloadVerified({ version, url: fileUrl, sha256: sha, notes: manifest.notes }, previous);
}

function isSetupFile(file) {
  const root = `${path.resolve(homeDir(), "updates")}${path.sep}`;
  const resolved = path.resolve(String(file || ""));
  return resolved.toLowerCase().endsWith(".exe") && resolved.toLowerCase().startsWith(root.toLowerCase());
}

export function takeReadyUpdate() {
  const state = readState();
  if (state.phase !== "ready" || !isSetupFile(state.file) || !fs.existsSync(state.file)) {
    if (state.phase === "ready") writeState(idleState());
    return null;
  }
  writeState({ ...state, phase: "applying" });
  return { file: state.file, version: state.version };
}

export function releaseApply() {
  const state = readState();
  if (state.phase !== "applying") return state;
  if (!isSetupFile(state.file) || !fs.existsSync(state.file)) return writeState(idleState());
  return writeState({ ...state, phase: "ready" });
}

export function requestApply() {
  if (process.env.FB_DANGBAI_PACKAGED !== "1") {
    return { status: 400, body: { error: "Chỉ bản đã cài mới tự cập nhật." } };
  }
  const state = readState();
  if (state.phase !== "ready" || !state.file) {
    return { status: 400, body: { error: "Chưa có bản cập nhật." } };
  }
  if (hasBusyJob()) {
    return { status: 409, body: { error: "Đang có job chạy. Cập nhật khi job xong." } };
  }
  const taken = takeReadyUpdate();
  if (!taken) return { status: 400, body: { error: "Chưa có bản cập nhật." } };
  return { status: 200, body: { ok: true, file: taken.file, version: taken.version } };
}

let loop = null;

export function startUpdateLoop() {
  if (process.env.FB_DANGBAI_PACKAGED !== "1" || loop) return;
  const run = () => {
    checkOnce().catch(() => {});
  };
  const first = setTimeout(run, 15000);
  const every = setInterval(run, 6 * 60 * 60 * 1000);
  first.unref();
  every.unref();
  loop = { first, every };
}

export function stopUpdateLoop() {
  if (!loop) return;
  clearTimeout(loop.first);
  clearInterval(loop.every);
  loop = null;
}
