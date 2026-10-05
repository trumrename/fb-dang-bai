import crypto from "crypto";
import { getDb, getSetting, setSetting } from "./db.js";
import { getPageToken } from "./accounts.js";
import {
  applyCooldown,
  buildDayPlan,
  composeCaption,
  composeComment,
  ensureIncreasing,
  parseScheduleList,
  pickLine,
  textLines,
  vnDayKey,
} from "./content.js";
import { claimNextFile, fileAtRound, lineAt, moveToPosted, normPath, readTextLines, takeNextLine } from "./media.js";
import { publishComment, publishPhoto, publishText, publishVideo } from "./publish.js";
import { isCommunitySpamBlock, isTransient } from "./graph.js";
import { formatVn, validateScheduleUnix, vnLocalToUnix } from "./time.js";

const GAP_MS = 30000;
const reservedFiles = new Set();
const lastCallAt = new Map();
const spamHold = new Set();
const live = new Map();

function newId() {
  return crypto.randomBytes(6).toString("base64url");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function permanent(message) {
  const err = new Error(message);
  err.permanent = true;
  return err;
}

function readTasks(row) {
  try {
    const tasks = JSON.parse(row.tasks_json || "[]");
    return Array.isArray(tasks) ? tasks : [];
  } catch {
    return [];
  }
}

function saveJob(id, tasks, patch = {}) {
  const status = patch.status;
  const finished = patch.finished_at;
  if (status && finished) {
    getDb().prepare(`UPDATE jobs SET tasks_json = ?, status = ?, finished_at = ? WHERE id = ?`)
      .run(JSON.stringify(tasks), status, finished, id);
  } else if (status) {
    getDb().prepare(`UPDATE jobs SET tasks_json = ?, status = ? WHERE id = ?`)
      .run(JSON.stringify(tasks), status, id);
  } else {
    getDb().prepare(`UPDATE jobs SET tasks_json = ? WHERE id = ?`).run(JSON.stringify(tasks), id);
  }
}

function loadJob(id) {
  const row = getDb().prepare(`SELECT * FROM jobs WHERE id = ?`).get(id);
  if (!row) return null;
  return { ...row, tasks: readTasks(row) };
}

export function publicJob(row) {
  const tasks = row.tasks || readTasks(row);
  const counts = { total: tasks.length, pending: 0, running: 0, ok: 0, fail: 0, skipped: 0, done: 0, percent: 0 };
  for (const task of tasks) {
    if (counts[task.status] != null) counts[task.status] += 1;
    else counts.pending += 1;
  }
  counts.done = counts.ok + counts.fail + counts.skipped;
  counts.percent = counts.total ? Math.round((counts.done * 100) / counts.total) : 0;
  if (row.status === "running" && counts.running > 0 && counts.percent < 100) {
    counts.percent = Math.min(99, counts.percent + Math.max(1, Math.round(40 / counts.total)));
  }
  const accounts = new Set(tasks.map((t) => t.account_id));
  let busiest = 0;
  const perAccount = new Map();
  for (const task of tasks) perAccount.set(task.account_id, (perAccount.get(task.account_id) || 0) + 1);
  for (const n of perAccount.values()) busiest = Math.max(busiest, n);
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    status: row.status,
    created_at: row.created_at,
    finished_at: row.finished_at,
    progress: counts,
    token_count: accounts.size,
    gap_minutes: Math.ceil((busiest * GAP_MS) / 60000),
    tasks: tasks.map((t) => ({
      id: t.id,
      status: t.status,
      page_name: t.page_name,
      page_id: t.page_id,
      round: t.round,
      message: t.message || "",
      error: t.error || "",
      post_url: t.post_url || "",
      when: t.unix ? formatVn(t.unix) : "",
    })),
  };
}

export function listJobs(limit = 15) {
  const rows = getDb().prepare(`SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?`).all(Math.max(1, limit));
  return rows.map(publicJob);
}

/** Direct posts stay running until the Vietnam time. Do not install an update over them. */
export function hasBusyJob() {
  const row = getDb().prepare(`SELECT 1 AS ok FROM jobs WHERE status IN ('running', 'queued') LIMIT 1`).get();
  return !!row;
}

export function getJob(id) {
  const row = loadJob(id);
  return row ? publicJob(row) : null;
}

/**
 * A crash mid-upload must not post the same file again by itself.
 * The in-flight task is failed and its file is marked unknown until a person checks the Page.
 */
