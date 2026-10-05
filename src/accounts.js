import { getDb } from "./db.js";
import { decryptToken, encryptToken, maskToken, tokenHash } from "./crypto.js";
import { graphGet, graphGetSoft, isPageTokenShapeError, listPublishablePages } from "./graph.js";

function splitTokens(raw) {
  return [...new Set(String(raw || "").split(/\s+/).map((s) => s.trim()).filter((s) => s.length >= 20))];
}

export function listAccounts() {
  return getDb().prepare(
    `SELECT id, name, fb_user_id, kind, page_count, status, last_error, updated_at
     FROM accounts WHERE status != 'deleted' ORDER BY id`
  ).all();
}

export function listPages() {
  return getDb().prepare(
    `SELECT p.id, p.account_id, p.page_id, p.name, p.category, p.media_folder, p.status,
            a.name AS account_name
     FROM pages p
     JOIN accounts a ON a.id = p.account_id
     WHERE p.status = 'active' AND a.status != 'deleted'
     ORDER BY a.name COLLATE NOCASE, p.name COLLATE NOCASE`
  ).all();
}

export function getPageToken(pageRowId) {
  const row = getDb().prepare(
    `SELECT p.id, p.token_enc, p.page_id, p.name, p.account_id, p.media_folder, a.name AS account_name
     FROM pages p JOIN accounts a ON a.id = p.account_id
     WHERE p.id = ? AND p.status = 'active'`
  ).get(pageRowId);
  if (!row?.token_enc) return null;
  return { ...row, token: decryptToken(row.token_enc) };
}

export async function importTokens(raw, label = "") {
  const tokens = splitTokens(raw);
  if (!tokens.length) throw new Error("Dán user token hoặc page token. Mỗi token một dòng.");
  const results = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const name = tokens.length === 1 ? String(label || "").trim() : (label ? `${label} ${i + 1}` : "");
    try {
      results.push(await importOne(token, name));
    } catch (e) {
      results.push({ ok: false, error: e.message, mask: maskToken(token) });
    }
  }
  return results;
}

async function importOne(token, label) {
  const meTry = await graphGetSoft("/me", token, { fields: "id,name" });
  if (!meTry.ok) {
    if (meTry.code === 190) throw new Error(meTry.error || "Token hết hạn");
    throw new Error(meTry.error || "Token không gọi được /me");
  }
  const probe = await graphGetSoft("/me/accounts", token, { fields: "id", limit: 1 });
  if (!probe.ok && isPageTokenShapeError(probe.error)) {
    return savePageToken(token, meTry.data, label);
  }
  if (!probe.ok && probe.code === 190) throw new Error(probe.error || "Token hết hạn");
  const listed = await listPublishablePages(token);
  return saveUserToken(token, listed, label);
}

function saveUserToken(token, listed, label) {
  const db = getDb();
  const hash = tokenHash(token);
  const me = listed.me || {};
  const name = label || me.name || "User token";
  const existing = db.prepare(`SELECT id FROM accounts WHERE token_hash = ?`).get(hash);
  let accountId;
  if (existing) {
    accountId = existing.id;
    db.prepare(
      `UPDATE accounts SET name = ?, fb_user_id = ?, kind = 'user', token_enc = ?, status = 'active',
       last_error = NULL, updated_at = datetime('now') WHERE id = ?`
    ).run(name, String(me.id || ""), encryptToken(token), accountId);
  } else {
    const info = db.prepare(
      `INSERT INTO accounts (token_hash, name, fb_user_id, kind, token_enc, status)
       VALUES (?, ?, ?, 'user', ?, 'active')`
    ).run(hash, name, String(me.id || ""), encryptToken(token));
    accountId = info.lastInsertRowid;
  }
  const stored = upsertPages(accountId, listed.pages);
  const hint = stored.length
    ? (listed.skipped_no_token.length
      ? `${listed.skipped_no_token.length} page không có access_token nên bỏ qua.`
      : "")
    : "Không thấy page có token. System User cần được gán Page với quyền Content, và token có pages_show_list, pages_manage_posts, business_management.";
  if (!stored.length) {
    db.prepare(`UPDATE accounts SET last_error = ?, page_count = 0, updated_at = datetime('now') WHERE id = ?`)
      .run(hint, accountId);
  }
  return {
    ok: true,
    kind: "user",
    account_id: accountId,
    name,
    fb_id: me.id || null,
    page_count: stored.length,
    skipped_no_token: listed.skipped_no_token,
    hint: hint || null,
    mask: maskToken(token),
  };
}

