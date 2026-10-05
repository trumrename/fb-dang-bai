/**
 * Graph calls for user-token login and Page publish.
 * No app secret and no appsecret_proof. Turn off "Require App Secret Proof" on the Meta app
 * if Facebook rejects the token.
 */

export const GRAPH_VERSION = "v21.0";
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;
export const GRAPH_VIDEO = `https://graph-video.facebook.com/${GRAPH_VERSION}`;

function graphRoot() {
  const raw = String(process.env.FB_DANGBAI_GRAPH_ORIGIN || "").trim().replace(/\/$/, "");
  if (/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(raw)) return raw;
  return GRAPH;
}

const PAGE_FIELDS = "id,name,access_token,tasks,category";

export function extractGraphError(errOrBody) {
  if (!errOrBody) return null;
  if (errOrBody.fb && typeof errOrBody.fb === "object") return errOrBody.fb;
  if (errOrBody.error && typeof errOrBody.error === "object") return errOrBody.error;
  if (errOrBody.code != null && (errOrBody.message != null || errOrBody.type != null)) return errOrBody;
  return null;
}

/** Community spam lock. Retrying makes the lock longer. Code 368 alone is not this. */
export function isCommunitySpamBlock(errOrBody) {
  if (!errOrBody) return false;
  const fb = extractGraphError(errOrBody) || {};
  const sub = Number(fb.error_subcode ?? errOrBody.error_subcode ?? errOrBody.subcode ?? NaN);
  const msg = String(
    fb.error_user_msg || fb.message || errOrBody.error || errOrBody.message ||
      (typeof errOrBody === "string" ? errOrBody : "")
  );
  if (sub === 1390008) return true;
  return /bảo vệ cộng đồng khỏi spam|protect the community from spam|limit how often you can post/i.test(msg);
}

const RATE_CODES = new Set([4, 17, 32, 613, 80000, 80001, 80003, 80004, 80005, 80006, 80014]);

export function isRateLimit(errOrBody) {
  if (!errOrBody || isCommunitySpamBlock(errOrBody)) return false;
  const fb = extractGraphError(errOrBody) || {};
  const code = Number(fb.code ?? errOrBody.code ?? NaN);
  if (RATE_CODES.has(code)) return true;
  const http = Number(errOrBody.http_status ?? errOrBody.status ?? NaN);
  if (http === 429) return true;
  const msg = String(fb.message || errOrBody.message || "");
  return /application request limit|user request limit|page request limit|too many calls|rate limit/i.test(msg);
}

export function isNetworkError(errOrBody) {
  if (!errOrBody) return false;
  const code = String(errOrBody.code || errOrBody.cause?.code || "").toUpperCase();
  const msg = String(errOrBody.message || errOrBody.cause?.message || "");
  if (code === "PAYLOAD_TOO_LARGE" || Number(errOrBody.status) === 413) return false;
  if (["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_SOCKET", "ABORT_ERR", "EMPTY_GRAPH_BODY", "BAD_GRAPH_JSON"].includes(code)) {
    return true;
  }
  return /fetch failed|socket hang up|timed out|timeout|econnreset|unexpected end of json|trả về rỗng/i.test(msg);
}

/** Worth one automatic retry. Spam, missing files, and permission errors are not. */
export function isTransient(errOrBody) {
  if (!errOrBody || isCommunitySpamBlock(errOrBody)) return false;
  if (errOrBody.permanent === true) return false;
  if (isRateLimit(errOrBody) || isNetworkError(errOrBody)) return true;
  const fb = extractGraphError(errOrBody) || {};
  const code = Number(fb.code ?? errOrBody.code ?? NaN);
  const msg = String(fb.message || errOrBody.message || errOrBody.error || "");
  if (code === 1 || code === 2) return true;
  return /unknown error|unexpected error|please retry|temporarily|service unavailable|something went wrong/i.test(msg);
}

export function isPageTokenShapeError(message) {
  return /nonexisting field \(accounts\)|node type \(Page\)/i.test(String(message || ""));
}

function wrapFetch(e, label) {
  const err = new Error(/fetch failed/i.test(e?.message || "")
    ? `Không kết nối được Facebook (${label})`
    : (e?.message || String(e)));
  err.code = e?.code || e?.cause?.code || "FETCH_FAILED";
  err.network = true;
  err.cause = e;
  return err;
}

async function readBody(res, label) {
  const text = await res.text();
  const status = Number(res.status || 0);
  if (!text || !text.trim()) {
    const err = new Error(status === 413
      ? `Facebook từ chối upload (HTTP 413) — ${label}`
      : `Facebook trả về rỗng (HTTP ${status || "?"}) — ${label}`);
    err.status = status;
    err.code = status === 413 ? "PAYLOAD_TOO_LARGE" : "EMPTY_GRAPH_BODY";
    err.permanent = status === 413;
    err.network = status !== 413;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    const err = new Error(`Facebook trả JSON lỗi (HTTP ${status}) — ${label}`);
    err.code = "BAD_GRAPH_JSON";
    err.network = true;
    err.status = status;
    err.cause = e;
    throw err;
  }
}

function throwGraph(data) {
  const err = new Error(data.error?.message || "Graph error");
  err.code = data.error?.code;
  err.fb = data.error;
  if (data.error?.error_subcode != null) err.error_subcode = data.error.error_subcode;
  throw err;
}

export async function graphGet(path, token, query = {}, timeoutMs = 60000) {
  const url = new URL(`${graphRoot()}${path}`);
  url.searchParams.set("access_token", token);
  for (const [k, v] of Object.entries(query)) {
    if (v != null && v !== "") url.searchParams.set(k, String(v));
  }
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw wrapFetch(e, "GET");
  }
  const data = await readBody(res, "GET");
  if (data.error) throwGraph(data);
  return data;
}

