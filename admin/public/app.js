const $ = (id) => document.getElementById(id);

function show(text, ok) {
  const el = $("msg");
  el.textContent = text || "";
  el.className = ok ? "ok" : "bad";
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

function renderIssued(rows) {
  $("issued").innerHTML = (rows || []).map((row) => `
    <div class="item">
      <b>${escapeHtml(row.name || "")}</b>
      <div class="note">${escapeHtml(row.machine || "")} · hạn ${escapeHtml(row.exp_vn || "")}</div>
      <div>${escapeHtml(row.key || "")}</div>
    </div>
  `).join("") || `<p class="note">Chưa có.</p>`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

async function loadIssued() {
  const data = await api("/api/issued");
  renderIssued(data.issued);
}

$("make").addEventListener("click", async () => {
  try {
    const until = $("until").value;
    const data = await api("/api/key", {
      method: "POST",
      body: JSON.stringify({
        name: $("name").value,
        machine: $("machine").value,
        days: until ? "" : $("days").value,
        until,
      }),
    });
    $("key").value = data.key;
    show(`Đã tạo key cho ${data.name}. Hạn ${data.exp_vn}.`, true);
    await loadIssued();
  } catch (e) {
    show(e.message, false);
  }
});

$("copy").addEventListener("click", async () => {
  const key = $("key").value.trim();
  if (!key) return show("Chưa có key để copy", false);
  try {
    await navigator.clipboard.writeText(key);
  } catch {
    $("key").focus();
    $("key").select();
  }
  show("Đã copy key.", true);
});

loadIssued().catch((e) => show(e.message, false));
