import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { signLicense } from "../src/license.js";
import { vnEndOfDayUnix } from "../src/time.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0 || !process.argv[index + 1] || process.argv[index + 1].startsWith("--")) return "";
  return process.argv[index + 1];
}

const name = arg("name");
const machine = arg("machine").toUpperCase();
const daysText = arg("days");
const until = arg("until");

if (!name || !machine || (!daysText && !until) || (daysText && until)) {
  console.error("Dùng: node scripts/make-key.mjs --name TEN --machine XXXX-XXXX-XXXX-XXXX --days 30");
  console.error("   hoặc --until YYYY-MM-DD (hết 23:59:59 giờ Việt Nam ngày đó)");
  process.exit(1);
}

let exp;
if (until) {
  exp = vnEndOfDayUnix(until);
} else {
  const days = Number(daysText);
  if (!Number.isInteger(days) || days < 1 || days > 3650) {
    console.error("--days từ 1 đến 3650");
    process.exit(1);
  }
  exp = Math.floor(Date.now() / 1000) + days * 86400;
}

const privatePath = path.join(root, "keys", "license-private.pem");
const privatePem = fs.readFileSync(privatePath, "utf8");
const key = signLicense({ name, exp, mid: machine }, privatePem);
const logDir = path.join(root, "keys");
fs.mkdirSync(logDir, { recursive: true });
fs.appendFileSync(
  path.join(logDir, "issued.log"),
  `${new Date().toISOString()}\t${name}\t${machine}\t${exp}\t${key}\n`,
  "utf8"
);
console.log(key);
