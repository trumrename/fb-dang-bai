import fs from "fs";
import http from "http";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { signLicense } from "../src/license.js";
import { formatVn, vnEndOfDayUnix } from "../src/time.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, "public");
const privatePath = path.join(here, "..", "keys", "license-private.pem");

function homeDir() {
  const dir = process.env.FB_DANGBAI_ADMIN_HOME
    ? path.resolve(process.env.FB_DANGBAI_ADMIN_HOME)
    : path.join(here, "..", "data-admin");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
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
      if (size > 100000) {
        reject(new Error("Dữ liệu quá lớn"));
        req.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("JSON không hợp lệ"));
      }
    });
    req.on("error", reject);
  });
}

function issuedFile() {
  return path.join(homeDir(), "issued.log");
}

function readIssued(limit = 30) {
  try {
    const lines = fs.readFileSync(issuedFile(), "utf8").trim().split(/\r?\n/).filter(Boolean);
    return lines.slice(-limit).reverse().map((line) => {
      const [at, name, machine, exp, key] = line.split("\t");
      return { at, name, machine, exp: Number(exp) || null, exp_vn: formatVn(Number(exp)), key };
    });
  } catch {
    return [];
  }
}

function makeKey(body) {
  const name = String(body.name || "").trim();
  const machine = String(body.machine || "").trim().toUpperCase();
  const until = String(body.until || "").trim();
  const daysText = String(body.days ?? "").trim();
  if (!name) throw new Error("Nhập tên khách");
  if (!machine) throw new Error("Nhập mã máy của khách");
  if (until && daysText) throw new Error("Chỉ chọn số ngày hoặc chọn đến ngày");
  let exp;
  if (until) exp = vnEndOfDayUnix(until);
  else {
    const days = Number(daysText || 30);
    if (!Number.isInteger(days) || days < 1 || days > 3650) throw new Error("Số ngày từ 1 đến 3650");
    exp = Math.floor(Date.now() / 1000) + days * 86400;
  }
  const privatePem = fs.readFileSync(privatePath, "utf8");
  const key = signLicense({ name, exp, mid: machine }, privatePem);
  fs.appendFileSync(issuedFile(), `${new Date().toISOString()}\t${name}\t${machine}\t${exp}\t${key}\n`, "utf8");
  return { key, name, machine, exp, exp_vn: formatVn(exp) };
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
  if (req.method === "GET" && pathname === "/api/issued") {
    return send(res, 200, { issued: readIssued() });
  }
  if (req.method === "POST" && pathname === "/api/key") {
    const body = await readJson(req);
    return send(res, 200, makeKey(body));
  }
  send(res, 404, { error: "Không có đường dẫn này" });
}

export function startAdminServer(port = Number(process.env.PORT || 3872), host = process.env.HOST || "127.0.0.1") {
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
  const port = Number(process.env.PORT || 3872);
  startAdminServer(port).then(() => {
    console.log(`FB Đăng Bài Admin http://127.0.0.1:${port}`);
  });
}
