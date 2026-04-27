"use client";

import { useMemo } from "react";
import { useLocale } from "next-intl";
import { WheelPicker, WheelPickerWrapper } from "@ncdai/react-wheel-picker";
import "@ncdai/react-wheel-picker/style.css";

const pad = (n: number) => String(n).padStart(2, "0");

const hourOptions = Array.from({ length: 24 }, (_, i) => ({
  value: String(i),
  label: pad(i),
}));

const minuteOptions = Array.from({ length: 12 }, (_, i) => ({
  value: String(i * 5),
  label: pad(i * 5),
}));

interface DateTimePickerProps {
  date: string; // "YYYY-MM-DD"
  hour: number;
  minute: number;
  onDateChange: (date: string) => void;
  onHourChange: (hour: number) => void;
  onMinuteChange: (minute: number) => void;
}

function daysInMonth(year: number, month: number): number {
  // month is 1-12; new Date(y, m, 0) gives last day of month m (1-indexed)
  return new Date(year, month, 0).getDate();
}

function clampDate(year: number, month: number, day: number): { year: number; month: number; day: number } {
  const max = daysInMonth(year, month);
  return { year, month, day: Math.min(day, max) };
}

function parseISODate(iso: string): { year: number; month: number; day: number } {
  const [y, m, d] = iso.split("-").map(Number);
  return { year: y, month: m, day: d };
}

function toISODate(year: number, month: number, day: number): string {
  return `${year}-${pad(month)}-${pad(day)}`;
}

export default function DateTimePicker({
  date, hour, minute,
  onDateChange, onHourChange, onMinuteChange,
}: DateTimePickerProps) {
  const locale = useLocale();
  const { year, month, day } = parseISODate(date);

  const yearOptions = useMemo(() => {
    const currentYear = new Date().getFullYear();
    return Array.from({ length: 11 }, (_, i) => {
      const y = currentYear - 5 + i;
      return { value: String(y), label: String(y) };
    });
  }, []);

  const monthOptions = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(locale, { month: "short" });
    return Array.from({ length: 12 }, (_, i) => ({
      value: String(i + 1),
      label: fmt.format(new Date(2025, i, 1)),
    }));
  }, [locale]);

  const dayOptions = useMemo(() => {
    const max = daysInMonth(year, month);
    const fmt = new Intl.DateTimeFormat(locale, { weekday: "short" });
    return Array.from({ length: max }, (_, i) => {
      const n = i + 1;
      const wd = fmt.format(new Date(year, month - 1, n));
      return {
        value: String(n),
        label: `${wd} ${pad(n)}`,
      };
    });
  }, [year, month, locale]);

  const haptic = () => {
    try { (window as any).Telegram?.WebApp?.HapticFeedback?.selectionChanged(); } catch {}
  };

  const updateDate = (y: number, m: number, d: number) => {
    const clamped = clampDate(y, m, d);
    onDateChange(toISODate(clamped.year, clamped.month, clamped.day));
  };

  return (
    <div className="time-picker-wrapper">
      <div dir="ltr">
        <WheelPickerWrapper className="time-picker">
          <WheelPicker
            value={String(day)}
            onValueChange={(v) => { updateDate(year, month, Number(v)); haptic(); }}
            options={dayOptions}
            optionItemHeight={36}
            visibleCount={20}
          />
          <WheelPicker
            value={String(month)}
            onValueChange={(v) => { updateDate(year, Number(v), day); haptic(); }}
            options={monthOptions}
            optionItemHeight={36}
            visibleCount={20}
          />
          <WheelPicker
            value={String(year)}
            onValueChange={(v) => { updateDate(Number(v), month, day); haptic(); }}
            options={yearOptions}
            optionItemHeight={36}
            visibleCount={20}
          />
          <div className="time-picker-divider" aria-hidden />
          <WheelPicker
            value={String(hour)}
            onValueChange={(v) => { onHourChange(Number(v)); haptic(); }}
            options={hourOptions}
            optionItemHeight={36}
            visibleCount={20}
          />
          <div className="time-picker-colon">:</div>
          <WheelPicker
            value={String(minute)}
            onValueChange={(v) => { onMinuteChange(Number(v)); haptic(); }}
            options={minuteOptions}
            optionItemHeight={36}
            visibleCount={20}
          />
        </WheelPickerWrapper>
      </div>
    </div>
  );
}
