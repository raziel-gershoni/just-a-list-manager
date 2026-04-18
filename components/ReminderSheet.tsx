"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Bell, X } from "lucide-react";

interface ReminderSheetProps {
  itemId: string;
  itemText: string;
  listId: string;
  isShared: boolean;
  isOpen: boolean;
  onClose: () => void;
  onSetReminder: (itemId: string, remindAt: string, isShared: boolean, recurrence?: string) => void;
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
  onCancelReminder,
  existingReminder,
}: ReminderSheetProps) {
  const t = useTranslations("reminder");
  const [customDateTime, setCustomDateTime] = useState("");
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
    if (!customDateTime) return;
    const remindAt = new Date(customDateTime).toISOString();
    onSetReminder(itemId, remindAt, sharedReminder, recurrence);
    onClose();
  };

  const handleCancel = () => {
    if (existingReminder) {
      onCancelReminder(itemId, existingReminder.id);
    }
    onClose();
  };

  const computeIn30Min = () => {
    const d = new Date();
    d.setMinutes(d.getMinutes() + 30);
    return d.toISOString();
  };

  const computeIn1Hour = () => {
    const d = new Date();
    d.setHours(d.getHours() + 1);
    return d.toISOString();
  };

  const computeIn3Hours = () => {
    const d = new Date();
    d.setHours(d.getHours() + 3);
    return d.toISOString();
  };

  const computeTomorrow9am = () => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    return d.toISOString();
  };

  const pillBase = "px-4 py-2 rounded-full text-sm font-medium transition-colors";
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
        className="bg-tg-bg w-full max-w-lg rounded-t-3xl p-6 pt-3 max-h-[80vh] overflow-y-auto sheet-enter"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="w-10 h-1 rounded-full bg-tg-hint/30 mx-auto mb-4" />
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2 min-w-0">
            <Bell className="w-5 h-5 text-tg-link shrink-0" />
            <div className="min-w-0">
              <h2 className="text-lg font-semibold tracking-tight text-tg-text">{t("title")}</h2>
              <p className="text-sm text-tg-hint truncate">{itemText}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 rounded-full active:bg-tg-secondary-bg shrink-0">
            <X className="w-5 h-5 text-tg-hint" />
          </button>
        </div>

        {/* Existing reminder */}
        {existingReminder && (
          <div className="mb-4 p-4 bg-tg-secondary-bg rounded-2xl">
            <p className="text-sm text-tg-text">
              {t("active", { time: formatExistingTime(existingReminder.remind_at) })}
            </p>
            <button
              onClick={handleCancel}
              className="mt-2 px-4 py-1.5 rounded-full text-sm font-medium bg-tg-destructive/10 text-tg-destructive"
            >
              {t("cancel")}
            </button>
          </div>
        )}

        {/* Quick presets */}
        <div className="flex flex-wrap gap-2 mb-5">
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

        {/* Custom picker */}
        <div className="mb-5">
          <p className="text-sm text-tg-hint mb-2">{t("customTime")}</p>
          <div className="flex gap-2">
            <input
              type="datetime-local"
              value={customDateTime}
              onChange={(e) => setCustomDateTime(e.target.value)}
              className="flex-1 bg-tg-secondary-bg text-tg-text rounded-xl px-3 py-2.5 text-sm"
            />
            <button
              onClick={handleCustomSet}
              disabled={!customDateTime}
              className="px-4 py-2.5 rounded-xl bg-tg-button text-tg-button-text text-sm font-medium disabled:opacity-50"
            >
              {t("set")}
            </button>
          </div>
        </div>

        {/* Recurrence */}
        <div className="mb-5">
          <div className="flex flex-wrap gap-2">
            {recurrenceOptions.map((opt) => (
              <button
                key={opt.key}
                onClick={() => setRecurrence(opt.value)}
                className={`${pillBase} ${
                  recurrence === opt.value ? pillSelected : pillUnselected
                }`}
              >
                {t(opt.key)}
              </button>
            ))}
          </div>
        </div>

        {/* Visibility — only for shared lists */}
        {isShared && (
          <div className="flex gap-2">
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
          </div>
        )}
      </div>
    </div>
  );
}
