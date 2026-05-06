"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { X } from "lucide-react";
import DateTimePicker from "@/components/TimePicker";

interface ReminderSheetProps {
  itemId: string;
  itemText: string;
  listId: string;
  isShared: boolean;
  isOpen: boolean;
  onClose: () => void;
  onSetReminder: (itemId: string, remindAt: string, isShared: boolean, recurrence?: string) => void;
  onUpdateReminder?: (itemId: string, reminderId: string, updates: { recurrence?: string; is_shared?: boolean }) => void;
  onCancelReminder: (itemId: string, reminderId: string) => void;
  existingReminder?: { id: string; remind_at: string; is_shared: boolean; recurrence?: string } | null;
}

export default function ReminderSheet({
  itemId,
  itemText,
  listId,
  isShared,
  isOpen,
  onClose,
  onSetReminder,
  onUpdateReminder,
  onCancelReminder,
  existingReminder,
}: ReminderSheetProps) {
  const t = useTranslations("reminder");
  const [picker, setPicker] = useState(() => {
    const d = existingReminder?.remind_at ? new Date(existingReminder.remind_at) : new Date(Date.now() + 60 * 60 * 1000);
    if (!existingReminder?.remind_at) d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5, 0, 0);
    const pad = (n: number) => String(n).padStart(2, "0");
    return {
      date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
      hour: d.getHours(),
      minute: d.getMinutes(),
    };
  });
  const [recurrence, setRecurrence] = useState<string | undefined>(
    existingReminder?.recurrence ?? undefined
  );
  const [sharedReminder, setSharedReminder] = useState(
    existingReminder?.is_shared ?? false
  );

  if (!isOpen) return null;

  const handlePreset = (remindAt: string) => {
    onSetReminder(itemId, remindAt, sharedReminder, recurrence);
    onClose();
  };

  const handleCustomSet = () => {
    if (!picker.date) return;
    const pad = (n: number) => String(n).padStart(2, "0");
    const remindAt = new Date(`${picker.date}T${pad(picker.hour)}:${pad(picker.minute)}`).toISOString();
    onSetReminder(itemId, remindAt, sharedReminder, recurrence);
    onClose();
  };

  const handleCancel = () => {
    if (existingReminder) {
      onCancelReminder(itemId, existingReminder.id);
    }
    onClose();
  };

  const round5 = (d: Date) => { d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5, 0, 0); return d; };

  const computeIn30Min = () => {
    const d = new Date();
    d.setMinutes(d.getMinutes() + 30);
    return round5(d).toISOString();
  };

  const computeIn1Hour = () => {
    const d = new Date();
    d.setHours(d.getHours() + 1);
    return round5(d).toISOString();
  };

  const computeIn3Hours = () => {
    const d = new Date();
    d.setHours(d.getHours() + 3);
    return round5(d).toISOString();
  };

  const computeTomorrow9am = () => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    return d.toISOString();
  };

  const pillBase = "px-3 py-1.5 rounded-full text-[13px] font-medium transition-colors";
  const pillSelected = "bg-tg-button text-tg-button-text";
  const pillUnselected = "bg-tg-secondary-bg text-tg-text";

  const recurrenceOptions: { key: string; value: string | undefined }[] = [
    { key: "once", value: undefined },
    { key: "daily", value: "daily" },
    { key: "weekly", value: "weekly" },
    { key: "monthly", value: "monthly" },
  ];

  const formatExistingTime = (iso: string) => {
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-sm backdrop-enter"
      onClick={onClose}
    >
      <div
        className="bg-tg-bg w-full max-w-lg rounded-t-3xl pt-3 max-h-[85vh] flex flex-col sheet-enter"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="w-10 h-1 rounded-full bg-tg-hint/30 mx-auto mb-3 shrink-0" />

        {/* Compact header — just item text + close */}
        <div className="flex items-center gap-2 px-5 mb-3 shrink-0">
          <p className="flex-1 min-w-0 truncate text-sm font-medium text-tg-text">{itemText}</p>
          <button onClick={onClose} className="p-1.5 -m-1.5 rounded-full active:bg-tg-secondary-bg shrink-0">
            <X className="w-5 h-5 text-tg-hint" />
          </button>
        </div>

        {/* Scrollable middle: existing reminder badge, presets, picker, recurrence, visibility */}
        <div className="flex-1 overflow-y-auto px-5 pb-3">
          {/* Existing reminder — compact inline badge */}
          {existingReminder && (
            <div className="flex items-center gap-2 mb-3 py-1.5 px-3 bg-tg-secondary-bg rounded-full">
              <span className="text-[13px] text-tg-text flex-1 truncate">
                {t("active", { time: formatExistingTime(existingReminder.remind_at) })}
              </span>
              <button
                onClick={handleCancel}
                className="text-[12px] font-medium text-tg-destructive shrink-0 px-2 -mx-1"
              >
                {t("cancel")}
              </button>
            </div>
          )}

          {/* Quick presets */}
          <div className="flex flex-wrap gap-1.5 mb-3">
            <button
              onClick={() => handlePreset(computeIn30Min())}
              className={`${pillBase} ${pillUnselected}`}
            >
              {t("in30min")}
            </button>
            <button
              onClick={() => handlePreset(computeIn1Hour())}
              className={`${pillBase} ${pillUnselected}`}
            >
              {t("in1hour")}
            </button>
            <button
              onClick={() => handlePreset(computeIn3Hours())}
              className={`${pillBase} ${pillUnselected}`}
            >
              {t("in3hours")}
            </button>
            <button
              onClick={() => handlePreset(computeTomorrow9am())}
              className={`${pillBase} ${pillUnselected}`}
            >
              {t("tomorrow9am")}
            </button>
          </div>

          {/* Picker — focal surface, no label needed */}
          <DateTimePicker
            date={picker.date}
            hour={picker.hour}
            minute={picker.minute}
            onDateChange={(d) => setPicker(p => ({ ...p, date: d }))}
            onHourChange={(h) => setPicker(p => ({ ...p, hour: h }))}
            onMinuteChange={(m) => setPicker(p => ({ ...p, minute: m }))}
          />

          {/* Recurrence + visibility on a single wrapping row */}
          <div className="flex flex-wrap gap-1.5 mt-3">
            {recurrenceOptions.map((opt) => (
              <button
                key={opt.key}
                onClick={() => {
                  setRecurrence(opt.value);
                  if (existingReminder && onUpdateReminder) {
                    onUpdateReminder(itemId, existingReminder.id, { recurrence: opt.value });
                  }
                }}
                className={`${pillBase} ${
                  recurrence === opt.value ? pillSelected : pillUnselected
                }`}
              >
                {t(opt.key)}
              </button>
            ))}
            {isShared && (
              <>
                <div className="w-px self-stretch bg-tg-hint/20 mx-1" />
                <button
                  onClick={() => setSharedReminder(false)}
                  className={`${pillBase} ${!sharedReminder ? pillSelected : pillUnselected}`}
                >
                  {t("justMe")}
                </button>
                <button
                  onClick={() => setSharedReminder(true)}
                  className={`${pillBase} ${sharedReminder ? pillSelected : pillUnselected}`}
                >
                  {t("everyone")}
                </button>
              </>
            )}
          </div>
        </div>

        {/* Sticky CTA */}
        <div className="px-5 pt-2 pb-5 border-t border-separator shrink-0">
          <button
            onClick={handleCustomSet}
            disabled={!picker.date}
            className="w-full py-3 rounded-2xl bg-tg-button text-tg-button-text text-[15px] font-semibold disabled:opacity-50 active:scale-[0.99] transition-transform"
          >
            {t("set")}
          </button>
        </div>
      </div>
    </div>
  );
}
