import crypto from "crypto";
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { homeDir } from "./home.js";
import { formatVn } from "./time.js";

/** Shipped in the app. The private key stays in keys/ and is never packaged. */
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAHTeGf4ZxrRnLQjKGmpNig7Z0FhTnN5t28HsrvFtGioU=
-----END PUBLIC KEY-----`;

const CODE_RE = /^[0-9A-F]{4}(?:-[0-9A-F]{4}){3}$/;
const SKEW_MS = 120000;
const SEEN_GAP_MS = 60000;

let cachedCode = "";

function fail(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function licensePath() {
  return path.join(homeDir(), "license.json");
}

function formatCode(hex16) {
  const text = hex16.toUpperCase();
  return `${text.slice(0, 4)}-${text.slice(4, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}`;
}

function windowsMachineGuid() {
  if (process.platform !== "win32") return "";
  try {
    const out = execFileSync(
      "reg",
      ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"],
      { encoding: "utf8", windowsHide: true, timeout: 4000 }
    );
    const match = out.match(/MachineGuid\s+REG_SZ\s+(\S+)/);
    return match ? match[1].trim() : "";
  } catch {
    return "";
  }
}

function fallbackMachineId() {
  const file = path.join(homeDir(), "machine-id.txt");
  try {
    const saved = fs.readFileSync(file, "utf8").trim();
    if (/^[0-9a-fA-F-]{8,80}$/.test(saved)) return saved;
  } catch {
    /* first run on a machine with no MachineGuid */
  }
  const created = crypto.randomUUID();
  fs.writeFileSync(file, created, "utf8");
  return created;
}

/** Stable per PC. MachineGuid does not change when Node or the user name changes. */
export function machineCode() {
  if (cachedCode) return cachedCode;
  const raw = windowsMachineGuid() || fallbackMachineId();
  cachedCode = formatCode(crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16));
  return cachedCode;
}

export function licenseMessage(reason) {
  if (reason === "missing") return "Nhập key để dùng.";
  if (reason === "expired") return "Key đã hết hạn.";
  if (reason === "machine") return "Key không đúng máy này.";
  if (reason === "clock") return "Giờ máy bị lùi. Chỉnh lại giờ rồi mở app.";
  return "Key không hợp lệ.";
}

function decodePart(text) {
  if (!text || /[^A-Za-z0-9_-]/.test(text)) return null;
  const buf = Buffer.from(text, "base64url");
  return buf.length ? buf : null;
}

export function readLicenseToken(token) {
  const text = String(token || "").replace(/\s+/g, "");
  const parts = text.split(".");
  if (parts.length !== 3 || parts[0] !== "FBDB1") throw fail("Key không đúng dạng", "bad");
  const payload = decodePart(parts[1]);
  const sig = decodePart(parts[2]);
  if (!payload || !sig) throw fail("Key không đúng dạng", "bad");
  let valid = false;
  try {
    valid = crypto.verify(null, payload, PUBLIC_KEY, sig);
  } catch {
    valid = false;
  }
  if (!valid) throw fail("Key không hợp lệ", "bad");
  let body;
  try {
    body = JSON.parse(payload.toString("utf8"));
  } catch {
    throw fail("Key không hợp lệ", "bad");
  }
  if (!body || body.v !== 1 || typeof body.name !== "string" || !body.name.trim()) {
    throw fail("Key không hợp lệ", "bad");
  }
  if (!Number.isInteger(body.exp) || typeof body.mid !== "string" || !CODE_RE.test(body.mid)) {
    throw fail("Key không hợp lệ", "bad");
  }
  return { v: 1, name: body.name, exp: body.exp, id: String(body.id || ""), mid: body.mid };
}

export function signLicense(input, privatePem) {
  const name = String(input.name || "").trim().slice(0, 80);
  const exp = Number(input.exp);
  const mid = String(input.mid || "").trim().toUpperCase();
  const id = String(input.id || crypto.randomBytes(6).toString("hex"));
  if (!name) throw new Error("Thiếu tên");
  if (!Number.isInteger(exp)) throw new Error("Thiếu hạn");
  if (!CODE_RE.test(mid)) throw new Error("Mã máy không đúng dạng");
  const payload = Buffer.from(JSON.stringify({ v: 1, name, exp, id, mid }));
  const sig = crypto.sign(null, payload, privatePem);
  return `FBDB1.${payload.toString("base64url")}.${sig.toString("base64url")}`;
}

function loadStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(licensePath(), "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

function clockRolledBack(seen, now) {
  return typeof seen === "number" && now + SKEW_MS < seen;
}

function view(body, reason, machine) {
  return {
    ok: !reason,
    machine,
    name: body?.name || "",
    exp: body?.exp ?? null,
    exp_vn: body?.exp ? formatVn(body.exp) : "",
    reason: reason || "",
  };
}

function touchSeen(store, now) {
  if (typeof store.seen !== "number" || now < store.seen + SEEN_GAP_MS) return;
  store.seen = now;
  fs.writeFileSync(licensePath(), JSON.stringify(store));
}

export function licenseStatus(now = Date.now()) {
  const machine = machineCode();
  const store = loadStore();
  if (!store || typeof store.key !== "string") return view(null, "missing", machine);
  if (clockRolledBack(store.seen, now)) return view(null, "clock", machine);
  let body;
  try {
    body = readLicenseToken(store.key);
  } catch {
    return view(null, "bad", machine);
  }
  if (body.mid !== machine) return view(body, "machine", machine);
  if (body.exp * 1000 <= now) return view(body, "expired", machine);
  touchSeen(store, now);
  return view(body, "", machine);
}

export function activateLicense(token, now = Date.now()) {
  const body = readLicenseToken(token);
  const machine = machineCode();
  if (body.mid !== machine) throw fail(licenseMessage("machine"), "machine");
  if (body.exp * 1000 <= now) throw fail(licenseMessage("expired"), "expired");
  const prev = loadStore();
  if (prev && clockRolledBack(prev.seen, now)) throw fail(licenseMessage("clock"), "clock");
  let seen = now;
  if (prev && typeof prev.seen === "number" && prev.seen > seen) seen = prev.seen;
  const key = String(token).replace(/\s+/g, "");
  fs.writeFileSync(licensePath(), JSON.stringify({ key, seen }));
  return licenseStatus(now);
}
