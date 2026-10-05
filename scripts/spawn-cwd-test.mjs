import assert from "assert";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";

const exe = "C:\\Program Files\\FB Dang Bai Admin\\FB Dang Bai Admin.exe";
const asar = "C:\\Program Files\\FB Dang Bai Admin\\resources\\app.asar";
assert.equal(fs.existsSync(exe), true);
const script = path.join(asar, "admin", "server.js");

function run(cwd) {
  return new Promise((resolve) => {
    const child = spawn(exe, [script], {
      cwd,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        PORT: "0",
        HOST: "127.0.0.1",
      },
      windowsHide: true,
    });
    let message = "";
    child.on("error", (err) => {
      message = err.message;
    });
    child.on("spawn", () => {
      child.kill();
      resolve("spawned");
    });
    setTimeout(() => resolve(message || "timeout"), 2000);
  });
}

const broken = await run(asar);
assert.match(broken, /ENOENT/);
const ok = await run(path.dirname(exe));
assert.equal(ok, "spawned");
const adminMain = fs.readFileSync(new URL("../electron/admin-main.cjs", import.meta.url), "utf8");
const customerMain = fs.readFileSync(new URL("../electron/main.cjs", import.meta.url), "utf8");
assert.match(adminMain, /cwd: path\.dirname\(process\.execPath\)/);
assert.match(customerMain, /cwd: path\.dirname\(process\.execPath\)/);
assert.equal(adminMain.includes("cwd: root"), false);
assert.equal(customerMain.includes("cwd: root"), false);
console.log("spawn-cwd-test ok");
