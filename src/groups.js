import crypto from "crypto";
import { getDb } from "./db.js";

function parseIds(raw) {
  try {
    const data = JSON.parse(raw || "[]");
    if (!Array.isArray(data)) return [];
    return [...new Set(data.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
  } catch {
    return [];
  }
}

function activePages() {
  return getDb().prepare(
    `SELECT p.id, p.account_id
     FROM pages p
     JOIN accounts a ON a.id = p.account_id
     WHERE p.status = 'active' AND a.status != 'deleted'`
  ).all();
}

export function listPickGroups() {
  const pages = activePages();
  const tokenGroups = [];
  const pageGroups = [];
  const rows = getDb().prepare(
    `SELECT id, kind, name, members_json FROM pick_groups ORDER BY name COLLATE NOCASE, id`
  ).all();
  for (const row of rows) {
    const members = parseIds(row.members_json);
    if (row.kind === "token") {
      const accounts = new Set(members);
      tokenGroups.push({
        id: row.id,
        name: row.name,
        account_ids: members,
        page_count: pages.filter((page) => accounts.has(page.account_id)).length,
      });
    } else if (row.kind === "page") {
      const ids = new Set(members);
      pageGroups.push({
        id: row.id,
        name: row.name,
        page_ids: members,
        page_count: pages.filter((page) => ids.has(page.id)).length,
      });
    }
  }
  return { token_groups: tokenGroups, page_groups: pageGroups };
}

export function createPickGroup(input) {
  const kind = input?.kind === "token" || input?.kind === "page" ? input.kind : "";
  if (!kind) throw new Error("Chọn nhóm token hoặc nhóm page");
  const name = String(input.name || "").trim();
  if (!name) throw new Error("Nhập tên nhóm");
  if (name.length > 80) throw new Error("Tên nhóm tối đa 80 ký tự");
  const source = kind === "token" ? input.account_ids : input.page_ids;
  const members = [...new Set((source || []).map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
  if (!members.length) throw new Error(kind === "token" ? "Chọn ít nhất một token" : "Chọn ít nhất một page");
  if (members.length > 5000) throw new Error("Nhóm quá lớn");
  const count = getDb().prepare(`SELECT COUNT(*) AS n FROM pick_groups`).get().n;
  if (count >= 100) throw new Error("Tối đa 100 nhóm");
  const id = crypto.randomBytes(6).toString("base64url");
  getDb().prepare(`INSERT INTO pick_groups (id, kind, name, members_json) VALUES (?, ?, ?, ?)`)
    .run(id, kind, name, JSON.stringify(members));
  return listPickGroups();
}

export function deletePickGroup(id) {
  const info = getDb().prepare(`DELETE FROM pick_groups WHERE id = ?`).run(String(id || ""));
  if (!info.changes) throw new Error("Không thấy nhóm");
  return listPickGroups();
}
