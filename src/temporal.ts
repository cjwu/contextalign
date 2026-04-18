import * as chrono from "chrono-node";
import { getSessionStartTime } from "./db.js";
import type { SearchResult } from "./types.js";

const TEMPORAL_BOOST = 3.0;

export function hasUpdateIndicator(query: string): boolean {
  return /現況|最新|現在|改用|改成|最終決定|目前|當前|latest|current state/i.test(query);
}

export function extractTimeRanges(
  query: string,
  sessionId?: string
): Array<{ start: Date; end: Date }> {
  const now = new Date();
  const ranges: Array<{ start: Date; end: Date }> = [];
  const seen = new Set<string>();
  const DAY = 24 * 60 * 60 * 1000;
  const MIN = 60 * 1000;

  const addRange = (start: Date, end: Date) => {
    const key = `${start.toISOString()}|${end.toISOString()}`;
    if (seen.has(key)) return;
    seen.add(key);
    ranges.push({ start, end });
  };

  const addResult = (r: any) => {
    if (!r?.start) return;
    const start = r.start.date();
    const end = r.end?.date() ?? new Date(start.getTime() + DAY);
    addRange(start, end);
  };

  try {
    chrono.parse(query, now, { forwardDate: false }).forEach(addResult);
  } catch {}
  try {
    (chrono as any).zh?.parse?.(query, now, { forwardDate: false })?.forEach(addResult);
  } catch {}

  const startOfDay = (d: Date) => {
    const t = new Date(d);
    t.setHours(0, 0, 0, 0);
    return t;
  };
  const endOfDay = (d: Date) => {
    const t = new Date(d);
    t.setHours(23, 59, 59, 999);
    return t;
  };

  if (/上週|上星期|上禮拜/.test(query)) {
    const day = now.getDay() || 7;
    const lastSun = startOfDay(new Date(now.getTime() - day * DAY));
    const lastMon = new Date(lastSun.getTime() - 6 * DAY);
    addRange(lastMon, endOfDay(lastSun));
  }
  if (/這週|本週|這星期|本星期|這禮拜|本禮拜/.test(query)) {
    const day = now.getDay() || 7;
    const mon = startOfDay(new Date(now.getTime() - (day - 1) * DAY));
    addRange(mon, now);
  }
  const mDays = query.match(/(\d+)\s*天前/);
  if (mDays) {
    const n = parseInt(mDays[1], 10);
    const target = new Date(now.getTime() - n * DAY);
    addRange(startOfDay(target), endOfDay(target));
  }
  const mHours = query.match(/(\d+)\s*(小時|個小時|鐘頭)前/);
  if (mHours) {
    const n = parseInt(mHours[1], 10);
    const end = new Date(now.getTime() - n * 60 * 60 * 1000);
    const start = new Date(end.getTime() - 60 * 60 * 1000);
    addRange(start, end);
  }
  const mWeeks = query.match(/(\d+)\s*(週|星期|禮拜)前/);
  if (mWeeks) {
    const n = parseInt(mWeeks[1], 10);
    const end = new Date(now.getTime() - n * 7 * DAY);
    addRange(startOfDay(new Date(end.getTime() - 7 * DAY)), endOfDay(end));
  }
  const mMonths = query.match(/(\d+)\s*(個月|月)前/);
  if (mMonths) {
    const n = parseInt(mMonths[1], 10);
    const end = new Date(now);
    end.setMonth(end.getMonth() - n);
    const start = new Date(end);
    start.setMonth(start.getMonth() - 1);
    addRange(startOfDay(start), endOfDay(end));
  }
  if (/上個月|上月/.test(query)) {
    const end = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    addRange(start, end);
  }
  if (/這個月|本月/.test(query)) {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    addRange(start, now);
  }

  if (/剛才|剛剛|just now/i.test(query)) {
    addRange(new Date(now.getTime() - 30 * MIN), now);
  }
  if (sessionId && /一開始|最初|開頭|起初|session\s*(頭|開頭|開始|start|beginning)|從頭|beginning of session/i.test(query)) {
    const startIso = getSessionStartTime(sessionId);
    if (startIso) {
      const sessionStart = new Date(startIso);
      addRange(
        new Date(sessionStart.getTime() - 30 * MIN),
        new Date(sessionStart.getTime() + 30 * MIN)
      );
    }
  }
  const mRecentMin = query.match(/前面\s*(\d+)?\s*分鐘?/);
  if (mRecentMin) {
    const n = mRecentMin[1] ? parseInt(mRecentMin[1], 10) : 60;
    addRange(new Date(now.getTime() - n * MIN), now);
  }

  return ranges;
}

export function applyTemporalBoost(
  results: SearchResult[],
  ranges: Array<{ start: Date; end: Date }>
): SearchResult[] {
  return results
    .map((r) => {
      const ts = new Date(r.timestamp).getTime();
      const inRange = ranges.some(
        (rng) => ts >= rng.start.getTime() && ts <= rng.end.getTime()
      );
      return inRange ? { ...r, score: r.score * TEMPORAL_BOOST } : r;
    })
    .sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return b.score - a.score;
    });
}
