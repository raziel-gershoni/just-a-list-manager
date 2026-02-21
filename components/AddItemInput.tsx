"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { useTranslations } from "next-intl";
import { Plus, Loader2 } from "lucide-react";
import { useTelegram } from "./TelegramProvider";

interface RecyclableItem {
  id: string;
  text: string;
}

interface AddItemInputProps {
  listId: string;
  onAddItem: (text: string, recycleId?: string) => void;
}

export default function AddItemInput({ listId, onAddItem }: AddItemInputProps) {
  const { jwtRef } = useTelegram();
  const t = useTranslations();
  const [value, setValue] = useState("");
  const [suggestions, setSuggestions] = useState<RecyclableItem[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const debounceRef = useRef<NodeJS.Timeout | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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

    const tg = (window as any).Telegram?.WebApp;
    tg?.HapticFeedback?.notificationOccurred("success");

    onAddItem(value.trim());
    setValue("");
    setSuggestions([]);
    setShowSuggestions(false);
    inputRef.current?.focus();
  };

  const handleSuggestionClick = (item: RecyclableItem) => {
    const tg = (window as any).Telegram?.WebApp;
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
      handleSubmit();
    }
  };

  // Close suggestions when clicking outside
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (
        inputRef.current &&
        !inputRef.current.parentElement?.contains(e.target as Node)
      ) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener("click", handleClick);
    return () => document.removeEventListener("click", handleClick);
  }, []);

  return (
    <div className="z-10 bg-tg-bg border-b border-border p-3">
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
              placeholder={t('items.addPlaceholder')}
              className="w-full px-4 py-2.5 rounded-xl bg-tg-secondary-bg text-tg-text placeholder:text-tg-hint outline-none text-base"
            />
            {isSearching && (
              <Loader2 className="absolute end-3 top-1/2 -translate-y-1/2 w-4 h-4 text-tg-hint animate-spin" />
            )}
          </div>
          <button
            onClick={handleSubmit}
            disabled={!value.trim()}
            className="px-4 py-2.5 rounded-xl bg-tg-button text-tg-button-text font-medium disabled:opacity-40 active:opacity-80 transition-opacity"
          >
            <Plus className="w-5 h-5" />
          </button>
        </div>

        {/* Autocomplete suggestions */}
        {showSuggestions && suggestions.length > 0 && (
          <div className="absolute top-full start-0 end-0 mt-1 bg-tg-section-bg rounded-xl shadow-lg border border-border overflow-hidden z-20">
            {suggestions.map((item) => (
              <button
                key={item.id}
                onClick={() => handleSuggestionClick(item)}
                className="w-full px-4 py-3 text-start text-tg-text hover:bg-tg-secondary-bg active:bg-tg-secondary-bg transition-colors border-b border-border last:border-b-0"
              >
                {item.text}
                <span className="text-xs text-tg-hint ms-2">{t('items.recycled')}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
