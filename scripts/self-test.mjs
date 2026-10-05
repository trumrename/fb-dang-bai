import assert from "assert";
import crypto from "crypto";
import { spawnSync } from "child_process";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "fb-dangbai-"));
process.env.FB_DANGBAI_HOME = home;

const { vnLocalToUnix, validateScheduleUnix, vnEndOfDayUnix } = await import("../src/time.js");
const { isCommunitySpamBlock, isRateLimit, isTransient } = await import("../src/graph.js");
const {
  parseCountryRestriction,
  directVideoFields,
  scheduledVideoFields,
  shouldDropTargeting,
  firstUrl,
  commentWaitingForPublish,
} = await import("../src/publish.js");
const { encryptToken, decryptToken } = await import("../src/crypto.js");
const { getDb, closeDb } = await import("../src/db.js");
const { listMediaFiles, fileAtRound, takeNextLine, lineAt, moveToPosted } = await import("../src/media.js");
const { planJob, previewJob, commentAction, recoverInterruptedJobs } = await import("../src/jobs.js");
const { composeCaption, composeComment, ensureIncreasing, parseScheduleList, vnDayKey } = await import("../src/content.js");
const { machineCode, signLicense, readLicenseToken, licenseStatus, activateLicense } = await import("../src/license.js");
const { compareVersions, checkOnce, releaseApply, settleUpdateState } = await import("../src/update.js");
const { startServer } = await import("../src/server.js");

const now = 1_800_000_000;
assert.equal(vnLocalToUnix("2026-10-06T18:00"), Date.UTC(2026, 9, 6, 11, 0, 0) / 1000);
assert.equal(validateScheduleUnix(now + 11 * 60, now), now + 11 * 60);
assert.throws(() => validateScheduleUnix(now + 5 * 60, now), /10 phút/);
assert.throws(() => validateScheduleUnix(now + 181 * 24 * 60 * 60, now), /180 ngày/);

assert.equal(isCommunitySpamBlock({ error_subcode: 1390008, message: "anything" }), true);
assert.equal(isCommunitySpamBlock({ message: "We limit how often you can post to protect the community from spam" }), true);
assert.equal(isCommunitySpamBlock({ code: 368, message: "This page is not allowed to post that" }), false);
assert.equal(isRateLimit({ message: "We limit how often you can post to protect the community from spam" }), false);
assert.equal(isTransient({ message: "We limit how often you can post to protect the community from spam" }), false);
assert.equal(isTransient({ code: 4, message: "Application request limit reached" }), true);
assert.equal(isTransient({ code: "MEDIA_FILE_EMPTY", permanent: true, message: "empty" }), false);

const restriction = parseCountryRestriction({ restriction_type: "blacklist", countries: ["vn", "US", "bad"] });
assert.deepEqual(restriction, { type: "blacklist", countries: ["VN", "US"] });
const direct = directVideoFields("hello", restriction);
assert.equal(direct.embeddable, "1");
assert.equal(direct.published, "true");
assert.equal(Object.hasOwn(direct, "targeting"), false);
assert.equal(direct.secret, "0");
const allowed = directVideoFields("hello", { type: "whitelist", countries: ["US"] });
assert.ok(allowed.targeting.includes("US"));
assert.equal(allowed.embeddable, "1");
const scheduled = scheduledVideoFields("hello", now + 3600);
assert.equal(scheduled.published, "false");
assert.equal(scheduled.unpublished_content_type, "SCHEDULED");
assert.equal(scheduled.embeddable, "true");
assert.equal(scheduled.secret, "false");
assert.equal(Object.hasOwn(scheduled, "targeting"), false);
assert.equal(Object.hasOwn(scheduled, "title"), false);
const titled = scheduledVideoFields("hello", now + 3600, "  Ten   ngan  ");
assert.equal(titled.title, "Ten ngan");
assert.equal(titled.embeddable, "true");
assert.equal(scheduledVideoFields("hello", now + 3600, "x".repeat(300)).title.length, 255);
assert.equal(shouldDropTargeting({ code: 100, message: "targeting countries overlap" }, allowed), true);
assert.equal(shouldDropTargeting({ code: 100, message: "targeting countries overlap" }, direct), false);
assert.equal(firstUrl("xem https://example.com/a). nhe"), "https://example.com/a");
assert.equal(commentWaitingForPublish({ message: "The post is not published" }), true);
assert.equal(commentWaitingForPublish({ message: "protect the community from spam" }), false);

assert.equal(decryptToken(encryptToken("token-abc-123456")), "token-abc-123456");

