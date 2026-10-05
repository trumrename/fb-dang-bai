import fs from "fs";
import path from "path";
import { graphGet, graphPostForm, graphPostJson, GRAPH_VIDEO, isCommunitySpamBlock } from "./graph.js";
import { validateScheduleUnix } from "./time.js";

const SIMPLE_VIDEO_MAX = 8 * 1024 * 1024;
const CHUNK = 4 * 1024 * 1024;
const countryCache = new Map();

export function parseCountryRestriction(value) {
  let parsed = value;
  if (typeof parsed === "string") {
    const s = parsed.trim();
    if (!s || s === "null" || s === "{}") return null;
    try {
      parsed = JSON.parse(s);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object") return null;
  const typeRaw = String(parsed.restriction_type || parsed.type || "").toLowerCase();
  const type = typeRaw === "whitelist" || typeRaw === "whitelist_only"
    ? "whitelist"
    : typeRaw === "blacklist"
      ? "blacklist"
      : "";
  const raw = parsed.countries || parsed.country || [];
  const list = Array.isArray(raw) ? raw : [raw];
  const countries = [...new Set(list.map((c) => String(c || "").trim().toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c)))];
  if (!type || !countries.length) return null;
  return { type, countries };
}

function withTitle(fields, title) {
  const text = String(title || "").replace(/\s+/g, " ").trim();
  if (!text) return fields;
  return { ...fields, title: text.slice(0, 255) };
}

/**
 * Direct video is published for every country the Page does not already block.
 * The Page blacklist stays on the Page. Copying it as excluded_countries made
 * Facebook store privacy CUSTOM with empty allow and deny lists, so countries
 * that are not blocked could not watch either. embeddable stays 1.
 * A whitelist is still sent, because those Pages only allow that country list.
 */
export function directVideoFields(description, restriction, title = "") {
  const fields = {
    description: description || "",
    secret: "0",
    no_story: "0",
    embeddable: "1",
    published: "true",
  };
  if (restriction?.type === "whitelist" && restriction.countries?.length) {
    fields.targeting = JSON.stringify({ geo_locations: { countries: restriction.countries } });
  }
  return withTitle(fields, title);
}

/**
 * Scheduled video matches the 1.4.154 / 1.4.165 payload.
 * No country targeting and no video_reels. Page-level country settings stay on the Page.
 */
export function scheduledVideoFields(description, unixSec, title = "") {
  const t = validateScheduleUnix(unixSec);
  return withTitle({
    description: description || "",
    secret: "false",
    no_story: "false",
    embeddable: "true",
    published: "false",
    scheduled_publish_time: String(t),
    unpublished_content_type: "SCHEDULED",
  }, title);
}

export function feedScheduleFields(unixSec) {
  if (!unixSec) return { published: "true" };
  const t = validateScheduleUnix(unixSec);
  return {
    published: "false",
    scheduled_publish_time: String(t),
    unpublished_content_type: "SCHEDULED",
  };
}

export function shouldDropTargeting(err, fields) {
  if (!fields?.targeting) return false;
  const msg = String(err?.message || err?.fb?.message || "");
  const code = Number(err?.code ?? err?.fb?.code);
  if (code === 100 && /targeting|geo_location|excluded_countries|countries|overlap/i.test(msg)) return true;
  return /problem uploading your video file/i.test(msg);
}

function requireFile(filePath, label) {
  if (!filePath || !fs.existsSync(filePath)) {
    const err = new Error(`Không thấy file ${label}: ${filePath || ""}`);
    err.code = "MEDIA_FILE_MISSING";
    err.permanent = true;
    throw err;
  }
  const size = fs.statSync(filePath).size;
  if (!size) {
    const err = new Error(`File ${label} rỗng (0 byte): ${path.basename(filePath)}`);
    err.code = "MEDIA_FILE_EMPTY";
    err.permanent = true;
    throw err;
  }
  return size;
}

async function loadCountry(pageId, token) {
  const key = String(pageId || "");
  if (!key) return null;
  if (countryCache.has(key)) return countryCache.get(key);
  let parsed = null;
  try {
    const data = await graphGet(`/${key}/settings`, token);
    const row = (data?.data || []).find((x) => x && x.setting === "COUNTRY_RESTRICTIONS");
    parsed = parseCountryRestriction(row?.value);
  } catch {
    parsed = null;
  }
  countryCache.set(key, parsed);
  return parsed;
}

function scheduleIsFuture(unixSec) {
  const n = Number(unixSec);
  return Number.isFinite(n) && n * 1000 > Date.now() + 15000;
}

async function enrich(objectId, token, base) {
  if (!objectId || scheduleIsFuture(base.scheduled_at)) return base;
  try {
    const st = await graphGet(`/${objectId}`, token, { fields: "id,permalink_url" });
    const url = st.permalink_url
      ? (String(st.permalink_url).startsWith("http") ? st.permalink_url : `https://www.facebook.com${st.permalink_url}`)
      : base.post_url;
    return { ...base, post_id: st.id || objectId, post_url: url || base.post_url };
  } catch {
    return base;
  }
}

export async function publishText(pageId, token, message, scheduleUnix = null) {
  const data = await graphPostJson(`/${pageId}/feed`, token, {
    message: message || "",
    ...feedScheduleFields(scheduleUnix),
  });
  const postId = data.id || null;
  return enrich(postId, token, {
    post_id: postId,
    post_url: postId ? `https://www.facebook.com/${postId}` : null,
    scheduled_at: scheduleUnix ? Number(scheduleUnix) : null,
  });
}

export async function publishPhoto(pageId, token, filePath, caption, scheduleUnix = null) {
  requireFile(filePath, "ảnh");
  const data = await graphPostForm(
    `/${pageId}/photos`,
    token,
    { caption: caption || "", ...feedScheduleFields(scheduleUnix) },
    { name: "source", buffer: fs.readFileSync(filePath), filename: path.basename(filePath) },
    { label: "ảnh" }
  );
  const postId = data.post_id || data.id || null;
  return enrich(postId, token, {
    post_id: postId,
    post_url: postId ? `https://www.facebook.com/${postId}` : null,
    scheduled_at: scheduleUnix ? Number(scheduleUnix) : null,
  });
}

async function uploadVideo(pageId, token, filePath, fields) {
  const size = requireFile(filePath, "video");
  if (size > SIMPLE_VIDEO_MAX) return uploadResumable(pageId, token, filePath, fields);
  try {
    return await graphPostForm(
      `/${pageId}/videos`,
      token,
      fields,
      { name: "source", buffer: fs.readFileSync(filePath), filename: path.basename(filePath) },
      { label: "video" }
    );
  } catch (e) {
    if (e.code === "PAYLOAD_TOO_LARGE" || e.status === 413) {
      return uploadResumable(pageId, token, filePath, fields);
    }
    throw e;
  }
}

async function uploadResumable(pageId, token, filePath, fields) {
  const fileSize = requireFile(filePath, "video");
  const opts = { baseUrl: GRAPH_VIDEO, label: "video" };
  const start = await graphPostForm(`/${pageId}/videos`, token, {
    upload_phase: "start",
    file_size: String(fileSize),
  }, null, { ...opts, label: "video start" });
  const session = start.upload_session_id || start.session_id;
  if (!session) {
    const err = new Error("Facebook không trả upload_session_id");
    err.permanent = true;
    throw err;
  }
  let startOffset = Number(start.start_offset ?? 0);
  let endOffset = Number(start.end_offset ?? 0);
  const fd = fs.openSync(filePath, "r");
  try {
    let rounds = 0;
    while (startOffset < endOffset) {
      rounds += 1;
      if (rounds > 5000) throw new Error("Upload video quá nhiều đoạn");
      const len = Math.min(endOffset - startOffset, CHUNK);
      const buf = Buffer.alloc(len);
      const read = fs.readSync(fd, buf, 0, len, startOffset);
      const chunk = read === len ? buf : buf.subarray(0, read);
      const transfer = await graphPostForm(`/${pageId}/videos`, token, {
        upload_phase: "transfer",
        upload_session_id: String(session),
        start_offset: String(startOffset),
      }, { name: "video_file_chunk", buffer: chunk, filename: path.basename(filePath) }, opts);
      const nextStart = Number(transfer.start_offset ?? startOffset);
      const nextEnd = Number(transfer.end_offset ?? endOffset);
      if (nextStart === nextEnd) {
        startOffset = nextStart;
        endOffset = nextEnd;
        break;
      }
      if (nextStart <= startOffset && nextEnd === endOffset) {
        throw new Error(`Upload video không tiến triển (offset ${startOffset})`);
      }
      startOffset = nextStart;
      endOffset = nextEnd;
    }
  } finally {
    fs.closeSync(fd);
  }
  return graphPostForm(`/${pageId}/videos`, token, {
    upload_phase: "finish",
    upload_session_id: String(session),
    ...fields,
  }, null, { ...opts, label: "video finish" });
}

export async function publishVideo(pageId, token, filePath, description, scheduleUnix = null, title = "") {
  requireFile(filePath, "video");
  const scheduling = !!scheduleUnix;
  let fields = scheduling
    ? scheduledVideoFields(description, scheduleUnix, title)
    : directVideoFields(description, await loadCountry(pageId, token), title);
  let data;
  try {
    data = await uploadVideo(pageId, token, filePath, fields);
  } catch (e) {
    if (!scheduling && shouldDropTargeting(e, fields)) {
      delete fields.targeting;
      fields = { ...fields };
      data = await uploadVideo(pageId, token, filePath, fields);
    } else {
      throw e;
    }
  }
  const postId = data.id || data.post_id || null;
  return enrich(postId, token, {
    post_id: postId,
    post_url: postId ? `https://www.facebook.com/${postId}` : null,
    scheduled_at: scheduleUnix ? Number(scheduleUnix) : null,
  });
}

export function firstUrl(message) {
  const match = String(message || "").match(/https?:\/\/[^\s<>"']+/i);
  if (!match) return "";
  return match[0].replace(/[)\].,;!?]+$/g, "");
}

function attachmentRejected(err) {
  if (isCommunitySpamBlock(err)) return false;
  const code = Number(err?.code ?? err?.fb?.code ?? NaN);
  if ([4, 17, 32, 368, 613].includes(code)) return false;
  return /attachment/i.test(String(err?.message || err?.fb?.message || ""));
}

export function commentWaitingForPublish(err) {
  if (isCommunitySpamBlock(err)) return false;
  const msg = String(err?.message || err?.fb?.message || "");
  return /unpublished|not published|isn't published|is not published|chưa được đăng|scheduled post/i.test(msg);
}

/** First URL is also sent as attachment_share_url so Facebook can show a link card. */
export async function publishComment(postId, token, message) {
  if (!postId) throw new Error("Thiếu id bài để gửi comment");
  if (!message) throw new Error("Comment trống");
  const shareUrl = firstUrl(message);
  const body = { message };
  if (shareUrl) body.attachment_share_url = shareUrl;
  try {
    const data = await graphPostJson(`/${postId}/comments`, token, body);
    return { comment_id: data.id || null, pending: false };
  } catch (e) {
    if (shareUrl && attachmentRejected(e)) {
      try {
        const data = await graphPostJson(`/${postId}/comments`, token, { message });
        return { comment_id: data.id || null, pending: false };
      } catch (again) {
        if (commentWaitingForPublish(again)) return { comment_id: null, pending: true };
        throw again;
      }
    }
    if (commentWaitingForPublish(e)) return { comment_id: null, pending: true };
    throw e;
  }
}