export function recoverInterruptedJobs() {
  const db = getDb();
  const rows = db.prepare(`SELECT * FROM jobs WHERE status IN ('running', 'queued')`).all();
  const insert = db.prepare(
    `INSERT INTO post_logs (job_id, page_row_id, account_id, page_id, page_name, post_type, delivery,
      media_path, status, error)
     VALUES (@job_id, @page_row_id, @account_id, @page_id, @page_name, @post_type, @delivery,
      @media_path, 'unknown', @error)`
  );
  for (const row of rows) {
    const tasks = readTasks(row);
    for (const task of tasks) {
      if (task.status !== "running") continue;
      task.status = "fail";
      task.error = task.fb_post_id
        ? `App đóng sau khi Facebook đã nhận bài ${task.fb_post_id}. Không đăng lại file này.`
        : "App đóng khi đang gọi Facebook. Mở Page xem bài đã lên chưa trước khi đăng lại file này.";
      task.message = task.error;
      if (task.claimed_file) {
        insert.run({
          job_id: row.id,
          page_row_id: task.page_row_id,
          account_id: task.account_id,
          page_id: task.page_id,
          page_name: task.page_name,
          post_type: task.opts?.post_type || "",
          delivery: task.opts?.delivery || "",
          media_path: task.claimed_file,
          error: task.error,
        });
      }
    }
    db.prepare(`UPDATE jobs SET status = 'paused', tasks_json = ? WHERE id = ?`)
      .run(JSON.stringify(tasks), row.id);
  }
}

function bool(value, fallback) {
  if (value == null || value === "") return fallback;
  if (value === true || value === 1 || value === "1" || value === "true" || value === "on") return true;
  if (value === false || value === 0 || value === "0" || value === "false" || value === "off") return false;
  return fallback;
}

export function rememberSettings(input) {
  const textKeys = [
    "media_folder", "posted_folder", "caption_file", "comment_file", "post_type", "caption_text", "caption_mode",
    "lead_mode", "lead_templates", "lead_links", "title_file", "title_text", "title_mode",
    "comment_mode", "comment_text", "comment_links", "comment_when", "list_date", "list_times",
    "days_start", "direct_start",
  ];
  for (const key of textKeys) {
    if (input[key] != null) setSetting(key, input[key]);
  }
  const numberKeys = [
    "count", "interval_minutes", "comment_per_day", "comment_delay_minutes",
    "list_cd_min", "list_cd_max", "days", "per_day", "gap_min", "gap_max",
    "now_count", "direct_count", "direct_interval",
  ];
  for (const key of numberKeys) {
    if (input[key] != null && input[key] !== "") setSetting(key, input[key]);
  }
  setSetting("use_caption", bool(input.use_caption, true) ? "1" : "0");
  setSetting("comment_enabled", bool(input.comment_enabled, false) ? "1" : "0");
  setSetting("repeat_media", bool(input.repeat_media, false) ? "1" : "0");
  setSetting("lead_enabled", bool(input.lead_enabled, false) ? "1" : "0");
  setSetting("title_enabled", bool(input.title_enabled, false) ? "1" : "0");
}

export function currentSettings() {
  const start = getSetting("start", "");
  return {
    media_folder: getSetting("media_folder", ""),
    posted_folder: getSetting("posted_folder", ""),
    caption_file: getSetting("caption_file", ""),
    comment_file: getSetting("comment_file", ""),
    post_type: getSetting("post_type", "video") || "video",
    count: Number(getSetting("count", "1")) || 1,
    interval_minutes: Number(getSetting("interval_minutes", "60")) || 60,
    start,
    use_caption: getSetting("use_caption", "1") !== "0",
    comment_enabled: getSetting("comment_enabled", "0") === "1",
    repeat_media: getSetting("repeat_media", "0") === "1",
    caption_text: getSetting("caption_text", ""),
    caption_mode: getSetting("caption_mode", "sequential") || "sequential",
    lead_enabled: getSetting("lead_enabled", "0") === "1",
    lead_mode: getSetting("lead_mode", "sequential") || "sequential",
    lead_templates: getSetting("lead_templates", ""),
    lead_links: getSetting("lead_links", ""),
    title_enabled: getSetting("title_enabled", "0") === "1",
    title_file: getSetting("title_file", ""),
    title_text: getSetting("title_text", ""),
    title_mode: getSetting("title_mode", "sequential") || "sequential",
    comment_mode: getSetting("comment_mode", "sequential") || "sequential",
    comment_text: getSetting("comment_text", ""),
    comment_links: getSetting("comment_links", ""),
    comment_per_day: Number(getSetting("comment_per_day", "0")) || 0,
    comment_when: getSetting("comment_when", "immediate") || "immediate",
    comment_delay_minutes: Number(getSetting("comment_delay_minutes", "0")) || 0,
    list_date: getSetting("list_date", ""),
    list_times: getSetting("list_times", ""),
    list_cd_min: Number(getSetting("list_cd_min", "0")) || 0,
    list_cd_max: Number(getSetting("list_cd_max", "0")) || 0,
    days_start: getSetting("days_start", "") || start,
    days: getSetting("days", ""),
    per_day: getSetting("per_day", ""),
    gap_min: getSetting("gap_min", "") === "" ? 60 : Number(getSetting("gap_min", "60")),
    gap_max: getSetting("gap_max", "") === "" ? 60 : Number(getSetting("gap_max", "60")),
    now_count: Number(getSetting("now_count", getSetting("count", "1"))) || 1,
    direct_start: getSetting("direct_start", "") || start,
    direct_count: Number(getSetting("direct_count", getSetting("count", "1"))) || 1,
    direct_interval: Number(getSetting("direct_interval", getSetting("interval_minutes", "60"))) || 60,
  };
}

