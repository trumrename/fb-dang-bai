import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import { readLicenseToken } from "../src/license.js";
import { vnEndOfDayUnix } from "../src/time.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "fb-dangbai-admin-"));
process.env.FB_DANGBAI_ADMIN_HOME = home;
const { startAdminServer } = await import("../admin/server.js");

const server = await startAdminServer(0);
const base = `http://127.0.0.1:${server.address().port}`;
const html = await fetch(`${base}/`).then((res) => res.text());
assert.match(html, /FB Đăng Bài Admin/);
assert.match(html, /Tạo key/);
assert.match(html, /Mã máy của khách/);
assert.equal(html.includes("license-private"), false);
assert.equal(html.includes("Đăng ngay API"), false);

const bad = await fetch(`${base}/api/key`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "", machine: "AAAA-BBBB-CCCC-DDDD", days: 30 }),
});
assert.equal(bad.status, 400);

const both = await fetch(`${base}/api/key`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "A", machine: "AAAA-BBBB-CCCC-DDDD", days: 30, until: "2027-01-01" }),
});
assert.equal(both.status, 400);

const made = await fetch(`${base}/api/key`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "Shop Lan", machine: "abcd-ef12-3456-7890", until: "2027-01-01" }),
});
const body = await made.json();
assert.equal(made.status, 200, body.error);
const parsed = readLicenseToken(body.key);
assert.equal(parsed.name, "Shop Lan");
assert.equal(parsed.mid, "ABCD-EF12-3456-7890");
assert.equal(parsed.exp, vnEndOfDayUnix("2027-01-01"));
const issued = await fetch(`${base}/api/issued`).then((res) => res.json());
assert.equal(issued.issued[0].name, "Shop Lan");
assert.equal(fs.existsSync(path.join(home, "issued.log")), true);

await new Promise((resolve) => server.close(resolve));
fs.rmSync(home, { recursive: true, force: true });
console.log("admin-self-test ok");
