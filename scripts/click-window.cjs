const { app, BrowserWindow } = require("electron");

const pageUrl = process.env.FB_DANGBAI_TEST_URL;

function fail(message) {
  console.error(message);
  app.exit(1);
}

const script = `(() => {
  async function waitUntil(pred, label, ms) {
    const start = Date.now();
    while (Date.now() - start < (ms || 20000)) {
      if (await pred()) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const toast = document.getElementById("toasts")?.textContent || "";
    const ask = document.getElementById("askBody")?.textContent || "";
    const current = document.getElementById("jobCurrent")?.textContent || "";
    let jobs = "";
    try { jobs = JSON.stringify(await fetch("/api/jobs").then((res) => res.json())); } catch (e) { jobs = e.message; }
    throw new Error(label + " | " + toast + " | " + ask + " | " + current + " | " + jobs);
  }
  return (async () => {
    await waitUntil(() => document.getElementById("lock").hidden && document.querySelector("#pages [data-page]"), "mo app");
    document.getElementById("btnNow").click();
    await waitUntil(() => document.getElementById("toasts").textContent.includes("Chưa chọn page"), "popup chua chon page");
    const boxes = [...document.querySelectorAll("#pages [data-page]")];
    if (boxes.length < 2) throw new Error("thieu page " + boxes.length);
    boxes[0].checked = true;
    boxes[0].dispatchEvent(new Event("change", { bubbles: true }));
    document.getElementById("postType").value = "text";
    document.getElementById("captionText").value = "Bai dang ngay";
    document.getElementById("useCaption").checked = true;
    document.getElementById("btnNow").click();
    await waitUntil(() => !document.getElementById("ask").hidden, "popup dang ngay");
    if (!document.getElementById("askTitle").textContent.includes("Đăng ngay")) throw new Error(document.getElementById("askTitle").textContent);
    document.getElementById("askYes").click();
    await waitUntil(async () => {
      const data = await fetch("/api/jobs").then((res) => res.json());
      const job = (data.jobs || []).find((item) => item.type === "now");
      return job && job.status === "done" && job.progress.percent === 100 && job.progress.ok === 1;
    }, "job dang ngay");
    document.getElementById("tabList").click();
    const live = [...document.querySelectorAll("#pages [data-page]")];
    if (live.length < 2) throw new Error("thieu page sau dang " + live.length);
    live[0].checked = false;
    live[0].dispatchEvent(new Event("change", { bubbles: true }));
    live[1].checked = true;
    live[1].dispatchEvent(new Event("change", { bubbles: true }));
    document.getElementById("listTimes").value = "";
    document.getElementById("btnSchedule").click();
    await waitUntil(() => document.getElementById("toasts").textContent.includes("mốc"), "popup thieu moc gio");
    const ahead = new Date(Date.now() + 2 * 60 * 60 * 1000 + 7 * 60 * 60 * 1000);
    document.getElementById("listTimes").value = ahead.toISOString().slice(0, 16);
    document.getElementById("captionText").value = "Bai hen gio";
    document.getElementById("btnSchedule").click();
    await waitUntil(() => !document.getElementById("ask").hidden && document.getElementById("askTitle").textContent.includes("Hẹn"), "popup hen gio");
    document.getElementById("askYes").click();
    await waitUntil(async () => {
      const data = await fetch("/api/jobs").then((res) => res.json());
      const job = (data.jobs || []).find((item) => item.type === "schedule");
      return job && job.status === "done" && job.progress.percent === 100 && job.progress.ok === 1;
    }, "job hen gio", 45000);
    await waitUntil(() => document.getElementById("jobPct").textContent === "100%", "thanh phan tram", 8000);
    return "click ok";
  })();
})()`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  try {
    await win.loadURL(pageUrl);
    const result = await win.webContents.executeJavaScript(script, true);
    if (result !== "click ok") fail(String(result));
    console.log("click ok");
    app.exit(0);
  } catch (e) {
    fail(e.stack || e.message);
  }
});