const folder = path.join(home, "media");
fs.mkdirSync(folder);
fs.writeFileSync(path.join(folder, "empty.mp4"), "");
fs.writeFileSync(path.join(folder, "b.mp4"), "video");
fs.writeFileSync(path.join(folder, "a.mp4"), "video");
fs.writeFileSync(path.join(folder, "note.txt"), "nope");
assert.deepEqual(listMediaFiles(folder, "video").map((file) => path.basename(file)), ["a.mp4", "b.mp4"]);
assert.equal(path.basename(fileAtRound(folder, "video", 2)), "b.mp4");
assert.throws(() => fileAtRound(folder, "video", 3), /Hết file/);

const cap = path.join(home, "cap.txt");
fs.writeFileSync(cap, "# skip\nMot\nHai\n");
assert.equal(takeNextLine(cap), "Mot");
assert.equal(takeNextLine(cap), "Hai");
assert.equal(takeNextLine(cap), "Mot");
assert.equal(lineAt(cap, 2), "Hai");

const moveDir = path.join(home, "move-src");
fs.mkdirSync(moveDir);
const clip = path.join(moveDir, "clip.mp4");
fs.writeFileSync(clip, "clip");
const postedDir = path.join(home, "posted");
const movedClip = moveToPosted(clip, postedDir);
assert.equal(fs.existsSync(clip), false);
assert.equal(fs.readFileSync(movedClip, "utf8"), "clip");
assert.equal(path.basename(movedClip), "clip.mp4");
fs.writeFileSync(clip, "clip-2");
const movedAgain = moveToPosted(clip, postedDir);
assert.equal(fs.existsSync(clip), false);
assert.notEqual(path.basename(movedAgain), "clip.mp4");
assert.equal(fs.readFileSync(movedAgain, "utf8"), "clip-2");
const near = path.join(moveDir, "near.mp4");
fs.writeFileSync(near, "near");
const movedNear = moveToPosted(near, "");
assert.equal(fs.existsSync(near), false);
assert.equal(path.basename(path.dirname(movedNear)), "da-dang");
assert.equal(fs.readFileSync(movedNear, "utf8"), "near");
function otherDriveDir() {
  const here = path.parse(home).root.toLowerCase();
  for (const letter of ["C", "D", "E", "F", "G"]) {
    const rootDrive = `${letter}:\\`;
    if (rootDrive.toLowerCase() === here) continue;
    const dir = path.join(rootDrive, `fbdb-move-${process.pid}`);
    try {
      fs.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, ".write");
      fs.writeFileSync(probe, "ok");
      fs.unlinkSync(probe);
      return dir;
    } catch {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ổ không ghi được */ }
    }
  }
  return "";
}
const otherPosted = otherDriveDir();
if (otherPosted) {
  try {
    const cross = path.join(moveDir, "cross.mp4");
    fs.writeFileSync(cross, "cross");
    const movedCross = moveToPosted(cross, otherPosted);
    assert.equal(fs.existsSync(cross), false);
    assert.equal(fs.readFileSync(movedCross, "utf8"), "cross");
    assert.notEqual(path.parse(cross).root.toLowerCase(), path.parse(movedCross).root.toLowerCase());
  } finally {
    fs.rmSync(otherPosted, { recursive: true, force: true });
  }
}

const db = getDb();
const token = encryptToken("page-token-1234567890abcdef");
const account = db.prepare(
  `INSERT INTO accounts (token_hash, name, fb_user_id, kind, token_enc) VALUES ('hash', 'Test', '1', 'page', ?)`
).run(token);
const page = db.prepare(
  `INSERT INTO pages (account_id, page_id, name, token_enc, status) VALUES (?, '99', 'Page Test', ?, 'active')`
).run(account.lastInsertRowid, token);

const ahead = new Date(Date.now() + 2 * 60 * 60 * 1000);
const pad = (n) => String(n).padStart(2, "0");
const vn = new Date(ahead.getTime() + 7 * 60 * 60 * 1000);
const start = `${vn.getUTCFullYear()}-${pad(vn.getUTCMonth() + 1)}-${pad(vn.getUTCDate())}T${pad(vn.getUTCHours())}:${pad(vn.getUTCMinutes())}`;
const plan = planJob({
  delivery: "schedule",
  page_ids: [page.lastInsertRowid],
  count: 2,
  interval_minutes: 60,
  start,
  post_type: "text",
  use_caption: true,
  caption_file: cap,
  media_folder: "",
  posted_folder: postedDir,
});
assert.equal(plan.tasks.length, 2);
assert.equal(plan.tasks[0].page_row_id, page.lastInsertRowid);
assert.equal(plan.tasks[0].opts.posted_folder, postedDir);
assert.equal(plan.tasks[1].unix - plan.tasks[0].unix, 3600);
assert.throws(() => planJob({
  delivery: "schedule",
  page_ids: [page.lastInsertRowid],
  count: 1,
  start: "2020-01-01T00:00",
  post_type: "text",
  use_caption: true,
  caption_file: cap,
}), /10 phút/);
const directPlan = planJob({
  delivery: "direct",
  page_ids: [page.lastInsertRowid],
  count: 1,
  start: "2020-01-01T00:00",
  post_type: "text",
  use_caption: true,
  caption_file: cap,
});
assert.equal(directPlan.tasks[0].opts.delivery, "direct");
assert.equal(plan.tasks[0].caption, null);

