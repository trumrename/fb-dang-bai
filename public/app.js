const $ = (id) => document.getElementById(id);
const selected = new Set(JSON.parse(localStorage.getItem("fbdangbai-pages") || "[]"));
let pages = [];
let accounts = [];
let tokenGroups = [];
let pageGroups = [];
const openTokens = new Set((() => {
  try {
    const saved = JSON.parse(localStorage.getItem("fbdangbai-open-tokens") || "[]");
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
})());
const filterClosed = new Set();

function flash(text, ok) {
  const el = $("flash");
  el.textContent = text || "";
  el.className = ok ? "ok" : "bad";
}

function toast(level, title, body) {
  const wrap = $("toasts");
  if (!wrap) return;
  const el = document.createElement("div");
  el.className = `toast ${level || ""}`;
  el.innerHTML = `<b>${escapeHtml(title)}</b><div>${escapeHtml(body || "")}</div>`;
  wrap.prepend(el);
  setTimeout(() => el.remove(), 14000);
}

function ask(title, body) {
  return new Promise((resolve) => {
    $("askTitle").textContent = title;
    $("askBody").textContent = body;
    $("ask").hidden = false;
    const yes = $("askYes");
    const no = $("askNo");
    const done = (ok) => {
      yes.removeEventListener("click", onYes);
      no.removeEventListener("click", onNo);
      $("ask").hidden = true;
      resolve(ok);
    };
    const onYes = () => done(true);
    const onNo = () => done(false);
    yes.addEventListener("click", onYes);
    no.addEventListener("click", onNo);
  });
}

async function api(url, options) {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Lỗi ${res.status}`);
  return data;
}

function saveSelected() {
  localStorage.setItem("fbdangbai-pages", JSON.stringify([...selected]));
}

function visibleAccounts() {
  const q = ($("tokenFilter")?.value || "").trim().toLowerCase();
  return accounts.filter((account) => !q || `${account.name || ""} ${account.kind || ""}`.toLowerCase().includes(q));
}

function renderAccounts() {
  const box = $("addToken");
  if (box && accounts.length && !box.dataset.touched) box.open = false;
  $("accounts").innerHTML = visibleAccounts().map((account) => `
    <div class="account">
      <div>
        <b>${escapeHtml(account.name || "Token")}</b>
        <div class="muted">${account.kind === "page" ? "Page token" : "User token"} · ${account.page_count || 0} page${account.last_error ? ` · ${escapeHtml(account.last_error)}` : ""}</div>
      </div>
      <div class="account-actions">
        <button class="pick" type="button" data-pick-token="${account.id}">Mọi page</button>
        <button class="ghost" type="button" data-sync="${account.id}">Lấy lại</button>
        <button class="ghost" type="button" data-del="${account.id}">Xóa</button>
      </div>
    </div>
  `).join("") || `<p class="note">${accounts.length ? "Không thấy token." : "Chưa có token."}</p>`;
}

function pageHay(page) {
  return `${page.name} ${page.page_id} ${page.account_name}`.toLowerCase();
}

function visiblePages() {
  const q = $("pageSearch").value.trim().toLowerCase();
  return pages.filter((page) => !q || pageHay(page).includes(q));
}

function pagesOfToken(accountId) {
  return pages.filter((page) => page.account_id === accountId);
}

function renderPages() {
  let dirty = false;
  for (const id of [...selected]) {
    if (!pages.some((page) => page.id === id)) {
      selected.delete(id);
      dirty = true;
    }
  }
  if (dirty) saveSelected();
  const list = visiblePages();
  const filtering = !!$("pageSearch").value.trim();
  const buckets = new Map();
  for (const page of list) {
    if (!buckets.has(page.account_id)) {
      buckets.set(page.account_id, { id: page.account_id, name: page.account_name || "Token", pages: [] });
    }
    buckets.get(page.account_id).pages.push(page);
  }
  $("pages").innerHTML = [...buckets.values()].map((bucket) => {
    const owned = pagesOfToken(bucket.id);
    const on = owned.filter((page) => selected.has(page.id)).length;
    const account = accounts.find((item) => item.id === bucket.id);
    const kind = account?.kind === "page" ? "Page token" : "User token";
    const open = filtering ? !filterClosed.has(bucket.id) : openTokens.has(bucket.id);
    const state = on === 0 ? "" : on === owned.length ? "is-on" : "is-part";
    return `
      <div class="token-card ${state} ${open ? "is-open" : ""}">
        <div class="token-bar">
          <input type="checkbox" data-token="${bucket.id}" aria-label="Chọn mọi page của token">
          <button class="token-fold" type="button" data-fold="${bucket.id}">
            <span class="chev">${open ? "Thu nhỏ" : "Mở"}</span>
            <span class="token-name">${escapeHtml(bucket.name)}</span>
            <span class="muted">${kind}</span>
            <span class="pick-badge">${on}/${owned.length}</span>
          </button>
        </div>
        <div class="token-pages">
          ${bucket.pages.map((page) => `
            <div class="page">
              <label class="check">
                <input type="checkbox" data-page="${page.id}" ${selected.has(page.id) ? "checked" : ""}>
                <span><b>${escapeHtml(page.name || page.page_id)}</b><br><span class="muted">${escapeHtml(page.page_id)}${page.media_folder ? " · thư mục riêng" : ""}</span></span>
              </label>
            </div>
          `).join("")}
        </div>
      </div>
    `;
  }).join("") || `<p class="note">Không có page.</p>`;
  for (const box of $("pages").querySelectorAll("[data-token]")) {
    const owned = pagesOfToken(Number(box.dataset.token));
    const on = owned.filter((page) => selected.has(page.id)).length;
    box.checked = owned.length > 0 && on === owned.length;
    box.indeterminate = on > 0 && on < owned.length;
  }
  const count = $("pickCount");
  if (count) count.textContent = selected.size ? `Đang chọn ${selected.size} page.` : "Chưa chọn page.";
}

function renderGroupChips(target, list, useAttr) {
  const el = $(target);
  if (!el) return;
  el.innerHTML = (list || []).map((group) => `
    <span style="display:inline-flex;gap:4px;align-items:center">
      <button class="ghost" type="button" ${useAttr}="${escapeAttr(group.id)}">${escapeHtml(group.name)} · ${group.page_count || 0} page</button>
      <button class="ghost" type="button" data-del-group="${escapeAttr(group.id)}" title="Xóa nhóm">×</button>
    </span>
  `).join("") || `<span class="note">Chưa có nhóm.</span>`;
}

function renderGroups() {
  renderGroupChips("tokenGroups", tokenGroups, "data-use-token-group");
  renderGroupChips("pageGroups", pageGroups, "data-use-page-group");
}

function rememberPick() {
  saveSelected();
  renderPages();
}

function toggleToken(accountId, onlyVisible) {
  const source = onlyVisible ? visiblePages() : pages;
  const ids = source.filter((page) => page.account_id === accountId).map((page) => page.id);
  if (!ids.length) {
    flash("Token này chưa có page");
    return;
  }
  const allOn = ids.every((id) => selected.has(id));
  for (const id of ids) {
    if (allOn) selected.delete(id);
    else selected.add(id);
  }
  rememberPick();
  const name = accounts.find((account) => account.id === accountId)?.name || pages.find((page) => page.account_id === accountId)?.account_name || "token";
  flash(allOn ? `Đã bỏ page của ${name}.` : `Đã chọn ${ids.length} page của ${name}.`, true);
}

function selectPages(list, label) {
  for (const page of list) selected.add(page.id);
  rememberPick();
  flash(`${label}: ${selected.size} page.`, true);
}

function replaceSelection(ids, label) {
  const live = ids.filter((id) => pages.some((page) => page.id === id));
  selected.clear();
  for (const id of live) selected.add(id);
  rememberPick();
  flash(`Đã chọn ${label}: ${selected.size} page.`, true);
}

function statusLabel(status) {
  return {
    running: "Đang chạy",
    paused: "Tạm dừng",
    queued: "Đang chờ",
    done: "Xong",
    stopped: "Đã dừng",
    fail: "Lỗi",
    failed: "Lỗi",
    ok: "Đã đăng",
    pending: "Chờ",
    skipped: "Bỏ",
    scheduled: "Đã hẹn",
    unknown: "Chưa rõ",
    now: "Đăng ngay",
    schedule: "Hẹn giờ",
    direct: "Trực tiếp",
    sent: "Đã gửi",
  }[status] || status || "";
}

function urlIn(text) {
  const match = String(text || "").match(/https?:\/\/[^\s<>"']+/);
  return match ? match[0].replace(/[)\].,;]+$/g, "") : "";
}

function withoutUrl(text) {
  return String(text || "")
    .replace(/https?:\/\/[^\s<>"']+/g, "")
    .replace(/(?:\s*·\s*){2,}/g, " · ")
    .replace(/^[\s·]+|[\s·]+$/g, "")
    .trim();
}

function linkActions(url) {
  const clean = String(url || "").trim();
  if (!clean) return "";
  const safe = escapeAttr(clean);
  return `<div class="link-row">
    <a href="${safe}" target="_blank" rel="noreferrer">${escapeHtml(clean)}</a>
    <button class="ghost" type="button" data-copy="${safe}">Copy</button>
    <button class="ghost" type="button" data-open="${safe}">Mở</button>
  </div>`;
}

function jobButtons(job) {
  const running = job.status === "running" || job.status === "queued";
  if (running) {
    return `<div class="job-actions">
      <button class="ghost" type="button" data-pause="${job.id}">Tạm dừng</button>
      <button class="ghost" type="button" data-stop="${job.id}">Dừng</button>
    </div>`;
  }
  if (job.status === "paused") {
    return `<div class="job-actions">
      <button class="ghost" type="button" data-resume="${job.id}">Tiếp tục</button>
      <button class="ghost" type="button" data-stop="${job.id}">Dừng</button>
    </div>`;
  }
  return "";
}

function renderJobs(jobs) {
  const list = jobs || [];
  const live = list.find((job) => job.status === "running" || job.status === "paused") || list[0];
  const p = live?.progress || {};
  const percent = Number(p.percent) || 0;
  const pct = $("jobPct");
  const bar = $("jobBar");
  const fill = $("jobBarFill");
  const current = $("jobCurrent");
  if (pct) pct.textContent = `${percent}%`;
  if (fill) fill.style.width = `${percent}%`;
  if (bar) {
    const failed = (p.fail || 0) > 0;
    const finished = live && !["running", "paused", "queued"].includes(live.status);
    bar.className = `progress-big${finished && !failed ? " ok" : failed ? " fail" : ""}`;
  }
  if (current) {
    const running = (live?.tasks || []).find((task) => task.status === "running");
    const detail = running ? withoutUrl(`${running.page_name || ""}: ${running.message || ""}`) : "";
    current.textContent = live
      ? `${live.title || live.type} · ${statusLabel(live.status)} · ${percent}% · OK ${p.ok || 0} · lỗi ${p.fail || 0} · chờ ${p.pending || 0}${detail ? ` · ${detail}` : ""}`
      : "Chưa chạy.";
  }
  $("jobs").innerHTML = list.map((job) => {
    const progress = job.progress || {};
    const width = Number(progress.percent) || 0;
    const tasks = (job.tasks || []).slice(0, 8).map((task) => {
      const url = task.post_url || urlIn(task.message);
      const tone = task.status === "fail" ? "bad" : task.status === "ok" ? "ok" : "muted";
      const text = withoutUrl(task.message || statusLabel(task.status));
      return `<div class="${tone}">${escapeHtml(task.page_name || "")}${text ? `: ${escapeHtml(text)}` : ""}</div>${linkActions(url)}`;
    }).join("");
    return `
      <div class="job">
        <b>${escapeHtml(job.title || job.type)}</b>
        <div class="muted">${width}% · ${escapeHtml(statusLabel(job.status))} · OK ${progress.ok || 0} · lỗi ${progress.fail || 0} · chờ ${progress.pending || 0} · bỏ ${progress.skipped || 0}</div>
        <div class="mini-bar"><i style="width:${width}%"></i></div>
        ${tasks}
        ${jobButtons(job)}
      </div>
    `;
  }).join("") || `<p class="note">Chưa có job.</p>`;
}

function renderLogs(logs) {
  $("logs").innerHTML = (logs || []).slice(0, 30).map((row) => `
    <div class="log">
      <b>${escapeHtml(row.page_name || "")}</b>
      <span class="muted"> ${escapeHtml(statusLabel(row.delivery || ""))} · ${escapeHtml(statusLabel(row.status || ""))}${row.when ? ` · ${escapeHtml(row.when)}` : ""}</span>
      ${linkActions(row.post_url)}
      ${[row.comment_status ? statusLabel(row.comment_status) : "", row.error || ""].filter(Boolean).map((bit) => `<div class="muted">${escapeHtml(bit)}</div>`).join("")}
    </div>
  `).join("") || `<p class="note">Chưa có bài.</p>`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}
function escapeAttr(value) {
  return escapeHtml(value);
}

function activeTab() {
  return document.querySelector(".tab.is-on")?.dataset.tab || "modeNow";
}

function showTab(id) {
  const name = ["modeNow", "modeList", "modeDays", "modeDirect"].includes(id) ? id : "modeNow";
  localStorage.setItem("fbdangbai-tab", name);
  for (const button of document.querySelectorAll("[data-tab]")) {
    const on = button.dataset.tab === name;
    button.classList.toggle("is-on", on);
    button.setAttribute("aria-selected", on ? "true" : "false");
    const panel = $(button.dataset.tab);
    if (panel) panel.hidden = !on;
  }
}

function lineCount(value) {
  return String(value || "").split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#")).length;
}

function paintHints() {
  const lines = lineCount($("listTimes").value);
  $("listHint").textContent = lines
    ? `${lines} mốc mỗi page. 0 cooldown = đúng giờ đã viết.`
    : "0 = đúng giờ đã viết. Lớn hơn 0 = bài sau cùng page cách bài trước ít nhất khoảng đó.";
  const days = Number($("daysCount").value) || 0;
  const per = Number($("perDay").value) || 0;
  $("daysHint").textContent = days && per
    ? `${days} ngày × ${per} bài = ${days * per} bài mỗi page. Ngày sau lặp cùng giờ, rồi cộng khoảng cách.`
    : "Điền số ngày và số bài mỗi ngày.";
}

function formBody(delivery, scheduleMode) {
  const tab = activeTab();
  const count = tab === "modeDirect" ? $("directCount").value : $("nowCount").value;
  const start = scheduleMode === "days" ? $("daysStart").value : $("directStart").value;
  return {
    page_ids: [...selected],
    delivery,
    schedule_mode: scheduleMode,
    media_folder: $("mediaFolder").value.trim(),
    posted_folder: $("postedFolder").value.trim(),
    caption_file: $("captionFile").value.trim(),
    caption_text: $("captionText").value,
    caption_mode: $("captionMode").value,
    comment_file: $("commentFile").value.trim(),
    post_type: $("postType").value,
    use_caption: $("useCaption").checked,
    lead_enabled: $("leadOn").checked,
    lead_mode: $("leadMode").value,
    lead_templates: $("leadTemplates").value,
    lead_links: $("leadLinks").value,
    title_enabled: $("titleOn").checked,
    title_file: $("titleFile").value.trim(),
    title_text: $("titleText").value,
    title_mode: $("titleMode").value,
    comment_enabled: $("commentOn").checked,
    comment_mode: $("commentMode").value,
    comment_text: $("commentText").value,
    comment_links: $("commentLinks").value,
    comment_per_day: $("commentPerDay").value,
    comment_when: $("commentWhen").value,
    comment_delay_minutes: tab === "modeDirect" ? $("directDelay").value : "0",
    repeat_media: $("repeatMedia").checked,
    count,
    now_count: $("nowCount").value,
    interval_minutes: $("directInterval").value,
    start,
    list_date: $("listDate").value,
    list_times: $("listTimes").value,
    list_cd_min: $("listCdMin").value,
    list_cd_max: $("listCdMax").value,
    days_start: $("daysStart").value,
    days: $("daysCount").value,
    per_day: $("perDay").value,
    gap_min: $("gapMin").value,
    gap_max: $("gapMax").value,
    direct_start: $("directStart").value,
    direct_count: $("directCount").value,
    direct_interval: $("directInterval").value,
  };
}

function paintHeader(license) {
  const version = $("version").dataset.version || "";
  const label = version ? `v${version}` : "";
  document.title = version ? `FB Đăng Bài ${version}` : "FB Đăng Bài";
  for (const id of ["appVer", "lockVer"]) {
    const el = $(id);
    if (el) el.textContent = label;
  }
  const bits = [];
  if (label) bits.push(label);
  if (license?.ok && license.name) bits.push(license.name);
  if (license?.ok && license.exp_vn) bits.push(`hạn ${license.exp_vn}`);
  $("version").textContent = bits.join(" · ");
}

function showLock(locked, license) {
  $("lock").hidden = !locked;
  const main = document.querySelector("main");
  if (main) main.inert = !!locked;
  if (license?.machine) $("machine").value = license.machine;
  const messages = {
    expired: "Key đã hết hạn.",
    machine: "Key không đúng máy này.",
    clock: "Giờ máy bị lùi. Chỉnh lại giờ rồi mở app.",
    bad: "Key không hợp lệ.",
  };
  $("lockMsg").textContent = locked ? (messages[license?.reason] || "") : "";
}

function renderUpdate(state) {
  const line = $("updateLine");
  const box = $("updateBox");
  const button = $("btnUpdate");
  if (!line || !box || !button) return;
  const phase = state && state.phase ? state.phase : "idle";
  const version = state && state.version ? state.version : "";
  if (phase === "downloading") {
    box.hidden = false;
    button.hidden = true;
    line.textContent = version ? `Đang tải bản ${version}.` : "Đang tải bản mới.";
    return;
  }
  if (phase === "ready") {
    box.hidden = false;
    button.hidden = false;
    if (!button.disabled) button.textContent = version ? `Cập nhật ${version}` : "Cập nhật";
    line.textContent = "Có bản mới.";
    return;
  }
  if (phase === "applying") {
    box.hidden = false;
    button.hidden = true;
    line.textContent = version ? `Đang cài bản ${version}.` : "Đang cài bản mới.";
    return;
  }
  box.hidden = true;
  button.hidden = true;
  line.textContent = "";
}

$("btnUpdate").addEventListener("click", async () => {
  const button = $("btnUpdate");
  button.disabled = true;
  try {
    const result = window.fbDangBai && window.fbDangBai.applyUpdate
      ? await window.fbDangBai.applyUpdate()
      : await api("/api/update/apply", { method: "POST", body: "{}" });
    if (result && result.error) {
      flash(result.error);
      button.disabled = false;
      return;
    }
    flash("Đang cài bản mới. App sẽ mở lại.", true);
  } catch (err) {
    flash(err.message || "Chưa cập nhật được.");
    button.disabled = false;
  }
});

function setValue(id, value) {
  const el = $(id);
  if (el && value != null) el.value = value;
}

function applySettings(settings) {
  if (!settings) return;
  setValue("mediaFolder", settings.media_folder || "");
  setValue("postedFolder", settings.posted_folder || "");
  setValue("captionFile", settings.caption_file || "");
  setValue("captionText", settings.caption_text || "");
  setValue("captionMode", settings.caption_mode || "sequential");
  setValue("commentFile", settings.comment_file || "");
  setValue("postType", settings.post_type || "video");
  setValue("leadMode", settings.lead_mode || "sequential");
  setValue("leadTemplates", settings.lead_templates || "");
  setValue("leadLinks", settings.lead_links || "");
  setValue("titleFile", settings.title_file || "");
  setValue("titleText", settings.title_text || "");
  setValue("titleMode", settings.title_mode || "sequential");
  setValue("commentMode", settings.comment_mode || "sequential");
  setValue("commentText", settings.comment_text || "");
  setValue("commentLinks", settings.comment_links || "");
  setValue("commentPerDay", settings.comment_per_day ?? 0);
  setValue("commentWhen", settings.comment_when || "immediate");
  setValue("nowCount", settings.now_count || settings.count || 1);
  setValue("listDate", settings.list_date || "");
  setValue("listTimes", settings.list_times || "");
  setValue("listCdMin", settings.list_cd_min ?? 0);
  setValue("listCdMax", settings.list_cd_max ?? 0);
  setValue("daysStart", settings.days_start || "");
  setValue("daysCount", settings.days ?? "");
  setValue("perDay", settings.per_day ?? "");
  setValue("gapMin", settings.gap_min ?? 60);
  setValue("gapMax", settings.gap_max ?? 60);
  setValue("directStart", settings.direct_start || "");
  setValue("directCount", settings.direct_count || settings.count || 1);
  setValue("directInterval", settings.direct_interval || settings.interval_minutes || 60);
  setValue("directDelay", settings.comment_delay_minutes ?? 0);
  $("useCaption").checked = settings.use_caption !== false;
  $("leadOn").checked = !!settings.lead_enabled;
  $("titleOn").checked = !!settings.title_enabled;
  $("commentOn").checked = !!settings.comment_enabled;
  $("repeatMedia").checked = !!settings.repeat_media;
  paintHints();
}

async function refresh() {
  const [accountData, pageData, jobData, logData, groupData] = await Promise.all([
    api("/api/accounts"),
    api("/api/pages"),
    api("/api/jobs"),
    api("/api/logs"),
    api("/api/groups"),
  ]);
  accounts = accountData.accounts || [];
  pages = pageData.pages || [];
  tokenGroups = groupData.token_groups || [];
  pageGroups = groupData.page_groups || [];
  for (const id of [...selected]) {
    if (!pages.some((page) => page.id === id)) selected.delete(id);
  }
  renderAccounts();
  renderPages();
  renderGroups();
  renderJobs(jobData.jobs);
  renderLogs(logData.logs);
}

function initialDirOf(value, kind) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (kind === "folder") return text;
  const slash = Math.max(text.lastIndexOf("\\"), text.lastIndexOf("/"));
  if (slash <= 0) return "";
  return text.slice(0, slash);
}

async function pickInto(kind, title, id) {
  const initialDir = initialDirOf($(id).value, kind);
  try {
    const desktop = window.fbDangBai;
    const data = desktop
      ? await (kind === "folder"
        ? desktop.pickFolder({ title, initialDir })
        : desktop.pickFile({ title, initialDir }))
      : await api(kind === "folder" ? "/api/pick-folder" : "/api/pick-file", {
        method: "POST",
        body: JSON.stringify({ title, initial_dir: initialDir }),
      });
    if (!data.path || data.cancelled) {
      flash(kind === "folder" ? "Đã hủy chọn folder" : "Đã hủy chọn file", true);
      return;
    }
    $(id).value = data.path;
    flash(`Đã chọn: ${data.path}`, true);
    await flushSettings();
  } catch (e) {
    flash(e.message);
    toast("bad", "Chưa chọn được", e.message);
  }
}

async function start(delivery, scheduleMode, label) {
  if (!$("ask").hidden) return;
  const body = formBody(delivery, scheduleMode);
  if (!body.page_ids.length) {
    flash("Chọn page trước");
    toast("warn", "Chưa chọn page", "Tick page hoặc bấm Mọi page trên user token.");
    return;
  }
  let preview;
  try {
    const dataPreview = await api("/api/jobs/preview", { method: "POST", body: JSON.stringify(body) });
    preview = dataPreview.preview || {};
  } catch (e) {
    flash(e.message);
    toast("bad", "Chưa chạy", e.message);
    return;
  }
  const when = preview.first ? `\n${preview.first}${preview.last && preview.last !== preview.first ? ` → ${preview.last}` : ""}` : "";
  const sample = preview.random
    ? "\n\nMở đầu, link và tiêu đề lấy random khi chạy."
    : (preview.sample ? `\n\nTiêu đề bài đầu:\n${preview.sample}` : "");
  const ok = await ask(
    label,
    `${preview.pages || body.page_ids.length} page · ${preview.per_page || "?"} bài mỗi page${when}${sample}\n\nBấm Chạy để gửi Facebook. Cùng một token cách nhau 30 giây.`
  );
  if (!ok) {
    toast("warn", "Đã hủy", "Chưa gửi lên Facebook.");
    return;
  }
  const data = await api(`/api/jobs/${delivery}`, { method: "POST", body: JSON.stringify(body) });
  const title = data.job?.title || data.job?.id || "";
  flash(`Đã bắt đầu. ${title}`, true);
  toast("ok", "Đã bắt đầu", title || "Job đang chạy. Xem % ở khối Tiến trình.");
  await refresh();
}

document.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  try {
    if (button.dataset.tab) {
      showTab(button.dataset.tab);
      return;
    }
    if (button.id === "btnActivate") {
      const data = await api("/api/license/activate", {
        method: "POST",
        body: JSON.stringify({ key: $("keyBox").value }),
      });
      $("keyBox").value = "";
      showLock(false, data);
      paintHeader(data);
      await loadSettings();
      await refresh();
      flash(`Đã kích hoạt cho ${data.name}. Hạn ${data.exp_vn}.`, true);
      return;
    }
    if (button.id === "btnImport") {
      const data = await api("/api/accounts/import", {
        method: "POST",
        body: JSON.stringify({ token: $("tokenBox").value, name: $("tokenName").value }),
      });
      const bad = (data.results || []).filter((item) => !item.ok);
      const good = (data.results || []).filter((item) => item.ok);
      accounts = data.accounts || [];
      pages = data.pages || [];
      renderAccounts();
      renderPages();
      $("tokenBox").value = "";
      flash(bad.length ? bad.map((item) => item.error).join(" ") : `Đã thêm ${good.length} token.`, !bad.length);
      return;
    }
    if (button.dataset.sync) {
      const data = await api(`/api/accounts/${button.dataset.sync}/sync`, { method: "POST", body: "{}" });
      accounts = data.accounts || accounts;
      pages = data.pages || pages;
      renderAccounts();
      renderPages();
      flash(data.result?.hint || `Đã lấy ${data.result?.page_count || 0} page.`, !data.result?.hint);
      return;
    }
    if (button.dataset.del) {
      if (!confirm("Xóa token này và các page của nó?")) return;
      const data = await api(`/api/accounts/${button.dataset.del}`, { method: "DELETE", body: "{}" });
      accounts = data.accounts || [];
      pages = data.pages || [];
      renderAccounts();
      renderPages();
      return;
    }
    if (button.dataset.fold) {
      const id = Number(button.dataset.fold);
      if ($("pageSearch").value.trim()) {
        if (filterClosed.has(id)) filterClosed.delete(id);
        else filterClosed.add(id);
      } else if (openTokens.has(id)) openTokens.delete(id);
      else openTokens.add(id);
      localStorage.setItem("fbdangbai-open-tokens", JSON.stringify([...openTokens]));
      renderPages();
      return;
    }
    if (button.dataset.pickToken) {
      toggleToken(Number(button.dataset.pickToken), false);
      return;
    }
    if (button.id === "btnEvery") return selectPages(pages, "Chọn tất cả");
    if (button.id === "btnAll") return selectPages(visiblePages(), "Chọn đang lọc");
    if (button.id === "btnNone") {
      selected.clear();
      rememberPick();
      flash("Đã bỏ chọn.", true);
      return;
    }
    if (button.dataset.useTokenGroup) {
      const group = tokenGroups.find((item) => item.id === button.dataset.useTokenGroup);
      if (!group) return;
      const ids = pages.filter((page) => (group.account_ids || []).includes(page.account_id)).map((page) => page.id);
      replaceSelection(ids, `nhóm token ${group.name}`);
      return;
    }
    if (button.dataset.usePageGroup) {
      const group = pageGroups.find((item) => item.id === button.dataset.usePageGroup);
      if (!group) return;
      replaceSelection(group.page_ids || [], `nhóm page ${group.name}`);
      return;
    }
    if (button.dataset.delGroup) {
      if (!confirm("Xóa nhóm này?")) return;
      const data = await api(`/api/groups/${encodeURIComponent(button.dataset.delGroup)}`, { method: "DELETE" });
      tokenGroups = data.token_groups || [];
      pageGroups = data.page_groups || [];
      renderGroups();
      flash("Đã xóa nhóm.", true);
      return;
    }
    if (button.id === "btnSaveTokenGroup" || button.id === "btnSavePageGroup") {
      const kind = button.id === "btnSaveTokenGroup" ? "token" : "page";
      const input = $(kind === "token" ? "tokenGroupName" : "pageGroupName");
      const name = input.value.trim();
      if (!name) return flash("Nhập tên nhóm");
      if (!selected.size) return flash("Chọn page trước");
      const body = { kind, name };
      if (kind === "token") {
        body.account_ids = [...new Set(pages.filter((page) => selected.has(page.id)).map((page) => page.account_id))];
      } else body.page_ids = [...selected];
      const data = await api("/api/groups", { method: "POST", body: JSON.stringify(body) });
      tokenGroups = data.token_groups || [];
      pageGroups = data.page_groups || [];
      input.value = "";
      renderGroups();
      flash(kind === "token"
        ? `Đã lưu nhóm token ${name}. Bấm nhóm sẽ chọn mọi page của các token đó.`
        : `Đã lưu nhóm page ${name}.`, true);
      return;
    }
    if (button.id === "btnFolder") return pickInto("folder", "Chọn thư mục media", "mediaFolder");
    if (button.id === "btnPosted") return pickInto("folder", "Chọn folder sau khi đăng", "postedFolder");
    if (button.id === "btnCaption") return pickInto("file", "Chọn file tiêu đề", "captionFile");
    if (button.id === "btnTitle") return pickInto("file", "Chọn file title video", "titleFile");
    if (button.id === "btnComment") return pickInto("file", "Chọn file comment", "commentFile");
    if (button.id === "btnNow") {
      await start("now", "interval", "Đăng ngay API");
      return;
    }
    if (button.id === "btnSchedule") {
      await start("schedule", "list", "Hẹn giờ hàng loạt trên Facebook");
      return;
    }
    if (button.id === "btnDays") {
      await start("schedule", "days", "Hẹn theo ngày trên Facebook");
      return;
    }
    if (button.id === "btnDirect") {
      await start("direct", "interval", "Đăng trực tiếp — app phải mở đến khi xong");
      return;
    }
    if (button.id === "btnComments") {
      const data = await api("/api/comments/send-pending", { method: "POST", body: "{}" });
      flash(`Đang gửi comment chờ · job ${data.job?.id || ""}`, true);
      await refresh();
      return;
    }
    if (button.dataset.copy) {
      const url = button.dataset.copy;
      try {
        await navigator.clipboard.writeText(url);
        flash("Đã copy link.", true);
      } catch {
        flash("Chưa copy được link.");
      }
      return;
    }
    if (button.dataset.open) {
      const url = button.dataset.open;
      if (window.fbDangBai?.openExternal) await window.fbDangBai.openExternal(url);
      else window.open(url, "_blank", "noopener");
      return;
    }
    if (button.dataset.pause) {
      await api(`/api/jobs/${button.dataset.pause}/pause`, { method: "POST", body: "{}" });
      await refresh();
      return;
    }
    if (button.dataset.resume) {
      await api(`/api/jobs/${button.dataset.resume}/resume`, { method: "POST", body: "{}" });
      await refresh();
      return;
    }
    if (button.dataset.stop) {
      await api(`/api/jobs/${button.dataset.stop}/stop`, { method: "POST", body: "{}" });
      await refresh();
    }
  } catch (e) {
    flash(e.message);
    toast("bad", "Lỗi", e.message);
    if (!$("lock").hidden) $("lockMsg").textContent = e.message;
  }
});

$("pages").addEventListener("change", (event) => {
  const input = event.target;
  if (input.dataset.token) {
    toggleToken(Number(input.dataset.token), false);
    return;
  }
  if (!input.dataset.page) return;
  const id = Number(input.dataset.page);
  if (input.checked) selected.add(id);
  else selected.delete(id);
  saveSelected();
  const card = input.closest(".token-card");
  const tokenBox = card?.querySelector("[data-token]");
  if (tokenBox) {
    const owned = pagesOfToken(Number(tokenBox.dataset.token));
    const on = owned.filter((page) => selected.has(page.id)).length;
    tokenBox.checked = owned.length > 0 && on === owned.length;
    tokenBox.indeterminate = on > 0 && on < owned.length;
    const badge = card.querySelector(".pick-badge");
    if (badge) badge.textContent = `${on}/${owned.length}`;
    card.classList.toggle("is-on", owned.length > 0 && on === owned.length);
    card.classList.toggle("is-part", on > 0 && on < owned.length);
  }
  $("pickCount").textContent = selected.size ? `Đang chọn ${selected.size} page.` : "Chưa chọn page.";
});

$("pageSearch").addEventListener("input", () => {
  filterClosed.clear();
  renderPages();
});
$("tokenFilter").addEventListener("input", renderAccounts);
$("addToken").addEventListener("toggle", () => {
  $("addToken").dataset.touched = "1";
});
for (const id of ["listTimes", "daysCount", "perDay"]) $(id).addEventListener("input", paintHints);

let settingsReady = false;
let saveTimer = null;
const skipSaveIds = new Set([
  "tokenBox", "tokenName", "tokenFilter", "pageSearch", "keyBox", "tokenGroupName", "pageGroupName",
]);

function queueSettingsSave(delay = 400) {
  if (!settingsReady) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    flushSettings().catch(() => {});
  }, delay);
}

async function flushSettings(keepalive = false) {
  if (!settingsReady) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  const body = JSON.stringify(formBody("now", "interval"));
  try {
    if (keepalive) {
      fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: true,
      }).catch(() => {});
      return;
    }
    await api("/api/settings", { method: "POST", body });
  } catch {
    /* Tự lưu im lặng. Job vẫn ghi lại lúc bấm đăng. */
  }
}

async function loadSettings() {
  settingsReady = false;
  applySettings(await api("/api/settings"));
  settingsReady = true;
}

function bindSettingsSave() {
  const root = document.querySelector("main");
  if (!root) return;
  const onEdit = (event) => {
    const el = event.target;
    if (!el || !el.matches || !el.matches("input, textarea, select")) return;
    if (skipSaveIds.has(el.id)) return;
    queueSettingsSave(el.tagName === "SELECT" || el.type === "checkbox" ? 150 : 400);
  };
  root.addEventListener("input", onEdit);
  root.addEventListener("change", onEdit);
  const leave = () => {
    flushSettings(true);
  };
  window.addEventListener("pagehide", leave);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") leave();
  });
}

bindSettingsSave();

async function boot() {
  showTab(localStorage.getItem("fbdangbai-tab") || "modeNow");
  paintHints();
  try {
    const health = await api("/api/health");
    $("version").dataset.version = health.version;
    const license = await api("/api/license");
    paintHeader(license);
    showLock(!license.ok, license);
    renderUpdate(await api("/api/update"));
    if (license.ok) {
      await loadSettings();
      await refresh();
    }
  } catch (e) {
    flash(e.message);
  }
  setInterval(() => {
    if (!$("lock").hidden) {
      api("/api/update").then(renderUpdate).catch(() => {});
      return;
    }
    Promise.all([api("/api/jobs"), api("/api/logs"), api("/api/update")])
      .then(([jobData, logData, update]) => {
        renderJobs(jobData.jobs);
        renderLogs(logData.logs);
        renderUpdate(update);
      })
      .catch(async () => {
        try {
          const license = await api("/api/license");
          if (!license.ok) showLock(true, license);
        } catch {
          /* server restarted */
        }
      });
  }, 2000);
}

boot();
