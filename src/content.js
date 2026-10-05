import { vnLocalToUnix } from "./time.js";

/** Pasted lines. Blank lines and lines starting with # are skipped. */
export function textLines(value) {
  const lines = [];
  for (const line of String(value || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    lines.push(trimmed);
  }
  return lines;
}

function roll(rng) {
  const n = Number(typeof rng === "function" ? rng() : Math.random());
  if (!Number.isFinite(n)) return 0;
  return Math.min(0.999999, Math.max(0, n));
}

export function pickLine(lines, index, mode, rng = Math.random) {
  if (!lines.length) return "";
  if (mode === "random") {
    const at = Math.floor(roll(rng) * lines.length);
    return lines[at];
  }
  const i = Math.max(0, Number(index) || 0);
  return lines[i % lines.length];
}

/** Opener, then the post link, then a blank line and the caption body. */
export function composeCaption(body, opener, link) {
  const head = [String(opener || "").trim(), String(link || "").trim()].filter(Boolean);
  const text = String(body || "").trim();
  if (!head.length) return text;
  if (!text) return head.join("\n");
  return `${head.join("\n")}\n\n${text}`;
}

/** Comment opener and its own link. A comment link is not the caption link. */
export function composeComment(opener, link) {
  return [String(opener || "").trim(), String(link || "").trim()].filter(Boolean).join("\n");
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function clockToUnix(date, hh, mm) {
  const hour = Number(hh);
  const minute = Number(mm);
  if (hour > 23 || minute > 59) throw new Error(`Giờ không hợp lệ: ${pad(hour)}:${pad(minute)}`);
  return vnLocalToUnix(`${date}T${pad(hour)}:${pad(minute)}`);
}

/**
 * One slot per line.
 * 09:00 uses startDate. 09:00-10:00 picks one minute in that range.
 * 31/12/2026 19:00 and 2026-12-31 19:00 keep their own day.
 */
export function parseScheduleList(text, startDate, rng = Math.random) {
  const date = String(startDate || "").trim();
  const dateOk = /^(\d{4})-(\d{2})-(\d{2})$/.test(date);
  const lines = textLines(text);
  if (!lines.length) throw new Error("Nhập ít nhất một mốc giờ");
  if (lines.length > 100) throw new Error("Tối đa 100 mốc trong một lần hẹn");
  const slots = [];
  for (const line of lines) {
    const iso = line.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})$/);
    const dmy = line.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})[ T](\d{1,2}):(\d{2})$/);
    const range = line.match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
    const clock = line.match(/^(\d{1,2}):(\d{2})$/);
    if (iso) {
      slots.push(clockToUnix(`${iso[1]}-${iso[2]}-${iso[3]}`, iso[4], iso[5]));
      continue;
    }
    if (dmy) {
      slots.push(clockToUnix(`${dmy[3]}-${pad(dmy[2])}-${pad(dmy[1])}`, dmy[4], dmy[5]));
      continue;
    }
    if (!dateOk) throw new Error("Chọn ngày bắt đầu cho các mốc chỉ có giờ");
    if (range) {
      const startMin = Number(range[1]) * 60 + Number(range[2]);
      const endMin = Number(range[3]) * 60 + Number(range[4]);
      if (Number(range[1]) > 23 || Number(range[3]) > 23 || Number(range[2]) > 59 || Number(range[4]) > 59) {
        throw new Error(`Giờ không hợp lệ: ${line}`);
      }
      if (endMin < startMin) throw new Error(`Khoảng giờ kết thúc phải sau giờ bắt đầu: ${line}`);
      const span = endMin - startMin + 1;
      const picked = startMin + Math.floor(roll(rng) * span);
      slots.push(clockToUnix(date, Math.floor(picked / 60), picked % 60));
      continue;
    }
    if (clock) {
      slots.push(clockToUnix(date, clock[1], clock[2]));
      continue;
    }
    throw new Error(`Dòng giờ không đọc được: ${line}`);
  }
  return slots;
}

/** Push a later slot forward when it is closer than the cooldown. 0 keeps the written times. */
export function applyCooldown(slots, minMinutes, maxMinutes, rng = Math.random) {
  const min = Math.max(0, Math.round(Number(minMinutes) || 0));
  const max = Math.max(min, Math.round(Number(maxMinutes) || 0));
  if (max <= 0) return [...slots];
  const out = [];
  let prev = null;
  for (const unix of slots) {
    let next = unix;
    if (prev != null) {
      const gapMin = min === max ? min : min + Math.floor(roll(rng) * (max - min + 1));
      const floor = prev + gapMin * 60;
      if (next < floor) next = floor;
    }
    out.push(next);
    prev = next;
  }
  return out;
}

export function ensureIncreasing(slots) {
  let prev = null;
  for (const unix of slots) {
    if (prev != null && unix <= prev) {
      throw new Error("Hai mốc trùng hoặc đi lùi. Viết giờ muộn hơn, hoặc đặt cooldown lớn hơn 0.");
    }
    prev = unix;
  }
  return slots;
}

/**
 * Day 1 at the start clock, then the same clock on the next days.
 * Extra posts on a day step by gap minutes. The next day starts over at the clock.
 */
export function buildDayPlan({ startUnix, days, perDay, gapMin, gapMax, rng = Math.random }) {
  const dayCount = Math.round(Number(days));
  const posts = Math.round(Number(perDay));
  if (!Number.isFinite(dayCount) || dayCount < 1 || dayCount > 180) {
    throw new Error("Số ngày hẹn từ 1 đến 180");
  }
  if (!Number.isFinite(posts) || posts < 1 || posts > 20) {
    throw new Error("Số bài mỗi page mỗi ngày từ 1 đến 20");
  }
  if (dayCount * posts > 200) throw new Error("Mỗi page tối đa 200 bài trong một job");
  let min = Math.round(Number(gapMin));
  let max = Math.round(Number(gapMax));
  if (!Number.isFinite(min)) min = 60;
  if (!Number.isFinite(max)) max = min;
  if (min < 0 || max < 0 || max > 1440) throw new Error("Khoảng cách bài từ 0 đến 1440 phút");
  if (max < min) throw new Error("Cách bài tối đa phải lớn hơn hoặc bằng cách tối thiểu");
  if (posts > 1 && max < 1) throw new Error("Nhiều bài trong ngày cần cách nhau ít nhất 1 phút");
  const start = Math.floor(Number(startUnix));
  if (!Number.isFinite(start) || start <= 0) throw new Error("Giờ không hợp lệ. Chọn ngày giờ.");
  const lo = Math.max(posts > 1 ? 1 : 0, min);
  const hi = Math.max(lo, max);
  const slots = [];
  for (let day = 0; day < dayCount; day++) {
    let cursor = start + day * 86400;
    for (let i = 0; i < posts; i++) {
      slots.push(cursor);
      if (i < posts - 1) {
        const gap = lo === hi ? lo : lo + Math.floor(roll(rng) * (hi - lo + 1));
        cursor += gap * 60;
      }
    }
  }
  return slots;
}

/** Calendar day in Asia/Ho_Chi_Minh, YYYY-MM-DD. */
export function vnDayKey(unixSec) {
  const n = Number(unixSec);
  if (!Number.isFinite(n) || n <= 0) return "";
  const shifted = new Date(n * 1000 + 7 * 3600 * 1000);
  const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const day = String(shifted.getUTCDate()).padStart(2, "0");
  return `${shifted.getUTCFullYear()}-${month}-${day}`;
}
