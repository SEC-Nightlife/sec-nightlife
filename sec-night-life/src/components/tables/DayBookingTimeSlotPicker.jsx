import React, { useEffect, useMemo, useState } from 'react';
import { Clock, Users } from 'lucide-react';
import DayBookingTimeChipRail from '@/components/tables/DayBookingTimeChipRail';
import { useIsMobile } from '@/hooks/use-mobile';
import {
  MIN_WINDOW_MINUTES,
  SLOT_STEP_MINUTES,
  buildAvailableGaps,
  buildTimelineSegments,
  defaultWindowFromGaps,
  earliestBookableStartTime,
  endTimeFromDuration,
  formatDurationLabel,
  formatWindowLabel,
  hasSlotsRemainingToday,
  latestBookableEndTime,
  listTimeOptionsInGap,
  selectTimelineTicks,
  toServiceMinutes,
  validateBookingWindow,
  findGapContainingWindow,
  venueZoneLabelIfDifferent,
} from '@/lib/dayBookingSlotUtils';

export { isWindowValid } from '@/lib/dayBookingSlotUtils';

const DURATION_PRESETS = [
  { key: '1h', label: '1h', minutes: 60 },
  { key: '2h', label: '2h', minutes: 120 },
  { key: '3h', label: '3h', minutes: 180 },
  { key: 'close', label: 'Until close', minutes: null },
];

function useNowTick(intervalMs = 60000) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function DurationPills({
  startTime,
  endTime,
  activeGap,
  venueWindow,
  latestBookableEnd,
  onSelect,
  disabled,
  durationPresets = DURATION_PRESETS,
  maxDurationMinutes = null,
}) {
  const activeKey = useMemo(() => {
    if (!startTime || !endTime || !venueWindow) return null;
    for (const preset of durationPresets) {
      if (preset.minutes == null) {
        const gapEnd = activeGap?.endTime;
        if (gapEnd === endTime) return preset.key;
        const latest = latestBookableEnd;
        if (latest === endTime) return preset.key;
        continue;
      }
      const computed = endTimeFromDuration(startTime, preset.minutes, venueWindow, activeGap, latestBookableEnd);
      if (computed === endTime) return preset.key;
    }
    return null;
  }, [startTime, endTime, venueWindow, activeGap, latestBookableEnd, durationPresets]);

  return (
    <div className="flex flex-wrap gap-2">
      {durationPresets.map((preset) => {
        const isActive = activeKey === preset.key;
        return (
          <button
            key={preset.key}
            type="button"
            disabled={disabled || !startTime}
            onClick={() => {
              if (!startTime) return;
              let end;
              if (preset.minutes == null) {
                const capMinutes = maxDurationMinutes ?? 9999;
                end = endTimeFromDuration(startTime, capMinutes, venueWindow, activeGap, latestBookableEnd);
                if (!end) {
                  end = latestBookableEnd || activeGap?.endTime;
                }
              } else {
                end = endTimeFromDuration(startTime, preset.minutes, venueWindow, activeGap, latestBookableEnd);
              }
              if (end) onSelect(end);
            }}
            className="rounded-full px-3 py-1.5 text-xs font-medium transition-all duration-150"
            style={{
              minHeight: 36,
              border: `1px solid ${isActive ? 'var(--sec-accent)' : 'var(--sec-border)'}`,
              background: isActive ? 'var(--sec-accent-muted)' : 'transparent',
              color: isActive ? 'var(--sec-accent-bright)' : 'var(--sec-text-muted)',
              opacity: disabled || !startTime ? 0.5 : 1,
            }}
          >
            {preset.label}
          </button>
        );
      })}
    </div>
  );
}

