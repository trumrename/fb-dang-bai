/** Asia/Ho_Chi_Minh has no daylight saving. UTC+7 all year. */
export function vnLocalToUnix(value) {
  const m = String(value || "").trim().match(
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/
  );
  if (!m) throw new Error("Giờ không hợp lệ. Chọn ngày giờ.");
  const utc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]) - 7, Number(m[5]), 0);
  if (!Number.isFinite(utc)) throw new Error("Giờ không hợp lệ.");
  return Math.floor(utc / 1000);
}

export function formatVn(unixOrMs) {
  const n = Number(unixOrMs);
  if (!Number.isFinite(n) || n <= 0) return "";
  const ms = n < 1e12 ? n * 1000 : n;
  return new Date(ms).toLocaleString("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    hour12: false,
  });
}

/** 23:59:59 Asia/Ho_Chi_Minh on that calendar day, as unix seconds. */
export function vnEndOfDayUnix(day) {
  const match = String(day || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error("--until phải là YYYY-MM-DD");
  const utc = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 16, 59, 59);
  if (!Number.isFinite(utc)) throw new Error("--until phải là YYYY-MM-DD");
  return Math.floor(utc / 1000);
}

/** Graph accepts a Page schedule from 10 minutes to about 6 months. */
const MIN_SCHEDULE_SEC = 10 * 60;
const MAX_SCHEDULE_SEC = 180 * 24 * 60 * 60;

export function validateScheduleUnix(unixSec, nowSec = Math.floor(Date.now() / 1000)) {
  const n = Number(unixSec);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error("Giờ hẹn không hợp lệ");
  }
  const t = Math.floor(n);
  if (t < nowSec + MIN_SCHEDULE_SEC) {
    throw new Error("Hẹn giờ phải cách hiện tại ít nhất 10 phút");
  }
  if (t > nowSec + MAX_SCHEDULE_SEC) {
    throw new Error("Hẹn giờ tối đa 180 ngày kể từ bây giờ");
  }
  return t;
}

export { MIN_SCHEDULE_SEC, MAX_SCHEDULE_SEC };
