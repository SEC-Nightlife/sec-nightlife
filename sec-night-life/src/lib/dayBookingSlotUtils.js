export const MIN_WINDOW_MINUTES = 30;
export const END_BUFFER_MINUTES = 0;
export const SLOT_STEP_MINUTES = 30;
const SAST_TZ = 'Africa/Johannesburg';

/** Venue zone carried on the API venue window (`timeZone`), else SAST for legacy payloads. */
export function venueTimeZone(venueWindow) {
  const tz = venueWindow?.timeZone;
  if (!tz || typeof tz !== 'string') return SAST_TZ;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return SAST_TZ;
  }
}

/** Short label like "SAST" or "GMT+1" when the venue zone differs from the viewer's; else null. */
export function venueZoneLabelIfDifferent(venueWindow, now = new Date()) {
  const tz = venueTimeZone(venueWindow);
  let viewerTz = null;
  try {
    viewerTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    viewerTz = null;
  }
  const offsetOf = (zone) => {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
        .formatToParts(now)
        .map((x) => [x.type, x.value]),
    );
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute) - Math.floor(now.getTime() / 60000) * 60000;
  };
  if (viewerTz && (viewerTz === tz || offsetOf(viewerTz) === offsetOf(tz))) return null;
  if (tz === SAST_TZ) return 'SAST';
  const part = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' })
    .formatToParts(now)
    .find((x) => x.type === 'timeZoneName');
  return part?.value || tz;
}

function parseClock(value) {
  if (!value || typeof value !== 'string') return null;
  const [h, m] = value.split(':').map((x) => parseInt(x, 10));
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return { h, m, minutes: h * 60 + m };
}

