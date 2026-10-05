import fs from "fs";
import path from "path";
import { getDb, getSetting, setSetting } from "./db.js";

const VIDEO_EXT = new Set([".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v"]);
const PHOTO_EXT = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"]);

export function normPath(filePath) {
  return path.resolve(String(filePath || "")).toLowerCase();
}

export function listMediaFiles(folder, kind, opts = {}) {
  const dir = String(folder || "").trim();
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  const allow = kind === "photo" ? PHOTO_EXT : VIDEO_EXT;
  const used = opts.includeUsed ? new Set() : usedMediaPaths();
  return fs.readdirSync(dir)
    .map((name) => path.join(dir, name))
    .filter((file) => {
      try {
        const st = fs.statSync(file);
        if (!st.isFile() || st.size <= 0) return false;
      } catch {
        return false;
      }
      return allow.has(path.extname(file).toLowerCase());
    })
    .filter((file) => !used.has(normPath(file)))
    .sort((a, b) => path.basename(a).localeCompare(path.basename(b), "vi"));
}

export function fileAtRound(folder, kind, round) {
  const files = listMediaFiles(folder, kind, { includeUsed: true });
  const index = Number(round) - 1;
  if (!files.length || index < 0 || index >= files.length) {
    const err = new Error(`Hết file. Thư mục có ${files.length} file, cần bài số ${round}.`);
    err.permanent = true;
    throw err;
  }
  return files[index];
}

export function claimNextFile(folder, kind, reserved) {
  const files = listMediaFiles(folder, kind);
  for (const file of files) {
    const key = normPath(file);
    if (reserved.has(key)) continue;
    reserved.add(key);
    return file;
  }
  const err = new Error("Hết file chưa đăng trong thư mục");
  err.permanent = true;
  throw err;
}

function usedMediaPaths() {
  const rows = getDb().prepare(
    `SELECT media_path FROM post_logs
     WHERE media_path IS NOT NULL AND TRIM(media_path) != ''
       AND status IN ('ok', 'scheduled', 'unknown')`
  ).all();
  return new Set(rows.map((r) => normPath(r.media_path)));
}

export function readTextLines(filePath) {
  const file = String(filePath || "").trim();
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) return [];
  const raw = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  const lines = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (file.toLowerCase().endsWith(".csv")) {
      const cell = splitCsv(trimmed)[0] || "";
      const value = cell.trim();
      if (!value || value.toLowerCase() === "caption" || value.toLowerCase() === "comment") continue;
      lines.push(value);
    } else {
      lines.push(trimmed);
    }
  }
  return lines;
}

function splitCsv(line) {
  const out = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function cursorKey(filePath) {
  return `cursor:${normPath(filePath)}`;
}

/** Next line in a shared file. The index advances and wraps. */
export function takeNextLine(filePath) {
  const lines = readTextLines(filePath);
  if (!lines.length) return "";
  const key = cursorKey(filePath);
  const index = Number(getSetting(key, "0")) || 0;
  const line = lines[index % lines.length];
  setSetting(key, String((index + 1) % lines.length));
  return line;
}

/** Line for round N, same line for every page. Does not move the shared cursor. */
export function lineAt(filePath, round) {
  const lines = readTextLines(filePath);
  if (!lines.length) return "";
  const index = Math.max(0, Number(round) - 1);
  return lines[index % lines.length];
}

function uniqueDest(destDir, filePath) {
  let dest = path.join(destDir, path.basename(filePath));
  if (!fs.existsSync(dest)) return dest;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  dest = path.join(destDir, `${base}-${stamp}${ext}`);
  if (!fs.existsSync(dest)) return dest;
  return path.join(destDir, `${base}-${stamp}-${process.pid}${ext}`);
}

function copyThenDelete(src, dest) {
  fs.copyFileSync(src, dest);
  try {
    fs.unlinkSync(src);
  } catch (delErr) {
    try {
      fs.rmSync(src, { force: true });
    } catch {
      /* giữ lỗi xóa gốc */
    }
    if (fs.existsSync(src)) {
      throw new Error(`Đã chép sang folder posted nhưng chưa xóa được file gốc: ${delErr.message || delErr}`);
    }
  }
}

/** Move a posted file. Empty postedFolder uses the sibling folder da-dang. Same drive renames. Another drive copies, then deletes the source. */
export function moveToPosted(filePath, postedFolder = "") {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(`Không thấy file để chuyển: ${filePath}`);
  }
  const src = path.resolve(filePath);
  const chosen = String(postedFolder || "").trim();
  const destDir = chosen ? path.resolve(chosen) : path.join(path.dirname(src), "da-dang");
  fs.mkdirSync(destDir, { recursive: true });
  const dest = uniqueDest(destDir, src);
  const sameDrive = path.parse(src).root.toLowerCase() === path.parse(dest).root.toLowerCase();
  if (sameDrive) {
    try {
      fs.renameSync(src, dest);
      return dest;
    } catch (e) {
      const code = e && e.code;
      if (code && code !== "EXDEV" && code !== "EPERM" && code !== "EACCES") throw e;
    }
  }
  copyThenDelete(src, dest);
  return dest;
}