assert.equal(composeCaption("Than A", "view full album :", "https://example.com/1"), "view full album :\nhttps://example.com/1\n\nThan A");
assert.equal(composeComment("see more :", "https://example.com/c"), "see more :\nhttps://example.com/c");
assert.equal(parseScheduleList("09:00-09:05", "2026-12-31", () => 0)[0], vnLocalToUnix("2026-12-31T09:00"));
assert.throws(() => ensureIncreasing(parseScheduleList("21:00\n09:00", "2026-12-31")), /trùng|lùi/);
assert.equal(vnDayKey(Math.floor(Date.UTC(2026, 9, 4, 17, 30, 0) / 1000)), "2026-10-05");

function vnStamp(ms, hh, mm) {
  const shifted = new Date(ms + 7 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}T${pad(hh)}:${pad(mm)}`;
}
let baseMs = Date.now() + 48 * 3600 * 1000;
let dayStart = vnStamp(baseMs, 9, 0);
if (vnLocalToUnix(dayStart) < Date.now() / 1000 + 7200) {
  baseMs += 24 * 3600 * 1000;
  dayStart = vnStamp(baseMs, 9, 0);
}
const daysPlan = planJob({
  delivery: "schedule",
  schedule_mode: "days",
  page_ids: [page.lastInsertRowid],
  post_type: "text",
  use_caption: true,
  caption_text: "Than A\nThan B",
  caption_mode: "sequential",
  lead_enabled: true,
  lead_mode: "sequential",
  lead_templates: "view full album :",
  lead_links: "https://example.com/1\nhttps://example.com/2",
  start: dayStart,
  days: 2,
  per_day: 2,
  gap_min: 60,
  gap_max: 60,
  comment_enabled: true,
  comment_mode: "sequential",
  comment_text: "see more :",
  comment_links: "https://example.com/c1\nhttps://example.com/c2",
  comment_per_day: 1,
  comment_when: "after_publish",
});
assert.equal(daysPlan.tasks.length, 4);
assert.match(daysPlan.title, /Hẹn theo ngày/);
assert.equal(daysPlan.tasks[1].unix - daysPlan.tasks[0].unix, 3600);
assert.equal(daysPlan.tasks[2].unix - daysPlan.tasks[0].unix, 86400);
assert.equal(daysPlan.tasks[0].caption, "view full album :\nhttps://example.com/1\n\nThan A");
assert.equal(daysPlan.tasks[1].caption, "view full album :\nhttps://example.com/2\n\nThan B");
assert.equal(daysPlan.tasks[2].caption, "view full album :\nhttps://example.com/1\n\nThan A");
assert.equal(daysPlan.tasks[0].comment_text, "see more :\nhttps://example.com/c1");
assert.equal(daysPlan.tasks[1].comment_text, "");
assert.equal(daysPlan.tasks[2].comment_text, "see more :\nhttps://example.com/c1");
assert.equal(commentAction(daysPlan.tasks[0]), "pending");
assert.equal(commentAction(daysPlan.tasks[1]), "off");
assert.throws(() => planJob({
  delivery: "schedule",
  schedule_mode: "days",
  page_ids: [page.lastInsertRowid],
  post_type: "text",
  caption_text: "A",
  start: dayStart,
  days: 0,
  per_day: 1,
}), /ngày/);
const listPlan = planJob({
  delivery: "schedule",
  schedule_mode: "list",
  page_ids: [page.lastInsertRowid],
  post_type: "text",
  use_caption: true,
  caption_text: "Mot",
  list_times: `${dayStart}\n${vnStamp(baseMs, 9, 10)}`,
  list_cd_min: 30,
  list_cd_max: 30,
});
assert.equal(listPlan.tasks.length, 2);
assert.equal(listPlan.tasks[1].unix - listPlan.tasks[0].unix, 1800);
assert.match(listPlan.title, /Hẹn giờ hàng loạt/);
const titledPlan = planJob({
  delivery: "now",
  page_ids: [page.lastInsertRowid],
  post_type: "video",
  media_folder: folder,
  use_caption: true,
  caption_text: "Mo ta",
  title_enabled: true,
  title_text: "Title ngan",
  count: 1,
});
assert.equal(titledPlan.tasks[0].video_title, "Title ngan");
assert.equal(titledPlan.tasks[0].caption, "Mo ta");
const fileLead = previewJob({
  delivery: "now",
  page_ids: [page.lastInsertRowid],
  post_type: "text",
  use_caption: true,
  caption_file: cap,
  lead_enabled: true,
  lead_mode: "sequential",
  lead_templates: "mo dau",
  lead_links: "https://example.com/z",
  count: 1,
});
assert.equal(fileLead.sample, "mo dau\nhttps://example.com/z\n\nMot");
assert.throws(() => planJob({
  delivery: "now",
  page_ids: [page.lastInsertRowid],
  post_type: "video",
  media_folder: folder,
  title_enabled: true,
  count: 1,
}), /title/);

db.prepare(`INSERT INTO jobs (id, type, title, status, tasks_json) VALUES ('job1', 'now', 'x', 'running', ?)`)
  .run(JSON.stringify([{
    id: "t1",
    status: "running",
    page_row_id: page.lastInsertRowid,
    account_id: account.lastInsertRowid,
    page_id: "99",
    page_name: "Page Test",
    claimed_file: path.join(folder, "a.mp4"),
    fb_post_id: "123",
    opts: { post_type: "video", delivery: "now" },
  }]));
recoverInterruptedJobs();
const recovered = db.prepare(`SELECT status, tasks_json FROM jobs WHERE id = 'job1'`).get();
assert.equal(recovered.status, "paused");
assert.equal(JSON.parse(recovered.tasks_json)[0].status, "fail");
assert.match(JSON.parse(recovered.tasks_json)[0].error, /123/);
const unknown = db.prepare(`SELECT status FROM post_logs WHERE media_path LIKE '%a.mp4'`).get();
assert.equal(unknown.status, "unknown");
assert.deepEqual(listMediaFiles(folder, "video").map((file) => path.basename(file)), ["b.mp4"]);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const licenseSource = fs.readFileSync(path.join(root, "src", "license.js"), "utf8");
const publicPem = fs.readFileSync(path.join(root, "src", "license-public.pem"), "utf8").trim();
assert.equal(licenseSource.includes("PRIVATE KEY"), false);
assert.ok(licenseSource.includes(publicPem));
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
assert.equal(pkg.version, "1.1.10");
assert.equal(JSON.stringify(pkg.build.files).includes("keys"), false);

const privatePem = fs.readFileSync(path.join(root, "keys", "license-private.pem"), "utf8");
const machine = machineCode();
assert.match(machine, /^[0-9A-F]{4}(?:-[0-9A-F]{4}){3}$/);
assert.equal(machineCode(), machine);
assert.equal(vnEndOfDayUnix("2026-10-05"), Math.floor(Date.UTC(2026, 9, 5, 16, 59, 59) / 1000));

const exp = Math.floor(Date.now() / 1000) + 3 * 86400;
const goodKey = signLicense({ name: "Khach Test", exp, mid: machine }, privatePem);
assert.equal(readLicenseToken(goodKey).mid, machine);
const parts = goodKey.split(".");
const chars = parts[1].split("");
chars[3] = chars[3] === "a" ? "b" : "a";
assert.throws(() => readLicenseToken(`${parts[0]}.${chars.join("")}.${parts[2]}`), /Key/);

const otherMid = (machine[0] === "A" ? "B" : "A") + machine.slice(1);
const otherKey = signLicense({ name: "Khac", exp, mid: otherMid }, privatePem);
const expiredKey = signLicense({ name: "Cu", exp: Math.floor(Date.now() / 1000) - 30, mid: machine }, privatePem);
assert.throws(() => activateLicense(otherKey), /máy này/);
assert.throws(() => activateLicense(expiredKey), /hết hạn/);

const activated = activateLicense(goodKey);
assert.equal(activated.ok, true);
assert.equal(activated.name, "Khach Test");
assert.ok(activated.exp_vn);
const licenseFile = path.join(home, "license.json");
const stored = JSON.parse(fs.readFileSync(licenseFile, "utf8"));
stored.seen = Date.now() + 60 * 1000;
fs.writeFileSync(licenseFile, JSON.stringify(stored));
assert.equal(licenseStatus().ok, true);
stored.seen = Date.now() + 10 * 60 * 1000;
fs.writeFileSync(licenseFile, JSON.stringify(stored));
const rolled = licenseStatus();
assert.equal(rolled.ok, false);
assert.equal(rolled.reason, "clock");
fs.rmSync(licenseFile, { force: true });
assert.equal(licenseStatus().reason, "missing");

assert.equal(compareVersions("1.0.9", "1.0.10"), -1);
assert.equal(compareVersions("1.2.0", "1.1.9"), 1);
assert.equal(compareVersions("1.1.0", "1.1.0"), 0);
assert.equal(compareVersions("1.10.0", "1.9.9"), 1);

const maker = path.join(root, "scripts", "make-key.mjs");
assert.equal(spawnSync(process.execPath, [maker], { encoding: "utf8" }).status, 1);
const made = spawnSync(process.execPath, [maker, "--name", "Shop A", "--machine", machine, "--until", "2026-12-31"], {
  cwd: root,
  encoding: "utf8",
});
assert.equal(made.status, 0, made.stderr);
const minted = readLicenseToken(made.stdout.trim());
assert.equal(minted.name, "Shop A");
assert.equal(minted.mid, machine);
assert.equal(minted.exp, vnEndOfDayUnix("2026-12-31"));

function setupFiles() {
  const dir = path.join(home, "updates");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.endsWith(".exe") || name.endsWith(".part"));
}

const ignored = await checkOnce("http://example.com/latest.json");
assert.equal(ignored.phase, "idle");
const closed = http.createServer((req, res) => res.end("no"));
await new Promise((resolve) => closed.listen(0, "127.0.0.1", resolve));
const closedPort = closed.address().port;
await new Promise((resolve) => closed.close(resolve));
const missed = await checkOnce(`http://127.0.0.1:${closedPort}/latest.json`);
assert.equal(missed.phase, "idle");

const payload = Buffer.from("FB-DangBai-setup-test");
const goodHash = crypto.createHash("sha256").update(payload).digest("hex");
const feed = http.createServer((req, res) => {
  const fileUrl = `http://127.0.0.1:${feed.address().port}/file.bin`;
  if (req.url === "/file.bin") return res.end(payload);
  if (req.url === "/old.json") {
    return res.end(JSON.stringify({ version: "0.0.1", url: fileUrl, sha256: goodHash }));
  }
  if (req.url === "/bad.json") {
    return res.end(JSON.stringify({ version: "9.9.9", url: fileUrl, sha256: "0".repeat(64) }));
  }
  if (req.url === "/good.json") {
    return res.end(JSON.stringify({ version: "9.9.9", url: fileUrl, sha256: goodHash, notes: "ban test" }));
  }
  res.statusCode = 404;
  res.end();
});
await new Promise((resolve) => feed.listen(0, "127.0.0.1", resolve));
const feedPort = feed.address().port;
const old = await checkOnce(`http://127.0.0.1:${feedPort}/old.json`);
assert.equal(old.phase, "idle");
assert.deepEqual(setupFiles(), []);
const badHash = await checkOnce(`http://127.0.0.1:${feedPort}/bad.json`);
assert.equal(badHash.phase, "idle");
assert.deepEqual(setupFiles(), []);
const ready = await checkOnce(`http://127.0.0.1:${feedPort}/good.json`);
assert.equal(ready.phase, "ready");
assert.equal(ready.version, "9.9.9");
assert.equal(crypto.createHash("sha256").update(fs.readFileSync(ready.file)).digest("hex"), goodHash);
await new Promise((resolve) => feed.close(resolve));

const server = await startServer(0);
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
const health = await fetch(`${base}/api/health`).then((res) => res.json());
assert.equal(health.ok, true);
assert.equal(health.version, "1.1.10");
const lockedAccounts = await fetch(`${base}/api/accounts`);
assert.equal(lockedAccounts.status, 403);
const lockedJob = await fetch(`${base}/api/jobs/now`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ page_ids: [] }),
});
assert.equal(lockedJob.status, 403);
const lockedSettings = await fetch(`${base}/api/settings`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ media_folder: "X:\\nope" }),
});
assert.equal(lockedSettings.status, 403);
const lockedGroups = await fetch(`${base}/api/groups`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ kind: "page", name: "A", page_ids: [1] }),
});
assert.equal(lockedGroups.status, 403);
const license = await fetch(`${base}/api/license`).then((res) => res.json());
assert.equal(license.ok, false);
assert.equal(license.machine, machine);

