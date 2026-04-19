"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { useTranslations } from "next-intl";
import { Plus, Loader2 } from "lucide-react";
import { useTelegram } from "./TelegramProvider";
import { getTelegramWebApp } from "@/src/types/telegram";

interface RecyclableItem {
  id: string;
  text: string;
}

interface AddItemInputProps {
  listId: string;
  listType?: "regular" | "reminders" | "grocery";
  onAddItem: (text: string, recycleId?: string) => void;
  onAddItemWithReminder?: (text: string, remindAt: string) => void;
}

export default function AddItemInput({ listId, listType = "regular", onAddItem, onAddItemWithReminder }: AddItemInputProps) {
  const { jwtRef } = useTelegram();
  const t = useTranslations();
  const [value, setValue] = useState("");
  const [suggestions, setSuggestions] = useState<RecyclableItem[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [showCustomPicker, setShowCustomPicker] = useState(false);
  const [customDateTime, setCustomDateTime] = useState("");
  const debounceRef = useRef<NodeJS.Timeout | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const isReminders = listType === "reminders";

  const searchItems = useCallback(
    async (query: string) => {
      const jwt = jwtRef.current;
      if (!query.trim() || !jwt) {
        setSuggestions([]);
        setIsSearching(false);
        return;
      }

      setIsSearching(true);
      try {
        const res = await fetch(
          `/api/lists/${listId}/items/search?q=${encodeURIComponent(query.trim())}`,
          { headers: { Authorization: `Bearer ${jwt}` } }
        );
        if (res.ok) {
          const { items } = await res.json();
          setSuggestions(items || []);
          setShowSuggestions((items || []).length > 0);
        }
      } catch {
        setSuggestions([]);
      } finally {
        setIsSearching(false);
      }
    },
    [listId, jwtRef]
  );

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setValue(val);

    // Get the current segment (after last comma)
    const segments = val.split(",");
    const currentSegment = segments[segments.length - 1].trim();

    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (currentSegment.length > 0) {
      debounceRef.current = setTimeout(() => searchItems(currentSegment), 400);
    } else {
      setSuggestions([]);
      setShowSuggestions(false);
    }
  };

  const handleSubmit = () => {
    if (!value.trim()) return;

    const tg = getTelegramWebApp();
    tg?.HapticFeedback?.notificationOccurred("success");

    onAddItem(value.trim());
    setValue("");
    setSuggestions([]);
    setShowSuggestions(false);
    setShowCustomPicker(false);
    inputRef.current?.focus();
  };

  const handleSubmitWithTime = (remindAt: string) => {
    if (!value.trim() || !onAddItemWithReminder) return;

    const tg = getTelegramWebApp();
    tg?.HapticFeedback?.notificationOccurred("success");

    onAddItemWithReminder(value.trim(), remindAt);
    setValue("");
    setCustomDateTime("");
    setSuggestions([]);
    setShowSuggestions(false);
    setShowCustomPicker(false);
    inputRef.current?.focus();
  };

  const getTodayEvening = () => {
    const d = new Date();
    d.setHours(18, 0, 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
    return d.toISOString();
  };

  const getTomorrowMorning = () => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    return d.toISOString();
  };

  const handleSuggestionClick = (item: RecyclableItem) => {
    const tg = getTelegramWebApp();
    tg?.HapticFeedback?.notificationOccurred("success");

    // If comma-separated, replace only the current segment
    const segments = value.split(",");
    if (segments.length > 1) {
      segments.pop(); // Remove current segment
      // Submit completed segments as new items
      for (const seg of segments) {
        if (seg.trim()) onAddItem(seg.trim());
      }
    }

    // Recycle the selected item
    onAddItem(item.text, item.id);
    setValue("");
    setSuggestions([]);
    setShowSuggestions(false);
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (isReminders) {
        // For reminders lists, Enter with text defaults to today evening
        if (value.trim()) handleSubmitWithTime(getTodayEvening());
      } else {
        handleSubmit();
      }
    }
  };

  // Close suggestions when clicking outside
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (
        inputRef.current &&
        !inputRef.current.parentElement?.parentElement?.contains(e.target as Node)
      ) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener("click", handleClick);
    return () => document.removeEventListener("click", handleClick);
  }, []);

  return (
    <div className="z-10 bg-tg-bg border-b border-separator px-5 py-3.5">
      <div className="relative">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <input
              ref={inputRef}
              type="text"
              value={value}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              onFocus={() => {
                if (suggestions.length > 0) setShowSuggestions(true);
              }}
              placeholder={isReminders ? t('items.addReminderPlaceholder') : t('items.addPlaceholder')}
              className="w-full px-4 py-3 rounded-2xl bg-tg-secondary-bg text-tg-text placeholder:text-tg-hint/70 outline-none text-base focus:ring-2 focus:ring-tg-button/20"
            />
            {isSearching && (
              <Loader2 className="absolute end-3 top-1/2 -translate-y-1/2 w-4 h-4 text-tg-hint animate-spin" />
            )}
          </div>
          {!isReminders && (
            <button
              onClick={handleSubmit}
              disabled={!value.trim()}
              className="px-4 py-3 rounded-2xl bg-tg-button text-tg-button-text font-medium disabled:opacity-30 active:scale-95"
            >
              <Plus className="w-5 h-5" />
            </button>
          )}
        </div>

        {/* Time preset pills for reminders lists */}
        {isReminders && (
          <div className="flex gap-2 mt-2">
            <button
              onClick={() => handleSubmitWithTime(getTodayEvening())}
              disabled={!value.trim()}
              className="px-3 py-1.5 rounded-full text-sm font-medium bg-tg-secondary-bg text-tg-text disabled:opacity-30 active:scale-95"
            >
              {t('items.todayEvening')}
            </button>
            <button
              onClick={() => handleSubmitWithTime(getTomorrowMorning())}
              disabled={!value.trim()}
              className="px-3 py-1.5 rounded-full text-sm font-medium bg-tg-secondary-bg text-tg-text disabled:opacity-30 active:scale-95"
            >
              {t('items.tomorrowMorning')}
            </button>
            <button
              onClick={() => setShowCustomPicker(!showCustomPicker)}
              disabled={!value.trim()}
              className="px-3 py-1.5 rounded-full text-sm font-medium bg-tg-secondary-bg text-tg-text disabled:opacity-30 active:scale-95"
            >
              {t('items.custom')}
            </button>
          </div>
        )}

        {/* Custom datetime picker */}
        {isReminders && showCustomPicker && (
          <div className="flex gap-2 mt-2">
            <input
              type="datetime-local"
              value={customDateTime}
              onChange={(e) => setCustomDateTime(e.target.value)}
              className="flex-1 bg-tg-secondary-bg text-tg-text rounded-xl px-3 py-2.5 text-sm"
            />
            <button
              onClick={() => {
                if (customDateTime) {
                  handleSubmitWithTime(new Date(customDateTime).toISOString());
                }
              }}
              disabled={!customDateTime || !value.trim()}
              className="px-4 py-2.5 rounded-xl bg-tg-button text-tg-button-text text-sm font-medium disabled:opacity-30 active:scale-95"
            >
              <Plus className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Autocomplete suggestions */}
        {showSuggestions && suggestions.length > 0 && (
          <div className="absolute top-full start-0 end-0 mt-2 bg-tg-section-bg rounded-2xl shadow-xl shadow-black/8 dark:shadow-black/25 border border-border/50 overflow-hidden z-20">
            {suggestions.map((item) => (
              <button
                key={item.id}
                onClick={() => handleSuggestionClick(item)}
                className="w-full px-4 py-3.5 text-start text-tg-text active:bg-tg-secondary-bg transition-colors border-b border-separator last:border-b-0"
              >
                {item.text}
                <span className="text-[11px] text-tg-hint/70 ms-2 tracking-wide">{t('items.recycled')}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