function modeOf(value, fallback = "sequential") {
  return value === "random" ? "random" : fallback;
}

function blankMinutes(value, fallback) {
  if (value == null || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

function resolveSlots(input, delivery, rng) {
  if (delivery === "now") {
    const count = Math.max(1, Math.min(100, Number(input.count) || 1));
    return { mode: "now", slots: Array.from({ length: count }, () => null) };
  }
  const mode = delivery === "direct" ? "interval" : (input.schedule_mode || "interval");
  if (mode === "list") {
    const parsed = parseScheduleList(input.list_times, input.list_date, rng);
    const spaced = applyCooldown(parsed, input.list_cd_min, input.list_cd_max, rng);
    return { mode, slots: ensureIncreasing(spaced) };
  }
  if (mode === "days") {
    const startUnix = vnLocalToUnix(input.start);
    const slots = buildDayPlan({
      startUnix,
      days: input.days,
      perDay: input.per_day,
      gapMin: blankMinutes(input.gap_min, 60),
      gapMax: blankMinutes(input.gap_max, blankMinutes(input.gap_min, 60)),
      rng,
    });
    return { mode, slots };
  }
  if (mode !== "interval") throw new Error("Chọn cách hẹn giờ");
  const count = Math.max(1, Math.min(100, Number(input.count) || 1));
  const stepSec = Math.max(60, Math.round((Number(input.interval_minutes) || 60) * 60));
  const startUnix = vnLocalToUnix(input.start);
  const slots = [];
  for (let i = 0; i < count; i++) slots.push(startUnix + i * stepSec);
  return { mode, slots };
}

export function planJob(input) {
  const delivery = input.delivery;
  if (!["now", "schedule", "direct"].includes(delivery)) throw new Error("Chọn đăng ngay, hẹn giờ, hoặc đăng trực tiếp");
  const ids = [...new Set((input.page_ids || []).map((id) => Number(id)).filter((id) => id > 0))];
  if (!ids.length) throw new Error("Chọn ít nhất một page");
  const pages = ids.map((id) => getPageToken(id)).filter(Boolean);
  if (!pages.length) throw new Error("Không thấy page đã chọn");
  const postType = ["photo", "video", "text"].includes(input.post_type) ? input.post_type : "video";
  const repeat = bool(input.repeat_media, false);
  const useCaption = bool(input.use_caption, true);
  const commentOn = bool(input.comment_enabled, false);
  const leadOn = bool(input.lead_enabled, false);
  const titleOn = bool(input.title_enabled, false) && postType === "video";
  const rng = typeof input.rng === "function" ? input.rng : Math.random;
  const captionMode = modeOf(input.caption_mode);
  const leadMode = modeOf(input.lead_mode);
  const commentMode = modeOf(input.comment_mode);
  const titleMode = modeOf(input.title_mode);
  const inlineCaps = textLines(input.caption_text);
  const leadTemplates = textLines(input.lead_templates);
  const leadLinks = textLines(input.lead_links);
  const titleLines = textLines(input.title_text);
  const commentTemplates = textLines(input.comment_text);
  const commentLinks = textLines(input.comment_links);
  const captionFile = String(input.caption_file || "").trim();
  const commentFile = String(input.comment_file || "").trim();
  const titleFile = String(input.title_file || "").trim();
  const commentWhen = input.comment_when === "after_publish" ? "after_publish" : "immediate";
  const commentPerDay = Math.max(0, Math.min(100, Math.round(Number(input.comment_per_day) || 0)));
  const commentDelay = Math.max(0, Math.min(10080, Math.round(Number(input.comment_delay_minutes) || 0)));

  if (leadOn && !leadTemplates.length && !leadLinks.length) {
    throw new Error("Bật mở đầu nhưng chưa có câu mở đầu hoặc link đăng");
  }
  if (postType === "text" && !inlineCaps.length && !captionFile && !(leadOn && (leadTemplates.length || leadLinks.length))) {
    throw new Error("Bài chữ cần tiêu đề, mở đầu hoặc link đăng");
  }
  if (titleOn && !titleLines.length && !titleFile) throw new Error("Bật title video nhưng chưa có dòng title hoặc file title");
  if (commentOn && !commentFile && !commentTemplates.length && !commentLinks.length) {
    throw new Error("Đã bật comment nhưng chưa có câu, link hoặc file comment");
  }
  if (postType === "video" || postType === "photo") {
    const missing = pages.filter((page) => !(page.media_folder || input.media_folder));
    if (missing.length) {
      throw new Error(`Chưa có thư mục media cho ${missing.length} page. Chọn thư mục chung hoặc thư mục riêng.`);
    }
  }

  const resolved = resolveSlots(input, delivery, rng);
  if (delivery === "schedule") {
    for (const unix of resolved.slots) validateScheduleUnix(unix);
  }

  const tasks = [];
  for (const page of pages) {
    resolved.slots.forEach((unix, index) => {
      const round = index + 1;
      const opener = leadOn ? pickLine(leadTemplates, index, leadMode, rng) : "";
      const link = leadOn ? pickLine(leadLinks, index, leadMode, rng) : "";
      const bodyFromPaste = inlineCaps.length > 0;
      let caption = null;
      if (!useCaption || bodyFromPaste || !captionFile) {
        const body = useCaption && bodyFromPaste ? pickLine(inlineCaps, index, captionMode, rng) : "";
        caption = leadOn ? composeCaption(body, opener, link) : body;
      }
      let videoTitle = "";
      if (titleOn) videoTitle = titleLines.length ? pickLine(titleLines, index, titleMode, rng) : null;
      tasks.push({
        id: newId(),
        status: "pending",
        page_row_id: page.id,
        account_id: page.account_id,
        page_id: page.page_id,
        page_name: page.name,
        round,
        unix,
        message: "Chờ",
        error: "",
        post_url: "",
        prepared: false,
        claimed_file: "",
        caption,
        video_title: videoTitle,
        comment_text: null,
        opts: {
          post_type: postType,
          delivery,
          schedule_mode: resolved.mode,
          use_caption: useCaption,
          caption_mode: captionMode,
          comment_enabled: commentOn,
          comment_when: commentWhen,
          comment_delay_minutes: commentDelay,
          comment_from_file: false,
          repeat_media: repeat,
          lead_on: leadOn && caption == null,
          lead_opener: opener,
          lead_link: link,
          title_enabled: titleOn,
          title_mode: titleMode,
          title_file: titleFile,
          media_folder: page.media_folder || String(input.media_folder || "").trim(),
          posted_folder: String(input.posted_folder || "").trim(),
          caption_file: captionFile,
          comment_file: commentFile,
        },
      });
    });
  }

  if (!commentOn) {
    for (const task of tasks) task.comment_text = "";
  } else {
    const groups = new Map();
    for (const task of tasks) {
      const key = `${task.page_row_id}|${task.unix ? vnDayKey(task.unix) : "now"}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(task);
    }
    const allowed = new Set();
    for (const group of groups.values()) {
      const chosen = commentPerDay > 0 && group.length > commentPerDay
        ? group.slice(0, commentPerDay)
        : group;
      if (commentPerDay > 0 && group.length > commentPerDay && commentMode === "random") {
        const bag = [...group];
        for (let i = bag.length - 1; i > 0; i--) {
          const j = Math.floor(rollSafe(rng) * (i + 1));
          const swap = bag[i];
          bag[i] = bag[j];
          bag[j] = swap;
        }
        for (const task of bag.slice(0, commentPerDay)) allowed.add(task);
      } else {
        for (const task of chosen) allowed.add(task);
      }
    }
    for (const task of tasks) {
      if (!allowed.has(task)) {
        task.comment_text = "";
        task.opts.comment_enabled = false;
        continue;
      }
      task.opts.comment_enabled = true;
      if (commentTemplates.length || commentLinks.length) {
        const opener = pickLine(commentTemplates, task.round - 1, commentMode, rng);
        const link = pickLine(commentLinks, task.round - 1, commentMode, rng);
        task.comment_text = composeComment(opener, link);
        if (!task.comment_text) throw new Error("Comment trống");
      } else {
        task.comment_text = null;
        task.opts.comment_from_file = true;
      }
    }
  }

  const perPage = resolved.slots.length;
  let title = `Đăng ngay API · ${pages.length} page · ${perPage} bài · ${postType}`;
  if (delivery === "direct") title = `Đăng trực tiếp · ${pages.length} page · ${perPage} bài · ${postType}`;
  if (delivery === "schedule" && resolved.mode === "days") {
    title = `Hẹn theo ngày · ${pages.length} page · ${input.days} ngày × ${input.per_day} bài · ${postType}`;
  } else if (delivery === "schedule" && resolved.mode === "list") {
    title = `Hẹn giờ hàng loạt · ${pages.length} page · ${perPage} mốc · ${postType}`;
  } else if (delivery === "schedule") {
    title = `Hẹn giờ hàng loạt · ${pages.length} page · ${perPage} bài · ${postType}`;
  }
  return { type: delivery, title, tasks };
}

function rollSafe(rng) {
  const n = Number(rng());
  if (!Number.isFinite(n)) return 0;
  return Math.min(0.999999, Math.max(0, n));
}

/** Schedule + "sau khi public" stays pending. The post itself still goes to Facebook. */
export function commentAction(task) {
  if (!task?.comment_text) return "off";
  if (task.opts?.delivery === "schedule" && task.opts?.comment_when === "after_publish") return "pending";
  return "send";
}

export function previewJob(input) {
  const plan = planJob(input);
  const random = [input.caption_mode, input.lead_mode, input.comment_mode, input.title_mode].includes("random");
  const times = plan.tasks.map((task) => task.unix).filter((unix) => unix);
  const pages = new Set(plan.tasks.map((task) => task.page_row_id));
  let sample = "";
  if (!random) {
    const task = plan.tasks[0];
    if (typeof task?.caption === "string" && task.caption) sample = task.caption;
    else if (task?.opts?.use_caption && task?.opts?.caption_file) {
      const body = lineAt(task.opts.caption_file, 1);
      sample = task.opts.lead_on ? composeCaption(body, task.opts.lead_opener, task.opts.lead_link) : body;
    }
  }
  return {
    title: plan.title,
    tasks: plan.tasks.length,
    pages: pages.size,
    per_page: pages.size ? plan.tasks.length / pages.size : 0,
    first: times.length ? formatVn(Math.min(...times)) : "",
    last: times.length ? formatVn(Math.max(...times)) : "",
    sample: String(sample).slice(0, 400),
    random,
  };
}

export function createJob(input) {
  rememberSettings(input);
  const plan = planJob(input);
  const id = newId();
  for (const task of plan.tasks) task.job_id = id;
  getDb().prepare(`INSERT INTO jobs (id, type, title, status, tasks_json) VALUES (?, ?, ?, 'running', ?)`)
    .run(id, plan.type, plan.title, JSON.stringify(plan.tasks));
  startWorker(id);
  return getJob(id);
}

function canRetryTask(task) {
  if (!task || task.status !== "fail" || task.retried || task.fb_post_id) return false;
  const text = `${task.error || ""}\n${task.message || ""}`;
  if (isCommunitySpamBlock(text)) return false;
  if (/App đóng|Không đăng lại file/i.test(text)) return false;
  return true;
}

function cloneRetryTask(task) {
  const opts = { ...(task.opts || {}) };
  let unix = task.unix || null;
  if (opts.delivery === "schedule") {
    try {
      validateScheduleUnix(unix);
    } catch {
      opts.delivery = "now";
      unix = null;
    }
  }
  const file = String(task.claimed_file || "");
  if (file) reservedFiles.add(normPath(file));
  return {
    id: newId(),
    status: "pending",
    page_row_id: task.page_row_id,
    account_id: task.account_id,
    page_id: task.page_id,
    page_name: task.page_name,
    round: task.round || 1,
    unix,
    message: "Đăng lại",
    error: "",
    post_url: "",
    prepared: false,
    claimed_file: file,
    posted: false,
    caption: task.caption,
    video_title: task.video_title,
    comment_text: task.comment_text,
    opts,
    source_task_id: task.id,
  };
}

function collectRetry() {
  const rows = getDb().prepare(
    `SELECT * FROM jobs WHERE status NOT IN ('running', 'queued') ORDER BY created_at DESC LIMIT 50`
  ).all();
  const copies = [];
  const updates = new Map();
  let held = 0;
  for (const row of rows) {
    if (live.has(row.id)) continue;
    const tasks = readTasks(row);
    let changed = false;
    for (const task of tasks) {
      if (!canRetryTask(task)) continue;
      if (spamHold.has(task.account_id)) {
        held += 1;
        continue;
      }
      if (copies.length >= 300) break;
      copies.push(cloneRetryTask(task));
      task.retried = true;
      changed = true;
    }
    if (changed) updates.set(row.id, tasks);
    if (copies.length >= 300) break;
  }
  return { copies, updates, held };
}

export function previewRetry() {
  const rows = getDb().prepare(
    `SELECT * FROM jobs WHERE status NOT IN ('running', 'queued') ORDER BY created_at DESC LIMIT 50`
  ).all();
  let count = 0;
  let held = 0;
  for (const row of rows) {
    if (live.has(row.id)) continue;
    for (const task of readTasks(row)) {
      if (!canRetryTask(task)) continue;
      if (spamHold.has(task.account_id)) held += 1;
      else count += 1;
      if (count >= 300) return { count, held };
    }
  }
  return { count, held };
}

export function createRetryJob(options = {}) {
  const { copies, updates, held } = collectRetry();
  if (!copies.length) {
    if (held) throw new Error("Token đang bị Facebook chặn spam. Chưa đăng lại bài của token đó.");
    throw new Error("Không có bài lỗi để đăng lại.");
  }
  const id = newId();
  for (const task of copies) task.job_id = id;
  const db = getDb();
  db.transaction(() => {
    for (const [jobId, tasks] of updates) saveJob(jobId, tasks);
    db.prepare(`INSERT INTO jobs (id, type, title, status, tasks_json) VALUES (?, 'retry', ?, 'running', ?)`)
      .run(id, `Đăng lại bài lỗi · ${copies.length} bài`, JSON.stringify(copies));
  })();
  if (options.start !== false) startWorker(id);
  return getJob(id);
}

export function createCommentJob() {
  const rows = getDb().prepare(
    `SELECT id, page_row_id, account_id, page_id, page_name, fb_post_id, comment_text
     FROM post_logs WHERE comment_status = 'pending' AND fb_post_id IS NOT NULL
     ORDER BY id LIMIT 300`
  ).all();
  if (!rows.length) throw new Error("Không có comment đang chờ");
  const tasks = rows.map((row) => ({
    id: newId(),
    status: "pending",
    page_row_id: row.page_row_id,
    account_id: row.account_id,
    page_id: row.page_id,
    page_name: row.page_name,
    round: 1,
    unix: null,
    message: "Chờ gửi comment",
    error: "",
    post_url: "",
    prepared: true,
    claimed_file: "",
    caption: "",
    comment_text: row.comment_text || "",
    log_id: row.id,
    fb_post_id: row.fb_post_id,
    opts: { delivery: "comment", post_type: "comment" },
  }));
  const id = newId();
  for (const task of tasks) task.job_id = id;
  getDb().prepare(`INSERT INTO jobs (id, type, title, status, tasks_json) VALUES (?, 'comment', ?, 'running', ?)`)
    .run(id, `Gửi comment chờ · ${tasks.length}`, JSON.stringify(tasks));
  startWorker(id);
  return getJob(id);
}

function startWorker(jobId) {
  if (live.has(jobId)) return;
  const state = { stop: false, pause: false };
  live.set(jobId, state);
  runJob(jobId, state).catch((e) => {
    const job = loadJob(jobId);
    if (job) saveJob(jobId, job.tasks, { status: "paused", finished_at: null });
    console.error("[job]", jobId, e.message);
  }).finally(() => {
    live.delete(jobId);
  });
}

async function runJob(jobId, state) {
  let job = loadJob(jobId);
  if (!job) return;
  if (!state.pause && !state.stop) saveJob(jobId, job.tasks, { status: "running" });
  const groups = new Map();
  for (const task of job.tasks) {
    if (!groups.has(task.account_id)) groups.set(task.account_id, []);
    groups.get(task.account_id).push(task);
  }
  await Promise.all([...groups.values()].map((lane) => runLane(jobId, state, lane)));
  job = loadJob(jobId);
  const tasks = job.tasks;
  for (const task of tasks) {
    if (state.stop && (task.status === "pending" || task.status === "running")) {
      task.status = "skipped";
      task.message = "Đã dừng";
    }
  }
  saveJob(jobId, tasks, {
    status: state.stop ? "stopped" : "done",
    finished_at: new Date().toISOString(),
  });
}

async function checkpoint(state) {
  while (state.pause && !state.stop) await sleep(400);
  return !state.stop;
}

async function waitUntil(unixSec, state) {
  const target = Number(unixSec) * 1000;
  while (!state.stop) {
    if (!(await checkpoint(state))) return false;
    const left = target - Date.now();
    if (left <= 0) return true;
    await sleep(Math.min(left, 1000));
  }
  return false;
}

async function waitGap(accountId, state) {
  const prev = lastCallAt.get(accountId) || 0;
  const left = GAP_MS - (Date.now() - prev);
  const end = Date.now() + Math.max(0, left);
  while (Date.now() < end) {
    if (!(await checkpoint(state))) return false;
    await sleep(Math.min(1000, end - Date.now()));
  }
  return !state.stop;
}

async function runLane(jobId, state, lane) {
  for (const task of lane) {
    if (["ok", "fail", "skipped"].includes(task.status)) continue;
    if (!(await checkpoint(state))) {
      markSkipped(jobId, task, "Đã dừng");
      continue;
    }
    if (spamHold.has(task.account_id)) {
      markSkipped(jobId, task, "Dừng — Facebook đang chặn đăng dày trên token này");
      continue;
    }
    if (task.opts?.delivery === "direct" && task.unix) {
      const due = await waitUntil(task.unix, state);
      if (!due) {
        markSkipped(jobId, task, "Đã dừng trong lúc chờ giờ đăng trực tiếp");
        continue;
      }
    }
    if (!(await waitGap(task.account_id, state))) {
      markSkipped(jobId, task, "Đã dừng");
      continue;
    }
    if (spamHold.has(task.account_id)) {
      markSkipped(jobId, task, "Dừng — Facebook đang chặn đăng dày trên token này");
      continue;
    }
    task.status = "running";
    task.message = task.opts?.delivery === "schedule" ? "Đang hẹn lên Facebook" : "Đang đăng";
    replaceTask(jobId, task);
    try {
      const result = await withRetry(jobId, state, task);
      task.status = "ok";
      task.post_url = result.post_url || task.post_url || "";
      task.message = result.message;
      task.error = "";
    } catch (e) {
      task.status = "fail";
      task.error = e.message || String(e);
      task.message = task.error;
      if (isCommunitySpamBlock(e)) spamHold.add(task.account_id);
      releaseFile(task);
    }
    replaceTask(jobId, task);
  }
}

function markSkipped(jobId, task, message) {
  task.status = "skipped";
  task.message = message;
  replaceTask(jobId, task);
}

function replaceTask(jobId, task) {
  const job = loadJob(jobId);
  if (!job) return;
  const tasks = job.tasks.map((item) => item.id === task.id ? task : item);
  saveJob(jobId, tasks);
}

function releaseFile(task) {
  if (task.claimed_file && !task.opts?.repeat_media && !task.posted) {
    reservedFiles.delete(normPath(task.claimed_file));
  }
}

async function withRetry(jobId, state, task) {
  let last;
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (state.stop) throw permanent("Đã dừng");
    try {
      const result = await executeOnce(task, state);
      if (task._calledGraph) lastCallAt.set(task.account_id, Date.now());
      task._calledGraph = false;
      return result;
    } catch (e) {
      last = e;
      if (task._calledGraph) lastCallAt.set(task.account_id, Date.now());
      task._calledGraph = false;
      if (!isTransient(e) || attempt === 3 || state.stop) throw e;
      const wait = Math.max(GAP_MS, isRateWait(e) ? 60000 * attempt : 4000 * attempt);
      task.message = `Facebook lỗi tạm, chờ ${Math.round(wait / 1000)}s rồi thử lại (${attempt}/3)`;
      replaceTask(jobId, task);
      await sleep(wait);
    }
  }
  throw last || new Error("Thất bại");
}

function isRateWait(err) {
  const code = Number(err?.code ?? err?.fb?.code);
  return [4, 17, 32, 613].includes(code);
}

function prepare(task) {
  const opts = task.opts || {};
  if (opts.delivery === "comment") return;
  if (opts.post_type === "video" || opts.post_type === "photo") {
    if (!opts.media_folder) throw permanent("Chưa chọn thư mục media");
    if (!task.claimed_file) {
      task.claimed_file = opts.repeat_media
        ? fileAtRound(opts.media_folder, opts.post_type, task.round)
        : claimNextFile(opts.media_folder, opts.post_type, reservedFiles);
    }
  }
  if (task.video_title == null) {
    task.video_title = "";
    if (opts.title_enabled && opts.post_type === "video" && opts.title_file) {
      if (opts.repeat_media || opts.title_mode !== "random") task.video_title = lineAt(opts.title_file, task.round);
      else {
        const lines = readTextLines(opts.title_file);
        task.video_title = lines.length ? lines[Math.floor(Math.random() * lines.length)] : "";
      }
      if (!task.video_title) throw permanent("Hết dòng title video hoặc file trống");
    }
  }
  if (task.caption == null) {
    let body = "";
    if (opts.use_caption && opts.caption_file) {
      if (opts.caption_mode === "random" && !opts.repeat_media) {
        const lines = readTextLines(opts.caption_file);
        body = lines.length ? lines[Math.floor(Math.random() * lines.length)] : "";
      } else if (opts.repeat_media) body = lineAt(opts.caption_file, task.round);
      else body = takeNextLine(opts.caption_file);
    }
    task.caption = opts.lead_on ? composeCaption(body, opts.lead_opener, opts.lead_link) : body;
    if (opts.post_type === "text" && !task.caption) throw permanent("Hết dòng tiêu đề hoặc file trống");
  }
  if (task.comment_text == null) {
    task.comment_text = "";
    if (opts.comment_enabled && opts.comment_from_file) {
      task.comment_text = opts.repeat_media
        ? lineAt(opts.comment_file, task.round)
        : takeNextLine(opts.comment_file);
      if (!task.comment_text) throw permanent("Hết dòng comment hoặc file trống");
    }
  }
  task.prepared = true;
}

async function executeOnce(task, state) {
  if (!task.prepared) prepare(task);
  const page = getPageToken(task.page_row_id);
  if (!page?.token) throw permanent("Page không còn token");
  if (task.opts?.delivery === "comment") {
    task._calledGraph = true;
    const sent = await publishComment(task.fb_post_id, page.token, task.comment_text);
    if (sent.pending) {
      return { message: "Comment vẫn chờ vì bài chưa public", post_url: "" };
    }
    getDb().prepare(`UPDATE post_logs SET comment_id = ?, comment_status = 'sent', error = NULL WHERE id = ?`)
      .run(sent.comment_id, task.log_id);
    return { message: "Đã gửi comment", post_url: "" };
  }

  const when = task.opts.delivery === "schedule" ? task.unix : null;
  let post = {
    post_id: task.fb_post_id || null,
    post_url: task.post_url || null,
  };
  if (!post.post_id) {
    task._calledGraph = true;
    if (task.opts.post_type === "text") post = await publishText(page.page_id, page.token, task.caption, when);
    else if (task.opts.post_type === "photo") post = await publishPhoto(page.page_id, page.token, task.claimed_file, task.caption, when);
    else post = await publishVideo(page.page_id, page.token, task.claimed_file, task.caption, when, task.video_title || "");
    task.fb_post_id = post.post_id;
    task.post_url = post.post_url || "";
    task._calledGraph = false;
    lastCallAt.set(task.account_id, Date.now());
    if (task.job_id) replaceTask(task.job_id, task);
  }

  let commentStatus = "off";
  let commentId = null;
  let commentError = "";
  const action = commentAction(task);
  if (action === "pending") commentStatus = "pending";
  if (action === "send") {
    const delayMin = Math.max(0, Math.min(10080, Math.round(Number(task.opts?.comment_delay_minutes) || 0)));
    let sendNow = true;
    if (delayMin > 0 && task.opts?.delivery !== "schedule" && state) {
      task.message = `Đã đăng, chờ ${delayMin} phút rồi gửi comment`;
      if (task.job_id) replaceTask(task.job_id, task);
      const due = Math.floor(Date.now() / 1000) + delayMin * 60;
      sendNow = await waitUntil(due, state);
      if (!sendNow) commentStatus = "pending";
    }
    if (!sendNow) {
      /* The post is already on Facebook. The comment stays pending. */
    } else try {
      task._calledGraph = true;
      const sent = await publishComment(post.post_id, page.token, task.comment_text);
      task._calledGraph = false;
      lastCallAt.set(task.account_id, Date.now());
      if (sent.pending) commentStatus = "pending";
      else {
        commentStatus = "sent";
        commentId = sent.comment_id;
      }
    } catch (e) {
      task._calledGraph = false;
      lastCallAt.set(task.account_id, Date.now());
      commentError = e.message || String(e);
      commentStatus = "failed";
      if (isCommunitySpamBlock(e)) spamHold.add(task.account_id);
    }
  }

  let moved = "";
  if (task.claimed_file && !task.opts.repeat_media) {
    try {
      moved = moveToPosted(task.claimed_file, task.opts?.posted_folder);
      task.posted = true;
    } catch (e) {
      moved = "";
      commentError = commentError || `Đã đăng nhưng chưa chuyển file: ${e.message}`;
    }
  }

  const delivery = task.opts.delivery;
  if (!task.logged) {
  getDb().prepare(
    `INSERT INTO post_logs (job_id, page_row_id, account_id, page_id, page_name, post_type, delivery,
      fb_post_id, post_url, caption, comment_text, comment_id, comment_status, media_path, scheduled_at, status, error)
     VALUES (@job_id, @page_row_id, @account_id, @page_id, @page_name, @post_type, @delivery,
      @fb_post_id, @post_url, @caption, @comment_text, @comment_id, @comment_status, @media_path, @scheduled_at, @status, @error)`
  ).run({
    job_id: task.job_id || null,
    page_row_id: task.page_row_id,
    account_id: task.account_id,
    page_id: page.page_id,
    page_name: page.name,
    post_type: task.opts.post_type,
    delivery,
    fb_post_id: post.post_id,
    post_url: post.post_url,
    caption: task.caption || "",
    comment_text: task.comment_text || "",
    comment_id: commentId,
    comment_status: commentStatus,
    media_path: task.claimed_file || "",
    scheduled_at: when,
    status: delivery === "schedule" ? "scheduled" : "ok",
    error: commentError,
  });
    task.logged = true;
  }

  const bits = [delivery === "schedule" ? `Đã hẹn ${formatVn(when)}` : "Đã đăng"];
  if (post.post_url) bits.push(post.post_url);
  if (commentStatus === "sent") bits.push("comment đã gửi");
  else if (commentStatus === "pending") bits.push("comment chờ khi bài public");
  else if (commentError) bits.push(`comment lỗi: ${commentError}`);
  if (moved) bits.push("đã chuyển file");
  return { message: bits.join(" · "), post_url: post.post_url || "" };
}

export function stopJob(id) {
  const state = live.get(id);
  const job = loadJob(id);
  if (!job) throw new Error("Không thấy job");
  if (state) {
    state.stop = true;
    state.pause = false;
    return getJob(id);
  }
  for (const task of job.tasks) {
    if (task.status === "pending" || task.status === "running") {
      task.status = "skipped";
      task.message = "Đã dừng";
    }
  }
  saveJob(id, job.tasks, { status: "stopped", finished_at: new Date().toISOString() });
  return getJob(id);
}

export function pauseJob(id) {
  const job = loadJob(id);
  if (!job) throw new Error("Không thấy job");
  const state = live.get(id);
  if (state) state.pause = true;
  if (job.status === "running" || job.status === "queued") saveJob(id, job.tasks, { status: "paused" });
  return getJob(id);
}

export function resumeJob(id) {
  const job = loadJob(id);
  if (!job) throw new Error("Không thấy job");
  if (job.status === "done" || job.status === "stopped") throw new Error("Job đã kết thúc");
  const state = live.get(id);
  if (state) {
    state.pause = false;
    saveJob(id, job.tasks, { status: "running" });
    return getJob(id);
  }
  saveJob(id, job.tasks, { status: "running" });
  startWorker(id);
  return getJob(id);
}

export function listLogs(limit = 200) {
  return getDb().prepare(
    `SELECT id, page_name, page_id, post_type, delivery, fb_post_id, post_url, caption, comment_text,
            comment_id, comment_status, media_path, scheduled_at, status, error, created_at
     FROM post_logs ORDER BY id DESC LIMIT ?`
  ).all(Math.max(1, Math.min(1000, limit))).map((row) => ({
    ...row,
    when: row.scheduled_at ? formatVn(row.scheduled_at) : "",
  }));
}

export function logsCsv() {
  const rows = listLogs(5000);
  const header = ["id", "page_name", "page_id", "post_type", "delivery", "status", "fb_post_id", "post_url", "when", "comment_status", "error", "created_at"];
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(header.map((key) => csv(row[key])).join(","));
  }
  return lines.join("\r\n");
}

function csv(value) {
  const text = value == null ? "" : String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}