export default function DayBookingTimeSlotPicker({
  venueWindow,
  value,
  onChange,
  occupancy = [],
  availableGaps = [],
  serviceDay,
  latestBookableEnd: latestBookableEndProp,
  isOvernight = false,
  mode = 'host',
  autoSelectDefault = true,
  readOnly = false,
  compact = false,
  closedToday = false,
  openDaysSummary = null,
  maxBookingDurationHours = null,
}) {
  const isMobile = useIsMobile();
  const now = useNowTick();
  const maxDurationMinutes =
    maxBookingDurationHours != null && Number(maxBookingDurationHours) > 0
      ? Number(maxBookingDurationHours) * 60
      : null;
  const durationPresets = useMemo(() => {
    if (!maxDurationMinutes) return DURATION_PRESETS;
    return DURATION_PRESETS.filter((preset) => preset.minutes == null || preset.minutes <= maxDurationMinutes);
  }, [maxDurationMinutes]);
  const latestBookableEnd = latestBookableEndProp || latestBookableEndTime(venueWindow);
  const earliestStart = earliestBookableStartTime(venueWindow, now);
  const venueZoneLabel = venueZoneLabelIfDifferent(venueWindow, now);

  const gaps = useMemo(() => {
    if (venueWindow) {
      const computed = buildAvailableGaps(venueWindow, occupancy, { now });
      if (computed.length) return computed;
    }
    return availableGaps?.length ? availableGaps : [];
  }, [venueWindow, occupancy, availableGaps, now.getTime()]);

  const [activeGap, setActiveGap] = useState(null);

  // Select a gap so chip rails render; does not pre-fill checkout times unless autoSelectDefault.
  useEffect(() => {
    if (!venueWindow || readOnly || gaps.length === 0) return;

    if (value?.startTime && value?.endTime) {
      const gap = findGapContainingWindow(gaps, value.startTime, value.endTime, venueWindow);
      if (gap) setActiveGap(gap);
      return;
    }

    if (gaps.length === 1) {
      setActiveGap(gaps[0]);
      return;
    }

    setActiveGap((prev) => {
      if (prev && gaps.some((g) => g.startTime === prev.startTime && g.endTime === prev.endTime)) {
        return prev;
      }
      return null;
    });
  }, [venueWindow, gaps, readOnly, value?.startTime, value?.endTime, now.getTime()]);

  useEffect(() => {
    if (!autoSelectDefault || !venueWindow || readOnly || value?.startTime) return;
    const initial = defaultWindowFromGaps(gaps, venueWindow, {
      now,
      defaultDurationMinutes: maxDurationMinutes ? Math.min(120, maxDurationMinutes) : 120,
    });
    if (initial) {
      onChange?.(initial);
      const gap = findGapContainingWindow(gaps, initial.startTime, initial.endTime, venueWindow);
      if (gap) setActiveGap(gap);
    }
  }, [autoSelectDefault, venueWindow?.startTime, venueWindow?.endTime, gaps.length, now.getTime()]);

  // Bump selection if it becomes invalid (page left open)
  useEffect(() => {
    if (!venueWindow || readOnly || !value?.startTime) return;
    const err = validateBookingWindow(value, venueWindow, occupancy, { mode, now, maxDurationMinutes });
    if (err === 'This time has already passed') {
      const initial = defaultWindowFromGaps(gaps, venueWindow, {
      now,
      defaultDurationMinutes: maxDurationMinutes ? Math.min(120, maxDurationMinutes) : 120,
    });
      if (initial) onChange?.(initial);
    }
  }, [now.getTime()]);

  const validation = useMemo(
    () => validateBookingWindow(value, venueWindow, occupancy, { mode, now, maxDurationMinutes }),
    [value, venueWindow, occupancy, mode, now.getTime(), maxDurationMinutes],
  );

  const { segments, ticks, nowPct, nowTime, total } = useMemo(
    () => buildTimelineSegments(venueWindow, occupancy, value, latestBookableEnd, now),
    [venueWindow, occupancy, value, latestBookableEnd, now.getTime()],
  );

  const visibleTicks = useMemo(
    () => selectTimelineTicks(ticks, { isMobile, totalMinutes: total || 0 }),
    [ticks, isMobile, total],
  );

  const startOptions = useMemo(() => {
    if (!activeGap || !venueWindow) return [];
    const all = listTimeOptionsInGap(activeGap, SLOT_STEP_MINUTES, venueWindow, now, {
      applyEarliestFilter: true,
    });
    const endM = value?.endTime ? toServiceMinutes(value.endTime, venueWindow) : null;
    return all.filter((t) => {
      if (endM == null) return true;
      const tm = toServiceMinutes(t, venueWindow);
      if (tm == null) return false;
      let em = endM;
      let sm = tm;
      if (em <= sm) em += 1440;
      return em - sm >= MIN_WINDOW_MINUTES;
    });
  }, [activeGap, value?.endTime, venueWindow, now.getTime()]);

  const endOptions = useMemo(() => {
    if (!activeGap || !value?.startTime || !venueWindow) return [];
    const all = listTimeOptionsInGap(activeGap, SLOT_STEP_MINUTES, venueWindow, now, {
      applyEarliestFilter: false,
    });
    const startM = toServiceMinutes(value.startTime, venueWindow);
    if (startM == null) return [];
    return all.filter((t) => {
      const tm = toServiceMinutes(t, venueWindow);
      if (tm == null) return false;
      let em = tm;
      let sm = startM;
      if (em <= sm) em += 1440;
      if (maxDurationMinutes != null && em - sm > maxDurationMinutes) return false;
      return em - sm >= MIN_WINDOW_MINUTES;
    });
  }, [activeGap, value?.startTime, venueWindow, now.getTime(), maxDurationMinutes]);

  const slotsRemaining = hasSlotsRemainingToday(venueWindow, occupancy, now);
  const showEarliestHint = earliestStart && venueWindow?.startTime && earliestStart !== venueWindow.startTime;

  if (!venueWindow) {
    if (closedToday) {
      return (
        <div
          className="rounded-xl border p-4"
          style={{
            borderColor: 'var(--sec-border)',
            background: 'linear-gradient(145deg, var(--sec-bg-card) 0%, var(--sec-bg-elevated) 100%)',
            boxShadow: 'var(--shadow-card)',
          }}
        >
          <div className="flex items-start gap-3">
            <div
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
              style={{ background: 'var(--sec-accent-muted)', border: '1px solid var(--sec-accent-border)' }}
            >
              <Clock size={16} style={{ color: 'var(--sec-accent)' }} />
            </div>
            <div>
              <p className="text-sm font-semibold text-[var(--sec-text-primary)]">Not open today</p>
              <p className="text-xs text-[var(--sec-text-muted)] mt-1">
                This table is not available for day bookings today.
                {openDaysSummary ? ` Open: ${openDaysSummary}.` : ''}
              </p>
            </div>
          </div>
        </div>
      );
    }
    return null;
  }

  const dayLabel = serviceDay?.label || 'Today';
  const serviceLabel = formatWindowLabel(venueWindow.startTime, venueWindow.endTime, isOvernight);

  if (readOnly && value?.startTime && value?.endTime) {
    return (
      <div
        className="rounded-xl border p-4"
        style={{
          borderColor: 'var(--sec-border)',
          background: 'linear-gradient(145deg, var(--sec-bg-card) 0%, var(--sec-bg-elevated) 100%)',
          boxShadow: 'var(--shadow-card)',
        }}
      >
        <div className="flex items-start gap-3">
          <div
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
            style={{ background: 'var(--sec-accent-muted)', border: '1px solid var(--sec-accent-border)' }}
          >
            <Clock size={16} style={{ color: 'var(--sec-accent)' }} />
          </div>
          <div>
            <p className="text-sm font-semibold text-[var(--sec-text-primary)]">Table time</p>
            <p className="text-sm text-[var(--sec-accent)] mt-1 font-medium">
              {value.startTime} – {value.endTime}
              {isOvernight ? ' (+1)' : ''}
            </p>
            <p className="text-xs text-[var(--sec-text-muted)] mt-1">
              Joining during the host&apos;s booking window
            </p>
          </div>
        </div>
      </div>
    );
  }

  const handleGapSelect = (gap) => {
    setActiveGap(gap);
    if (autoSelectDefault) {
      const initial = defaultWindowFromGaps([gap], venueWindow, { defaultDurationMinutes: 120, now });
      if (initial) onChange?.(initial);
    } else {
      onChange?.(null);
    }
  };

  return (
    <div
      className={`rounded-xl border space-y-4 ${compact ? 'p-3' : 'p-4 sm:p-5'}`}
      style={{
        borderColor: 'var(--sec-border)',
        borderTopColor: 'var(--sec-accent-border)',
        borderTopWidth: 2,
        background: 'linear-gradient(145deg, var(--sec-bg-card) 0%, var(--sec-bg-elevated) 100%)',
        boxShadow: 'var(--shadow-card)',
      }}
    >
      <div className="flex items-start gap-3">
        <div
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
          style={{
            background: 'var(--sec-accent-muted)',
            border: '1px solid var(--sec-accent-border)',
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06)',
          }}
        >
          <Clock size={18} style={{ color: 'var(--sec-accent-bright)' }} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-[var(--sec-accent-bright)]">
            {dayLabel} · Service {serviceLabel}
          </p>
          <p className="text-xs text-[var(--sec-text-muted)] mt-0.5">
            {mode === 'host' ? 'Choose when you will host this table' : 'Choose when you will join'}
            {latestBookableEnd ? ` · Last booking ends by ${latestBookableEnd}` : ''}
            {venueZoneLabel ? ` · Venue time (${venueZoneLabel})` : ''}
          </p>
          {showEarliestHint ? (
            <p className="text-xs mt-1" style={{ color: 'var(--sec-accent)' }}>
              From {earliestStart} onwards
            </p>
          ) : null}
        </div>
      </div>

      {!slotsRemaining ? (
        <div
          className="rounded-lg px-4 py-3 text-center"
          style={{ background: 'var(--sec-bg-base)', border: '1px solid var(--sec-border)' }}
        >
          <p className="text-sm font-medium text-[var(--sec-text-primary)]">No more slots today</p>
          <p className="text-xs text-[var(--sec-text-muted)] mt-1">
            Service is ending soon. Try again tomorrow
            {openDaysSummary ? ` (${openDaysSummary})` : ''}.
          </p>
        </div>
      ) : null}

      {gaps.length > 1 ? (
        <div className="space-y-2">
          <p className="text-xs font-medium text-[var(--sec-text-secondary)]">Available periods</p>
          <div className="flex flex-wrap gap-2">
            {gaps.map((gap) => {
              const isActive =
                activeGap?.startTime === gap.startTime && activeGap?.endTime === gap.endTime;
              return (
                <button
                  key={`${gap.startTime}-${gap.endTime}`}
                  type="button"
                  onClick={() => handleGapSelect(gap)}
                  className="rounded-full px-3 py-1.5 text-xs font-medium transition-colors"
                  style={{
                    minHeight: 36,
                    border: `1px solid ${isActive ? 'var(--sec-accent)' : 'var(--sec-border)'}`,
                    background: isActive ? 'var(--sec-accent-muted)' : 'var(--sec-bg-base)',
                    color: isActive ? 'var(--sec-accent-bright)' : 'var(--sec-text-secondary)',
                  }}
                >
                  {gap.startTime} – {gap.endTime}
                </button>
              );
            })}
          </div>
        </div>
      ) : gaps.length === 0 && slotsRemaining === false ? null : null}

      {slotsRemaining || occupancy.length > 0 ? (
        <div className="space-y-2">
          {nowPct != null && nowTime ? (
            <div className="flex justify-center sm:justify-start">
              <span
                className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[10px] font-medium"
                style={{
                  color: 'var(--sec-accent-bright)',
                  background: 'var(--sec-accent-muted)',
                  border: '1px solid var(--sec-accent-border)',
                }}
              >
                Now · {nowTime}
              </span>
            </div>
          ) : null}
          <div
            className="relative h-12 sm:h-14 rounded-xl overflow-hidden"
            style={{ background: 'var(--sec-bg-base)', border: '1px solid var(--sec-border)' }}
          >
            {segments
              .filter((s) => s.type === 'past')
              .map((seg, i) => (
                <div
                  key={`past-${i}`}
                  className="absolute top-0 bottom-0"
                  style={{
                    left: `${seg.left}%`,
                    width: `${Math.max(seg.width, 0.5)}%`,
                    background:
                      'repeating-linear-gradient(-45deg, rgba(80,80,80,0.25), rgba(80,80,80,0.25) 4px, rgba(40,40,40,0.15) 4px, rgba(40,40,40,0.15) 8px)',
                  }}
                />
              ))}
            {segments
              .filter((s) => s.type === 'booked')
              .map((seg, i) => (
                <div
                  key={`booked-${i}`}
                  title={seg.spotsRemaining != null ? `Booked · ${seg.spotsRemaining} spots left` : seg.label}
                  className="absolute top-0 bottom-0"
                  style={{
                    left: `${seg.left}%`,
                    width: `${Math.max(seg.width, 1)}%`,
                    background:
                      'repeating-linear-gradient(-45deg, rgba(239,68,68,0.35), rgba(239,68,68,0.35) 4px, rgba(239,68,68,0.15) 4px, rgba(239,68,68,0.15) 8px)',
                    borderRight: '1px solid rgba(239,68,68,0.4)',
                  }}
                />
              ))}
            {segments
              .filter((s) => s.type === 'selected')
              .map((seg, i) => (
                <div
                  key={`selected-${i}`}
                  className="absolute top-1 bottom-1 rounded-md"
                  style={{
                    left: `${seg.left}%`,
                    width: `${Math.max(seg.width, 2)}%`,
                    background: 'var(--sec-gradient-silver)',
                    opacity: 0.85,
                    border: '1px solid var(--sec-accent)',
                    boxShadow: '0 0 12px rgba(192,192,192,0.2)',
                  }}
                />
              ))}
            {nowPct != null ? (
              <div
                className="absolute top-0 bottom-0 z-10 pointer-events-none"
                style={{ left: `${nowPct}%`, width: 2, marginLeft: -1 }}
              >
                <div className="h-full w-0.5" style={{ background: 'var(--sec-accent-bright)' }} />
              </div>
            ) : null}
          </div>
          {isMobile ? (
            <div
              className="grid text-[10px] text-[var(--sec-text-muted)]"
              style={{ gridTemplateColumns: `repeat(${Math.max(visibleTicks.length, 1)}, minmax(0, 1fr))` }}
            >
              {visibleTicks.map((tick) => (
                <span key={tick.time} className="text-center whitespace-nowrap truncate px-0.5">
                  {tick.time}
                </span>
              ))}
            </div>
          ) : (
            <div className="relative h-5 text-[11px] text-[var(--sec-text-muted)]">
              {visibleTicks.map((tick) => (
                <span
                  key={tick.time}
                  className="absolute -translate-x-1/2 whitespace-nowrap"
                  style={{ left: `${tick.pct}%` }}
                >
                  {tick.time}
                </span>
              ))}
            </div>
          )}
          <div className="flex flex-wrap gap-3 text-[10px] text-[var(--sec-text-muted)]">
            <span className="flex items-center gap-1">
              <span
                className="inline-block w-3 h-3 rounded-sm"
                style={{
                  background:
                    'repeating-linear-gradient(-45deg, rgba(80,80,80,0.4), rgba(80,80,80,0.4) 2px, transparent 2px, transparent 4px)',
                }}
              />
              Past
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-3 h-3 rounded-sm" style={{ background: 'rgba(239,68,68,0.4)' }} />
              Booked
            </span>
            <span className="flex items-center gap-1">
              <span
                className="inline-block w-3 h-3 rounded-sm"
                style={{ background: 'var(--sec-accent-muted)', border: '1px solid var(--sec-accent)' }}
              />
              Your booking
            </span>
          </div>
        </div>
      ) : null}

      {occupancy.length > 0 ? (
        <div className="space-y-2">
          {occupancy.map((o) => (
            <div
              key={o.hostedTableId || `${o.startTime}-${o.endTime}`}
              className="flex items-center gap-2 text-xs rounded-lg px-3 py-2"
              style={{ background: 'var(--sec-bg-base)', border: '1px solid var(--sec-border)' }}
            >
              <Users size={12} style={{ color: 'var(--sec-text-muted)' }} />
              <span className="text-[var(--sec-text-secondary)]">
                Booked {o.startTime}–{o.endTime}
                {o.hostName ? ` · @${String(o.hostName).replace(/^@/, '')}` : ''}
                {o.spotsRemaining != null ? ` · ${o.spotsRemaining} spots left` : ''}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {activeGap && slotsRemaining ? (
        <div className="space-y-4 -mx-1 sm:mx-0">
          <DayBookingTimeChipRail
            label="Arrive from"
            options={startOptions}
            value={value?.startTime}
            onChange={(startTime) => onChange?.({ startTime, endTime: value?.endTime || activeGap.endTime })}
          />

          <div className="space-y-2">
            <p className="text-xs font-medium tracking-wide text-[var(--sec-text-secondary)]">Duration</p>
            <DurationPills
              startTime={value?.startTime}
              endTime={value?.endTime}
              activeGap={activeGap}
              venueWindow={venueWindow}
              latestBookableEnd={latestBookableEnd}
              durationPresets={durationPresets}
              maxDurationMinutes={maxDurationMinutes}
              disabled={readOnly}
              onSelect={(endTime) => onChange?.({ startTime: value?.startTime || activeGap.startTime, endTime })}
            />
            {maxBookingDurationHours ? (
              <p className="text-[11px] text-[var(--sec-text-muted)]">
                Maximum stay: {maxBookingDurationHours} hour{maxBookingDurationHours === 1 ? '' : 's'}
              </p>
            ) : null}
          </div>

          <DayBookingTimeChipRail
            label="Leave by"
            options={endOptions}
            value={value?.endTime}
            onChange={(endTime) => onChange?.({ startTime: value?.startTime || activeGap.startTime, endTime })}
          />
        </div>
      ) : null}

      {validation ? (
        <p className="text-xs" style={{ color: 'var(--sec-error)' }}>
          {validation}
        </p>
      ) : value?.startTime && value?.endTime ? (
        <div
          className="inline-flex items-center gap-2 rounded-full px-4 py-2 text-xs font-medium"
          style={{
            border: '1px solid var(--sec-accent-border)',
            background: 'var(--sec-accent-muted)',
            color: 'var(--sec-accent-bright)',
          }}
        >
          <Clock size={12} />
          <span>
            {value.startTime} – {value.endTime}
            {formatDurationLabel(value.startTime, value.endTime, venueWindow)
              ? ` · ${formatDurationLabel(value.startTime, value.endTime, venueWindow)}`
              : ''}
          </span>
        </div>
      ) : null}
    </div>
  );
}
