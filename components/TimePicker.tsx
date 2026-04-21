"use client";

import { useMemo } from "react";
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
  todayLabel: string;
  tomorrowLabel: string;
}

function buildDateOptions(todayLabel: string, tomorrowLabel: string) {
  const options: { value: string; label: string }[] = [];
  const now = new Date();
  for (let i = 0; i < 30; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() + i);
    const value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    let label: string;
    if (i === 0) label = todayLabel;
    else if (i === 1) label = tomorrowLabel;
    else label = d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
    options.push({ value, label });
  }
  return options;
}

export default function DateTimePicker({
  date, hour, minute,
  onDateChange, onHourChange, onMinuteChange,
  todayLabel, tomorrowLabel,
}: DateTimePickerProps) {
  const dateOptions = useMemo(
    () => buildDateOptions(todayLabel, tomorrowLabel),
    [todayLabel, tomorrowLabel]
  );

  const haptic = () => {
    try { (window as any).Telegram?.WebApp?.HapticFeedback?.selectionChanged(); } catch {}
  };

  return (
    <div dir="ltr" className="time-picker-wrapper">
      <WheelPickerWrapper className="time-picker">
        <WheelPicker
          value={date}
          onValueChange={(v) => { onDateChange(v); haptic(); }}
          options={dateOptions}
          optionItemHeight={36}
          visibleCount={20}
        />
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
  );
}
