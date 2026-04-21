"use client";

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

interface TimePickerProps {
  hour: number;
  minute: number;
  onHourChange: (hour: number) => void;
  onMinuteChange: (minute: number) => void;
}

export default function TimePicker({ hour, minute, onHourChange, onMinuteChange }: TimePickerProps) {
  const haptic = () => {
    try { (window as any).Telegram?.WebApp?.HapticFeedback?.selectionChanged(); } catch {}
  };

  return (
    <div dir="ltr" className="time-picker-wrapper">
      <WheelPickerWrapper className="time-picker">
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