function savePageToken(token, me, label) {
  const db = getDb();
  const hash = tokenHash(token);
  const name = label || me.name || `Page ${me.id}`;
  const existing = db.prepare(`SELECT id FROM accounts WHERE token_hash = ?`).get(hash);
  let accountId;
  if (existing) {
    accountId = existing.id;
    db.prepare(
      `UPDATE accounts SET name = ?, fb_user_id = ?, kind = 'page', token_enc = ?, status = 'active',
       last_error = NULL, updated_at = datetime('now') WHERE id = ?`
    ).run(name, String(me.id), encryptToken(token), accountId);
  } else {
    accountId = db.prepare(
      `INSERT INTO accounts (token_hash, name, fb_user_id, kind, token_enc, status)
       VALUES (?, ?, ?, 'page', ?, 'active')`
    ).run(hash, name, String(me.id), encryptToken(token)).lastInsertRowid;
  }
  upsertPages(accountId, [{
    id: String(me.id),
    name: me.name || name,
    category: "",
    access_token: token,
  }]);
  return {
    ok: true,
    kind: "page",
    account_id: accountId,
    name,
    fb_id: me.id,
    page_count: 1,
    skipped_no_token: [],
    hint: null,
    mask: maskToken(token),
  };
}

function upsertPages(accountId, pages) {
  const db = getDb();
  const upsert = db.prepare(`
    INSERT INTO pages (account_id, page_id, name, category, token_enc, status, updated_at)
    VALUES (@account_id, @page_id, @name, @category, @token_enc, 'active', datetime('now'))
    ON CONFLICT(account_id, page_id) DO UPDATE SET
      name = excluded.name,
      category = excluded.category,
      token_enc = excluded.token_enc,
      status = 'active',
      updated_at = datetime('now')
  `);
  const seen = new Set();
  const tx = db.transaction((list) => {
    for (const p of list) {
      if (!p?.id || !p.access_token) continue;
      seen.add(String(p.id));
      upsert.run({
        account_id: accountId,
        page_id: String(p.id),
        name: p.name || String(p.id),
        category: p.category || "",
        token_enc: encryptToken(p.access_token),
      });
    }
    const old = db.prepare(`SELECT page_id FROM pages WHERE account_id = ?`).all(accountId);
    for (const row of old) {
      if (!seen.has(String(row.page_id))) {
        db.prepare(`UPDATE pages SET status = 'missing', updated_at = datetime('now') WHERE account_id = ? AND page_id = ?`)
          .run(accountId, row.page_id);
      }
    }
    db.prepare(`UPDATE accounts SET page_count = ?, last_error = NULL, status = 'active', updated_at = datetime('now') WHERE id = ?`)
      .run(seen.size, accountId);
  });
  tx(pages || []);
  return db.prepare(`SELECT id, page_id, name FROM pages WHERE account_id = ? AND status = 'active'`).all(accountId);
}

export async function syncAccount(accountId) {
  const row = getDb().prepare(`SELECT * FROM accounts WHERE id = ? AND status != 'deleted'`).get(accountId);
  if (!row) throw new Error("Không thấy token");
  const token = decryptToken(row.token_enc);
  if (row.kind === "page") {
    const me = await graphGet("/me", token, { fields: "id,name" });
    return savePageToken(token, me, row.name);
  }
  const listed = await listPublishablePages(token);
  if (!listed.me && listed.errors.length) throw new Error(listed.errors[0]);
  return saveUserToken(token, listed, row.name);
}

export function deleteAccount(accountId) {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM pages WHERE account_id = ?`).run(accountId);
    db.prepare(`UPDATE accounts SET status = 'deleted', token_enc = '', updated_at = datetime('now') WHERE id = ?`).run(accountId);
  });
  tx();
}

export function setPageFolder(pageRowId, folder) {
  const value = String(folder || "").trim();
  const info = getDb().prepare(
    `UPDATE pages SET media_folder = ?, updated_at = datetime('now') WHERE id = ? AND status = 'active'`
  ).run(value, pageRowId);
  if (!info.changes) throw new Error("Không thấy page");
}