export async function graphGetSoft(path, token, query = {}) {
  try {
    return { ok: true, data: await graphGet(path, token, query) };
  } catch (e) {
    return { ok: false, error: e.message, code: e.code, fb: e.fb || null };
  }
}

async function graphGetAll(path, token, query = {}, maxPages = 40) {
  const all = [];
  let after = "";
  let lastError = "";
  for (let i = 0; i < maxPages; i++) {
    const q = { ...query, limit: query.limit || 100 };
    if (after) q.after = after;
    const r = await graphGetSoft(path, token, q);
    if (!r.ok) {
      lastError = r.error || "Graph error";
      break;
    }
    const batch = r.data?.data || [];
    all.push(...batch);
    const next = r.data?.paging?.cursors?.after;
    if (!r.data?.paging?.next || !next || batch.length === 0) break;
    after = next;
  }
  return { ok: all.length > 0 || !lastError, data: all, error: lastError };
}

function mergePage(byId, page, source) {
  if (!page?.id) return false;
  const id = String(page.id);
  const prev = byId.get(id);
  if (!prev) {
    byId.set(id, {
      id,
      name: page.name || id,
      category: page.category || "",
      access_token: page.access_token || "",
      tasks: page.tasks || [],
      sources: [source],
    });
    return true;
  }
  prev.name = page.name || prev.name;
  prev.category = page.category || prev.category;
  if (page.access_token) prev.access_token = page.access_token;
  if (Array.isArray(page.tasks) && page.tasks.length) prev.tasks = page.tasks;
  if (!prev.sources.includes(source)) prev.sources.push(source);
  return false;
}

/**
 * Pages a user or system-user token can publish to.
 * /me/accounts, assigned pages, and Business Manager owned/client pages.
 * A listed page with no access_token is asked once, then skipped.
 */
export async function listPublishablePages(userToken) {
  const byId = new Map();
  const errors = [];

  const accounts = await graphGetAll("/me/accounts", userToken, { fields: PAGE_FIELDS, limit: 100 });
  if (accounts.error) errors.push(`me/accounts: ${accounts.error}`);
  for (const p of accounts.data) mergePage(byId, p, "me/accounts");

  const me = await graphGetSoft("/me", userToken, { fields: "id,name" });
  const meId = me.ok ? String(me.data?.id || "") : "";
  const assignedPaths = ["/me/assigned_pages"];
  if (meId) assignedPaths.push(`/${meId}/assigned_pages`);
  for (const edge of assignedPaths) {
    const assigned = await graphGetAll(edge, userToken, { fields: PAGE_FIELDS, limit: 100 });
    if (assigned.error) errors.push(`${edge}: ${assigned.error}`);
    for (const p of assigned.data) mergePage(byId, p, "assigned_pages");
  }

  const businesses = await graphGetSoft("/me/businesses", userToken, { fields: "id,name", limit: 50 });
  if (!businesses.ok && businesses.error) errors.push(`me/businesses: ${businesses.error}`);
  for (const b of businesses.data?.data || []) {
    if (!b?.id) continue;
    for (const edge of ["owned_pages", "client_pages"]) {
      const listed = await graphGetAll(`/${b.id}/${edge}`, userToken, { fields: PAGE_FIELDS, limit: 100 });
      if (listed.error) errors.push(`${b.name || b.id}/${edge}: ${listed.error}`);
      for (const p of listed.data) mergePage(byId, p, edge);
    }
  }

  const businessUsers = await graphGetSoft("/me/business_users", userToken, { fields: "id,name", limit: 50 });
  if (!businessUsers.ok && businessUsers.error) errors.push(`me/business_users: ${businessUsers.error}`);
  for (const bu of businessUsers.data?.data || []) {
    if (!bu?.id) continue;
    const assigned = await graphGetAll(`/${bu.id}/assigned_pages`, userToken, { fields: PAGE_FIELDS, limit: 100 });
    if (assigned.error) errors.push(`business user ${bu.id}: ${assigned.error}`);
    for (const p of assigned.data) mergePage(byId, p, "business_user");
  }

  let resolved = 0;
  for (const page of byId.values()) {
    if (page.access_token) continue;
    const one = await graphGetSoft(`/${page.id}`, userToken, { fields: PAGE_FIELDS });
    if (one.ok && one.data?.access_token) {
      mergePage(byId, one.data, "resolve");
      resolved += 1;
    }
  }

  const pages = [...byId.values()];
  const withToken = pages.filter((p) => p.access_token);
  const skipped = pages.filter((p) => !p.access_token).map((p) => p.name || p.id);
  return {
    me: me.ok ? me.data : null,
    pages: withToken,
    skipped_no_token: skipped,
    resolved,
    errors,
  };
}

export async function graphPostJson(path, token, body) {
  const url = new URL(`${graphRoot()}${path}`);
  url.searchParams.set("access_token", token);
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(60000),
    });
  } catch (e) {
    throw wrapFetch(e, "POST");
  }
  const data = await readBody(res, "POST");
  if (data.error) throwGraph(data);
  return data;
}

export async function graphPostForm(path, token, fields, file, opts = {}) {
  const base = opts.baseUrl || graphRoot();
  const url = `${base}${path}`;
  const form = new FormData();
  form.append("access_token", token);
  for (const [k, v] of Object.entries(fields || {})) {
    if (v != null) form.append(k, String(v));
  }
  if (file?.buffer) {
    form.append(file.name, new Blob([file.buffer]), file.filename || "upload.bin");
  }
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(file ? 180000 : 60000),
    });
  } catch (e) {
    throw wrapFetch(e, opts.label || "POST form");
  }
  const data = await readBody(res, opts.label || "POST form");
  if (data.error) throwGraph(data);
  return data;
}