async function activate(key) {
  return fetch(`${base}/api/license/activate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key }),
  });
}
assert.equal((await activate(`${parts[0]}.${chars.join("")}.${parts[2]}`)).status, 400);
assert.equal((await activate(otherKey)).status, 400);
assert.equal((await activate(expiredKey)).status, 400);
const turnedOn = await activate(goodKey);
assert.equal(turnedOn.status, 200);
assert.equal((await turnedOn.json()).ok, true);

const clockSaved = JSON.parse(fs.readFileSync(licenseFile, "utf8"));
clockSaved.seen = Date.now() + 10 * 60 * 1000;
fs.writeFileSync(licenseFile, JSON.stringify(clockSaved));
const clocked = await fetch(`${base}/api/accounts`);
assert.equal(clocked.status, 403);
assert.match((await clocked.json()).error, /lùi/);
clockSaved.seen = Date.now();
fs.writeFileSync(licenseFile, JSON.stringify(clockSaved));

const savedSettings = await fetch(`${base}/api/settings`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    media_folder: "D:\\kho",
    posted_folder: "E:\\posted",
    caption_text: "dong 1",
    use_caption: false,
    comment_enabled: true,
    list_times: "08:00\n12:00",
  }),
});
assert.equal(savedSettings.status, 200);
const settingsBody = await savedSettings.json();
assert.equal(settingsBody.media_folder, "D:\\kho");
assert.equal(settingsBody.posted_folder, "E:\\posted");
assert.equal(settingsBody.caption_text, "dong 1");
assert.equal(settingsBody.use_caption, false);
assert.equal(settingsBody.comment_enabled, true);
assert.equal(settingsBody.list_times, "08:00\n12:00");
const settingsAgain = await fetch(`${base}/api/settings`).then((res) => res.json());
assert.equal(settingsAgain.posted_folder, "E:\\posted");
assert.equal(settingsAgain.media_folder, "D:\\kho");

const missing = await fetch(`${base}/api/jobs/now`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ page_ids: [] }),
});
assert.equal(missing.status, 400);
const early = await fetch(`${base}/api/jobs/schedule`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    page_ids: [page.lastInsertRowid],
    count: 1,
    start: "2020-01-01T00:00",
    post_type: "text",
    use_caption: true,
    caption_file: cap,
  }),
});
const earlyBody = await early.json();
assert.equal(early.status, 400);
assert.match(earlyBody.error, /10 phút/);

const stateFile = path.join(home, "update-state.json");
const readState = () => JSON.parse(fs.readFileSync(stateFile, "utf8"));
assert.equal(readState().phase, "ready");
const unpackaged = await fetch(`${base}/api/update/apply`, { method: "POST" });
assert.equal(unpackaged.status, 400);
assert.equal(readState().phase, "ready");

process.env.FB_DANGBAI_PACKAGED = "1";
db.prepare(`INSERT INTO jobs (id, type, title, status, tasks_json) VALUES ('job-busy', 'direct', 'busy', 'running', '[]')`).run();
const busy = await fetch(`${base}/api/update/apply`, { method: "POST" });
assert.equal(busy.status, 409);
assert.equal(readState().phase, "ready");
assert.ok(fs.existsSync(readState().file));
db.prepare(`UPDATE jobs SET status = 'paused' WHERE id = 'job-busy'`).run();
const applied = await fetch(`${base}/api/update/apply`, { method: "POST" });
const appliedBody = await applied.json();
assert.equal(applied.status, 200);
assert.equal(appliedBody.version, "9.9.9");
assert.ok(fs.existsSync(appliedBody.file));
assert.equal(readState().phase, "applying");
const second = await fetch(`${base}/api/update/apply`, { method: "POST" });
assert.equal(second.status, 400);
assert.equal(readState().phase, "applying");
const released = releaseApply();
assert.equal(released.phase, "ready");
const resumed = settleUpdateState();
assert.equal(resumed.phase, "ready");
assert.ok(fs.existsSync(resumed.file));
const outside = readState();
outside.file = path.join(home, "not-an-update.exe");
fs.writeFileSync(outside.file, "nope");
fs.writeFileSync(stateFile, JSON.stringify(outside));
const refused = await fetch(`${base}/api/update/apply`, { method: "POST" });
assert.equal(refused.status, 400);
assert.equal(readState().phase, "idle");
assert.equal(fs.existsSync(resumed.file), true);
fs.writeFileSync(stateFile, JSON.stringify({
  phase: "applying",
  version: "1.0.0",
  file: resumed.file,
  notes: "",
  error: "",
  checked_at: 0,
}));
const cleared = settleUpdateState();
assert.equal(cleared.phase, "idle");
assert.equal(fs.existsSync(resumed.file), false);

const emptyGroup = await fetch(`${base}/api/groups`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: "{}",
});
assert.equal(emptyGroup.status, 400);
const tokenGroup = await fetch(`${base}/api/groups`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ kind: "token", name: "Nhom token", account_ids: [account.lastInsertRowid] }),
});
assert.equal(tokenGroup.status, 200);
const tokenBody = await tokenGroup.json();
assert.equal(tokenBody.token_groups.length, 1);
assert.equal(tokenBody.token_groups[0].page_count, 1);
assert.equal(tokenBody.token_groups[0].account_ids[0], account.lastInsertRowid);
const pageGroup = await fetch(`${base}/api/groups`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ kind: "page", name: "Nhom page", page_ids: [page.lastInsertRowid] }),
});
assert.equal(pageGroup.status, 200);
const pageBody = await pageGroup.json();
assert.equal(pageBody.page_groups[0].page_count, 1);
const removedGroup = await fetch(`${base}/api/groups/${tokenBody.token_groups[0].id}`, { method: "DELETE" });
assert.equal(removedGroup.status, 200);
const leftGroups = await removedGroup.json();
assert.equal(leftGroups.token_groups.length, 0);
assert.equal(leftGroups.page_groups.length, 1);

const html = await fetch(`${base}/`).then((res) => res.text());
assert.match(html, /Đăng ngay API/);
assert.match(html, /Hẹn giờ hàng loạt/);
assert.match(html, /Đăng trực tiếp/);
assert.match(html, /Hẹn theo ngày/);
assert.match(html, /id="tabDays"/);
assert.match(html, /id="leadTemplates"/);
assert.match(html, /id="leadLinks"/);
assert.match(html, /id="listTimes"/);
assert.match(html, /Link đăng/);
assert.match(html, /Chọn tất cả/);
assert.match(html, /User token/);
assert.match(html, /id="tokenFilter"/);
assert.match(html, /Thu nhỏ/);
assert.match(html, /id="addToken"/);
assert.match(html, /Nhóm token/);
assert.match(html, /Nhóm page/);
assert.match(html, /id="tokenGroups"/);
assert.match(html, /id="pageGroups"/);
assert.match(html, /id="appVer"/);
assert.match(html, /id="jobPct"/);
assert.match(html, /id="jobs" class="scroll-box"/);
assert.match(html, /id="logs" class="scroll-box"/);
assert.match(html, /id="btnUpdate"/);
assert.match(html, /id="updateBox"/);
assert.match(html, /id="postedFolder"/);
assert.match(html, /id="btnPosted"/);
assert.match(html, /Chọn ổ\/folder/);
assert.match(html, /id="ask"/);
assert.match(html, /id="toasts"/);
const appJs = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
assert.match(appJs, /data-copy/);
assert.match(appJs, /data-open/);
assert.match(appJs, /Đang chạy/);
assert.match(appJs, /job.status === "running"/);
assert.match(appJs, /applyUpdate/);
assert.match(appJs, /Cập nhật/);
assert.match(appJs, /await start\("now"/);
assert.match(appJs, /await start\("schedule", "list"/);
assert.match(appJs, /await ask\(/);
assert.equal(appJs.includes("const ok = confirm"), false);
assert.match(appJs, /fbDangBai/);
assert.match(appJs, /pagehide/);
assert.match(appJs, /\/api\/settings/);
assert.match(appJs, /posted_folder/);
const mainCjs = fs.readFileSync(path.join(root, "electron", "main.cjs"), "utf8");
assert.match(mainCjs, /openDirectory/);
assert.match(mainCjs, /preload\.cjs/);
assert.match(mainCjs, /sandbox:\s*false/);
assert.match(mainCjs, /Chọn thư mục này/);
assert.match(mainCjs, /fbdangbai:apply-update/);
assert.match(mainCjs, /update-install\.log/);
assert.match(mainCjs, /ArgumentList '\/S'/);
const updateJs = fs.readFileSync(path.join(root, "src", "update.js"), "utf8");
assert.match(updateJs, /trumrename\/fb-dang-bai\/releases\/latest\/download\/latest\.json/);
assert.equal(updateJs.includes("fb-page-studio"), false);
const preload = fs.readFileSync(path.join(root, "electron", "preload.cjs"), "utf8");
assert.match(preload, /applyUpdate/);
assert.ok(pkg.build.files.includes("electron/preload.cjs"));
assert.equal(fs.existsSync(path.join(root, "electron", "preload.cjs")), true);
const mediaSource = fs.readFileSync(path.join(root, "src", "media.js"), "utf8");
assert.match(mediaSource, /copyFileSync/);
assert.match(mediaSource, /unlinkSync/);
assert.match(html, /id="lockVer"/);
assert.match(html, /Mã máy/);
assert.match(html, /id="keyBox"/);
assert.equal(html.includes("license-private"), false);

function addLivePage(n, pageId, name) {
  const acc = db.prepare(
    `INSERT INTO accounts (token_hash, name, fb_user_id, kind, token_enc) VALUES (?, ?, ?, 'user', ?)`
  ).run(`hash-live-${n}`, name, String(100 + n), token);
  return db.prepare(
    `INSERT INTO pages (account_id, page_id, name, token_enc, status) VALUES (?, ?, ?, ?, 'active')`
  ).run(acc.lastInsertRowid, pageId, name, token).lastInsertRowid;
}
const liveSchedule = addLivePage(2, "100", "Page Hen");
const liveDays = addLivePage(3, "101", "Page Ngay");
const liveDirect = addLivePage(4, "102", "Page Truc Tiep");
const graphHits = [];
const graph = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const text = Buffer.concat(chunks).toString("utf8");
    res.setHeader("content-type", "application/json");
    if (req.method === "POST" && /\/feed/.test(req.url || "")) {
      graphHits.push(text ? JSON.parse(text) : {});
      const id = (req.url || "").includes("/100/") ? "100_55"
        : (req.url || "").includes("/101/") ? "101_55"
          : (req.url || "").includes("/102/") ? "102_55"
            : "99_55";
      res.end(JSON.stringify({ id }));
      return;
    }
    res.end(JSON.stringify({ id: "99_55", permalink_url: "https://www.facebook.com/99_55" }));
  });
});
await new Promise((resolve) => graph.listen(0, "127.0.0.1", resolve));
process.env.FB_DANGBAI_GRAPH_ORIGIN = `http://127.0.0.1:${graph.address().port}`;
async function postLive(pathname, payload) {
  const res = await fetch(`${base}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  assert.equal(res.status, 200, body.error || res.status);
  return body.job;
}
const textBody = { post_type: "text", use_caption: true, caption_text: "Bai that", lead_enabled: false, comment_enabled: false };
const [jobNow, jobList, jobDays, jobDirect] = await Promise.all([
  postLive("/api/jobs/now", { ...textBody, page_ids: [page.lastInsertRowid], count: 1 }),
  postLive("/api/jobs/schedule", { ...textBody, page_ids: [liveSchedule], schedule_mode: "list", list_times: start }),
  postLive("/api/jobs/schedule", { ...textBody, page_ids: [liveDays], schedule_mode: "days", start, days: 1, per_day: 1, gap_min: 60, gap_max: 60 }),
  postLive("/api/jobs/direct", { ...textBody, page_ids: [liveDirect], count: 1, start: "2020-01-01T08:00", interval_minutes: 60 }),
]);
const wanted = new Map([
  [jobNow.id, "now"],
  [jobList.id, "schedule"],
  [jobDays.id, "schedule"],
  [jobDirect.id, "direct"],
]);
const deadline = Date.now() + 20000;
let finished = [];
while (Date.now() < deadline) {
  const data = await fetch(`${base}/api/jobs`).then((res) => res.json());
  finished = (data.jobs || []).filter((job) => wanted.has(job.id));
  if (finished.length === 4 && finished.every((job) => job.status === "done" && job.progress.percent === 100 && job.progress.ok === 1 && job.progress.fail === 0)) break;
  await new Promise((resolve) => setTimeout(resolve, 200));
}
assert.equal(finished.length, 4, JSON.stringify(finished.map((job) => ({ id: job.id, status: job.status, progress: job.progress, message: job.tasks?.[0]?.message }))));
for (const job of finished) {
  assert.equal(job.status, "done", job.tasks?.[0]?.message || job.status);
  assert.equal(job.progress.percent, 100);
  assert.equal(job.progress.ok, 1, JSON.stringify({ tasks: job.tasks, hits: graphHits.length }));
  assert.equal(job.progress.fail, 0);
}
assert.equal(graphHits.length, 4, JSON.stringify(graphHits));
assert.equal(graphHits.filter((hit) => hit.published === "true").length, 2);
assert.equal(graphHits.filter((hit) => hit.published === "false" && hit.unpublished_content_type === "SCHEDULED").length, 2);
const logs = await fetch(`${base}/api/logs`).then((res) => res.json());
const liveLogs = (logs.logs || []).filter((row) => ["99_55", "100_55", "101_55", "102_55"].includes(row.fb_post_id));
assert.equal(liveLogs.length, 4);
assert.equal(liveLogs.filter((row) => row.status === "scheduled").length, 2);
assert.equal(liveLogs.filter((row) => row.status === "ok").length, 2);
delete process.env.FB_DANGBAI_GRAPH_ORIGIN;
await new Promise((resolve) => graph.close(resolve));

await new Promise((resolve) => server.close(resolve));
closeDb();
fs.rmSync(home, { recursive: true, force: true });
console.log("self-test ok");