function minutesToHHmm(totalMinutes) {
  const normalized = ((totalMinutes % 1440) + 1440) % 1440;
  const h = Math.floor(normalized / 60);
  const m = normalized % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function currentClockSast(refDate = new Date(), tz = SAST_TZ) {
  const d = refDate instanceof Date ? refDate : new Date(refDate);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const h = parts.find((p) => p.type === 'hour')?.value;
  const m = parts.find((p) => p.type === 'minute')?.value;
  if (!h || !m) return null;
  return `${String(parseInt(h, 10)).padStart(2, '0')}:${String(parseInt(m, 10)).padStart(2, '0')}`;
}

export function nowMinutesSast(venueWindow, now = new Date()) {
  const nowClock = currentClockSast(now, venueTimeZone(venueWindow));
  if (!nowClock || !venueWindow) return null;
  return toServiceMinutes(nowClock, venueWindow);
}

/** True when the slot start time is strictly before the current venue-local minute. */
export function isStartTimeInPast(startTime, venueWindow, now = new Date()) {
  const nowM = nowMinutesSast(venueWindow, now);
  const startM = toServiceMinutes(startTime, venueWindow);
  if (nowM == null || startM == null) return false;
  return startM < nowM;
}

export function ceilToSlotStep(minutes, step = SLOT_STEP_MINUTES) {
  if (!Number.isFinite(minutes)) return null;
  return Math.ceil(minutes / step) * step;
}

export function earliestBookableStartMinutes(venueWindow, now = new Date(), step = SLOT_STEP_MINUTES) {
  if (!venueWindow?.startTime) return null;
  const bookableStart = toServiceMinutes(venueWindow.startTime, venueWindow);
  if (bookableStart == null) return null;

  const nowM = nowMinutesSast(venueWindow, now);
  if (nowM == null) return bookableStart;

  const roundedNow = ceilToSlotStep(nowM, step);
  return Math.max(bookableStart, roundedNow);
}

export function earliestBookableStartTime(venueWindow, now = new Date()) {
  const mins = earliestBookableStartMinutes(venueWindow, now);
  if (mins == null) return null;
  return minutesToHHmm(mins);
}

export function clipGapsByEarliestStart(gaps, earliestMinutes, venueWindow, minMinutes = MIN_WINDOW_MINUTES) {
  if (!gaps?.length || earliestMinutes == null || !venueWindow) return gaps || [];

  return gaps
    .map((gap) => {
      const g = serviceInterval(gap.startTime, gap.endTime, venueWindow);
      if (!g) return null;
      const clippedStart = Math.max(g[0], earliestMinutes);
      if (g[1] - clippedStart < minMinutes) return null;
      return {
        startTime: minutesToHHmm(clippedStart),
        endTime: gap.endTime,
      };
    })
    .filter(Boolean);
}

export function isOvernightWindow(startTime, endTime) {
  const s = parseClock(startTime);
  const e = parseClock(endTime);
  if (!s || !e) return false;
  return e.minutes <= s.minutes;
}

export function toServiceMinutes(time, venueWindow) {
  const t = parseClock(time);
  const vs = parseClock(venueWindow?.startTime);
  if (!t || !vs) return null;
  let m = t.minutes;
  if (isOvernightWindow(venueWindow.startTime, venueWindow.endTime) && m < vs.minutes) {
    m += 1440;
  }
  return m;
}

export function serviceInterval(startTime, endTime, venueWindow) {
  const s = toServiceMinutes(startTime, venueWindow);
  let e = toServiceMinutes(endTime, venueWindow);
  if (s == null || e == null) return null;
  if (e <= s) e += 1440;
  return [s, e];
}

export function latestBookableEndTime(venueWindow, bufferMinutes = END_BUFFER_MINUTES) {
  if (!venueWindow?.endTime) return null;
  const e = parseClock(venueWindow.endTime);
  if (!e) return null;
  let mins = e.minutes - bufferMinutes;
  if (mins < 0) mins += 1440;
  return minutesToHHmm(mins);
}

export function bookingDurationMinutes(startTime, endTime, venueWindow) {
  const interval = serviceInterval(startTime, endTime, venueWindow);
  if (!interval) return null;
  return interval[1] - interval[0];
}

export function buildAvailableGaps(
  venueWindow,
  occupancy = [],
  { minMinutes = MIN_WINDOW_MINUTES, endBufferMinutes = END_BUFFER_MINUTES, now = new Date() } = {},
) {
  if (!venueWindow?.startTime || !venueWindow?.endTime) return [];

  let bookableStart = toServiceMinutes(venueWindow.startTime, venueWindow);
  const venueEnd = toServiceMinutes(venueWindow.endTime, venueWindow);
  if (bookableStart == null || venueEnd == null) return [];

  const earliest = earliestBookableStartMinutes(venueWindow, now);
  if (earliest != null) {
    bookableStart = Math.max(bookableStart, earliest);
  }

  const bookableEnd = venueEnd - endBufferMinutes;
  if (bookableEnd <= bookableStart) return [];

  const blocks = occupancy
    .map((o) => serviceInterval(o.startTime, o.endTime, venueWindow))
    .filter(Boolean)
    .sort((a, b) => a[0] - b[0]);

  const merged = [];
  for (const [s, e] of blocks) {
    const clampedStart = Math.max(s, bookableStart);
    const clampedEnd = Math.min(e, bookableEnd);
    if (clampedEnd <= clampedStart) continue;
    const last = merged[merged.length - 1];
    if (last && clampedStart <= last[1]) {
      last[1] = Math.max(last[1], clampedEnd);
    } else {
      merged.push([clampedStart, clampedEnd]);
    }
  }

  const gaps = [];
  let cursor = bookableStart;
  for (const [s, e] of merged) {
    if (s > cursor) gaps.push([cursor, s]);
    cursor = Math.max(cursor, e);
  }
  if (cursor < bookableEnd) gaps.push([cursor, bookableEnd]);

  return gaps
    .filter(([s, e]) => e - s >= minMinutes)
    .map(([s, e]) => ({
      startTime: minutesToHHmm(s),
      endTime: minutesToHHmm(e),
    }));
}

export function formatWindowLabel(startTime, endTime, isOvernight) {
  if (!startTime || !endTime) return '';
  const overnightSuffix = isOvernight && parseClock(endTime)?.minutes <= parseClock(startTime)?.minutes
    ? ' (+1)'
    : '';
  return `${startTime}–${endTime}${overnightSuffix}`;
}

export function formatDurationLabel(startTime, endTime, venueWindow) {
  const mins = bookingDurationMinutes(startTime, endTime, venueWindow);
  if (mins == null) return '';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}

export function listTimeOptionsInGap(
  gap,
  stepMinutes = SLOT_STEP_MINUTES,
  venueWindow = null,
  now = new Date(),
  { applyEarliestFilter = true } = {},
) {
  if (!gap?.startTime || !gap?.endTime) return [];
  let t0;
  let t1;
  if (venueWindow) {
    // Convert gap boundaries into service minutes so overnight gaps that fall
    // entirely after midnight (e.g. 00:00–05:00 for a 12:00–05:00 service) line
    // up with the earliest-start filter, which also works in service minutes.
    const interval = serviceInterval(gap.startTime, gap.endTime, venueWindow);
    if (!interval) return [];
    [t0, t1] = interval;
  } else {
    const start = parseClock(gap.startTime)?.minutes;
    const end = parseClock(gap.endTime)?.minutes;
    if (start == null || end == null) return [];
    t0 = start;
    t1 = end;
    if (t1 <= t0) t1 += 1440;
  }

  if (venueWindow && applyEarliestFilter) {
    const earliest = earliestBookableStartMinutes(venueWindow, now, stepMinutes);
    if (earliest != null) {
      t0 = Math.max(t0, earliest);
    }
  }

  const options = [];
  for (let m = t0; m <= t1; m += stepMinutes) {
    options.push(minutesToHHmm(m));
  }
  return options;
}

export function findGapContainingWindow(gaps, startTime, endTime, venueWindow) {
  const interval = serviceInterval(startTime, endTime, venueWindow);
  if (!interval) return null;
  for (const gap of gaps) {
    const g = serviceInterval(gap.startTime, gap.endTime, venueWindow);
    if (!g) continue;
    if (interval[0] >= g[0] && interval[1] <= g[1]) return gap;
  }
  return null;
}

export function defaultWindowFromGaps(
  gaps,
  venueWindow,
  { defaultDurationMinutes = 120, now = new Date() } = {},
) {
  if (!gaps?.length || !venueWindow) return null;
  const gap = gaps[0];
  const g = serviceInterval(gap.startTime, gap.endTime, venueWindow);
  if (!g) return null;

  const earliest = earliestBookableStartMinutes(venueWindow, now);
  const startM = earliest != null ? Math.max(g[0], earliest) : g[0];
  if (g[1] - startM < MIN_WINDOW_MINUTES) return null;

  const startTime = minutesToHHmm(startM);
  const endM = Math.min(startM + defaultDurationMinutes, g[1]);
  if (endM - startM < MIN_WINDOW_MINUTES) {
    return { startTime, endTime: minutesToHHmm(g[1]) };
  }
  return { startTime, endTime: minutesToHHmm(endM) };
}

export function endTimeFromDuration(startTime, durationMinutes, venueWindow, gap, latestBookableEnd) {
  if (!startTime || !venueWindow) return null;
  const startM = toServiceMinutes(startTime, venueWindow);
  if (startM == null) return null;

  let endM = startM + durationMinutes;
  if (gap) {
    const g = serviceInterval(gap.startTime, gap.endTime, venueWindow);
    if (g) endM = Math.min(endM, g[1]);
  }
  if (latestBookableEnd) {
    const latestM = toServiceMinutes(latestBookableEnd, venueWindow);
    if (latestM != null) endM = Math.min(endM, latestM);
  }
  if (endM - startM < MIN_WINDOW_MINUTES) return null;
  return minutesToHHmm(endM);
}

export function validateBookingWindow(
  value,
  venueWindow,
  occupancy = [],
  { mode = 'host', now = new Date(), maxDurationMinutes = null } = {},
) {
  if (!venueWindow?.startTime || !venueWindow?.endTime) {
    return 'No service window configured for today';
  }
  const { startTime, endTime } = value || {};
  if (!startTime || !endTime) return 'Select a start and end time';

  if (isStartTimeInPast(startTime, venueWindow, now)) {
    return 'This time has already passed';
  }

  const duration = bookingDurationMinutes(startTime, endTime, venueWindow);
  if (duration == null || duration < MIN_WINDOW_MINUTES) {
    return `Minimum booking is ${MIN_WINDOW_MINUTES} minutes`;
  }

  const maxDurationMinutesResolved = maxDurationMinutes ?? null;
  if (maxDurationMinutesResolved != null && duration > maxDurationMinutesResolved) {
    const hours = maxDurationMinutesResolved / 60;
    const label = Number.isInteger(hours) ? `${hours} hour${hours === 1 ? '' : 's'}` : `${maxDurationMinutesResolved} minutes`;
    return `Maximum booking duration is ${label}`;
  }

  const latestEnd = latestBookableEndTime(venueWindow);
  const userEndM = toServiceMinutes(endTime, venueWindow);
  const latestEndM = toServiceMinutes(latestEnd, venueWindow);
  if (userEndM != null && latestEndM != null && userEndM > latestEndM) {
    return `Bookings must end by ${latestEnd}`;
  }

  const gaps = buildAvailableGaps(venueWindow, occupancy, { now });
  const inGap = findGapContainingWindow(gaps, startTime, endTime, venueWindow);
  if (!inGap) {
    return mode === 'host'
      ? 'This time overlaps a booking on this table'
      : 'Choose a time that does not overlap an active host session';
  }

  return null;
}

export function isWindowValid(venueWindow, value, occupancy = [], options = {}) {
  return !validateBookingWindow(value, venueWindow, occupancy, options);
}

export function hasSlotsRemainingToday(venueWindow, occupancy = [], now = new Date()) {
  return buildAvailableGaps(venueWindow, occupancy, { now }).length > 0;
}

/** Timeline segments for visual rail: past, booked, selected, now marker */
export function buildTimelineSegments(venueWindow, occupancy, selectedWindow, latestEnd, now = new Date()) {
  if (!venueWindow) return { segments: [], ticks: [], nowPct: null };

  const bookableStart = toServiceMinutes(venueWindow.startTime, venueWindow);
  const bookableEnd = toServiceMinutes(latestEnd || latestBookableEndTime(venueWindow), venueWindow);
  const total = bookableEnd - bookableStart;
  if (total <= 0) return { segments: [], ticks: [], nowPct: null };

  const toPct = (mins) => ((mins - bookableStart) / total) * 100;

  const segments = [];

  const earliest = earliestBookableStartMinutes(venueWindow, now);
  const nowClock = currentClockSast(now);
  const nowM = nowClock ? toServiceMinutes(nowClock, venueWindow) : null;

  if (earliest != null && earliest > bookableStart) {
    segments.push({
      type: 'past',
      left: 0,
      width: toPct(earliest),
      label: 'Past',
    });
  }

  for (const o of occupancy) {
    const iv = serviceInterval(o.startTime, o.endTime, venueWindow);
    if (!iv) continue;
    const left = Math.max(iv[0], bookableStart);
    const right = Math.min(iv[1], bookableEnd);
    if (right <= left) continue;
    segments.push({
      type: 'booked',
      left: toPct(left),
      width: toPct(right) - toPct(left),
      label: `${o.startTime}–${o.endTime}`,
      spotsRemaining: o.spotsRemaining,
    });
  }

  if (selectedWindow?.startTime && selectedWindow?.endTime) {
    const iv = serviceInterval(selectedWindow.startTime, selectedWindow.endTime, venueWindow);
    if (iv) {
      const left = Math.max(iv[0], bookableStart);
      const right = Math.min(iv[1], bookableEnd);
      if (right > left) {
        segments.push({
          type: 'selected',
          left: toPct(left),
          width: toPct(right) - toPct(left),
          label: `${selectedWindow.startTime}–${selectedWindow.endTime}`,
        });
      }
    }
  }

  const ticks = [];
  for (let m = bookableStart; m <= bookableEnd; m += 60) {
    ticks.push({ time: minutesToHHmm(m), pct: toPct(m) });
  }

  const nowPct = nowM != null && nowM >= bookableStart && nowM <= bookableEnd ? toPct(nowM) : null;

  return { segments, ticks, bookableStart, bookableEnd, total, nowPct, nowTime: nowClock };
}

/** Thin timeline labels for narrow viewports — avoids overlapping absolute-position ticks. */
export function selectTimelineTicks(ticks, { isMobile = false, totalMinutes = 0 } = {}) {
  if (!ticks?.length) return [];

  const dedupeByTime = (list) => {
    const seen = new Set();
    return list.filter((t) => {
      if (seen.has(t.time)) return false;
      seen.add(t.time);
      return true;
    });
  };

  const pickByTargetPcts = (targetPcts) => {
    const picked = [];
    for (const pct of targetPcts) {
      let best = ticks[0];
      let bestDist = Infinity;
      for (const tick of ticks) {
        const dist = Math.abs(tick.pct - pct);
        if (dist < bestDist) {
          bestDist = dist;
          best = tick;
        }
      }
      picked.push(best);
    }
    return dedupeByTime(picked).sort((a, b) => a.pct - b.pct);
  };

  if (!isMobile) {
    if (totalMinutes > 480) {
      return dedupeByTime(ticks.filter((_, i) => i % 2 === 0 || i === ticks.length - 1));
    }
    return ticks;
  }

  if (totalMinutes > 480) {
    return pickByTargetPcts([0, 25, 50, 75, 100]);
  }

  if (totalMinutes > 240) {
    const n = ticks.length;
    const indices = [
      0,
      Math.floor(n * 0.25),
      Math.floor(n * 0.5),
      Math.floor(n * 0.75),
      n - 1,
    ];
    return dedupeByTime([...new Set(indices)].map((i) => ticks[i]).filter(Boolean)).sort(
      (a, b) => a.pct - b.pct,
    );
  }

  return dedupeByTime(ticks.filter((_, i) => i % 2 === 0 || i === ticks.length - 1));
}
