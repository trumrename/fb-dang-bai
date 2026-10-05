import { spawn } from "child_process";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "fbdb-click-"));
const hits = [];
const graph = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    res.setHeader("content-type", "application/json");
    if (req.method === "POST" && /\/feed/.test(req.url || "")) {
      hits.push(req.url || "");
      const id = (req.url || "").includes("/100/") ? "100_77" : "99_77";
      res.end(JSON.stringify({ id }));
      return;
    }
    res.end(JSON.stringify({ id: "99_77", permalink_url: "https://www.facebook.com/99_77" }));
  });
});
await new Promise((resolve) => graph.listen(0, "127.0.0.1", resolve));
process.env.FB_DANGBAI_HOME = home;
process.env.FB_DANGBAI_GRAPH_ORIGIN = `http://127.0.0.1:${graph.address().port}`;

const { startServer } = await import("../src/server.js");
const { getDb, closeDb } = await import("../src/db.js");
const { encryptToken } = await import("../src/crypto.js");
const { machineCode, signLicense } = await import("../src/license.js");

const server = await startServer(0);
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
const key = signLicense(
  { name: "Click Test", exp: Math.floor(Date.now() / 1000) + 86400, mid: machineCode() },
  fs.readFileSync(path.join(root, "keys", "license-private.pem"), "utf8")
);
const turnedOn = await fetch(`${base}/api/license/activate`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ key }),
});
if (turnedOn.status !== 200) throw new Error(await turnedOn.text());
const token = encryptToken("click-token-1234567890");
const db = getDb();
for (const [n, pageId, name] of [[1, "99", "Page Mot"], [2, "100", "Page Hai"]]) {
  const account = db.prepare(
    `INSERT INTO accounts (token_hash, name, fb_user_id, kind, token_enc) VALUES (?, ?, ?, 'user', ?)`
  ).run(`click-${n}`, name, String(n), token);
  db.prepare(
    `INSERT INTO pages (account_id, page_id, name, token_enc, status) VALUES (?, ?, ?, ?, 'active')`
  ).run(account.lastInsertRowid, pageId, name, token);
}

const electron = path.join(root, "node_modules", "electron", "dist", "electron.exe");
const env = { ...process.env, FB_DANGBAI_TEST_URL: `${base}/` };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [path.join(root, "scripts", "click-window.cjs")], {
  cwd: root,
  env,
  windowsHide: true,
});
let output = "";
child.stdout.on("data", (chunk) => { output += chunk; });
child.stderr.on("data", (chunk) => { output += chunk; });
const code = await new Promise((resolve) => child.on("exit", resolve));
await new Promise((resolve) => server.close(resolve));
await new Promise((resolve) => graph.close(resolve));
closeDb();
fs.rmSync(home, { recursive: true, force: true });
if (code !== 0 || !output.includes("click ok")) {
  console.error(output);
  console.error(`graph posts ${hits.join(" ")}`);
  process.exit(1);
}
if (!hits.some((url) => url.includes("/99/feed")) || !hits.some((url) => url.includes("/100/feed"))) {
  console.error(hits);
  process.exit(1);
}
console.log("click-test ok");
