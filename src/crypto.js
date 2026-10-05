import crypto from "crypto";
import fs from "fs";
import path from "path";
import { homeDir } from "./home.js";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;

function keyBytes() {
  const file = path.join(homeDir(), "secret.key");
  let hex = "";
  if (fs.existsSync(file)) hex = fs.readFileSync(file, "utf8").trim();
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    hex = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(file, hex, { encoding: "utf8", mode: 0o600 });
  }
  return Buffer.from(hex, "hex");
}

export function encryptToken(plaintext) {
  if (!plaintext) return null;
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, keyBytes(), iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

export function decryptToken(payload) {
  if (!payload) return null;
  const buf = Buffer.from(payload, "base64");
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const data = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGO, keyBytes(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

export function tokenHash(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

export function maskToken(token) {
  const s = String(token || "");
  if (s.length < 12) return "***";
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}
