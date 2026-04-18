"use client";

import { useState, useRef, useEffect } from "react";
import { Bell, Check, CircleOff, Clock, Copy, Pencil, RotateCcw, X } from "lucide-react";
import { getTelegramWebApp } from "@/src/types/telegram";

interface ItemRowProps {
  id: string;
  text: string;
  completed: boolean;
  isPending?: boolean;
  isDuplicate?: boolean;
  creatorName?: string | null;
  isOwnItem?: boolean;
  editorName?: string | null;
  isOwnEdit?: boolean;
  onToggle: (id: string, completed: boolean) => void;
  onDelete: (id: string) => void;
  onEdit?: (id: string, newText: string) => void;
  skipped?: boolean;
  onSkip?: (id: string, skipped: boolean) => void;
  onRemoveDuplicates?: (text: string) => void;
  reminderAt?: string | null;
  onReminderTap?: (id: string) => void;
}

export default function ItemRow({
  id,
  text,
  completed,
  isPending,
  isDuplicate,
  creatorName,
  isOwnItem,
  editorName,
  isOwnEdit,
  onToggle,
  onDelete,
  onEdit,
  skipped,
  onSkip,
  onRemoveDuplicates,
  reminderAt,
  onReminderTap,
}: ItemRowProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState(text);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const handleToggle = () => {
    const tg = getTelegramWebApp();
    tg?.HapticFeedback?.impactOccurred("light");
    onToggle(id, !completed);
  };

  const handleSave = () => {
    const trimmed = editText.trim();
    if (trimmed && trimmed !== text && onEdit) {
      onEdit(id, trimmed);
    }
    setIsEditing(false);
    setEditText(text);
  };

  const handleCancel = () => {
    setIsEditing(false);
    setEditText(text);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSave();
    } else if (e.key === "Escape") {
      e.preventDefault();
      handleCancel();
    }
  };

  return (
    <div className="flex items-center gap-3 py-3.5 px-5 border-b border-separator">
      <button
        onClick={(e) => {
          e.stopPropagation();
          handleToggle();
        }}
        className={`w-[22px] h-[22px] rounded-full flex items-center justify-center shrink-0 transition-all duration-200 ${
          completed
            ? "bg-tg-button border-[1.5px] border-tg-button"
            : "border-[1.5px] border-tg-hint/60"
        }`}
      >
        {completed && <Check className="w-3.5 h-3.5 text-tg-button-text" />}
      </button>

      <div className={`flex-1 min-w-0 ${isPending ? "opacity-60" : ""} ${skipped ? "opacity-50" : ""}`}>
        {isEditing && !completed ? (
          <input
            ref={inputRef}
            type="text"
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            onBlur={handleSave}
            onKeyDown={handleKeyDown}
            onPointerDown={(e) => e.stopPropagation()}
            className="w-full bg-transparent text-tg-text outline-none border-b-2 border-tg-button/60 py-1"
            maxLength={500}
          />
        ) : (
          <div
            onClick={() => {
              if (!completed && onEdit) {
                setEditText(text);
                setIsEditing(true);
              }
            }}
          >
            <div className="flex items-center gap-1.5">
              <span
                className={`truncate ${
                  completed ? "line-through text-tg-hint" : "text-tg-text"
                }`}
              >
                {text}
              </span>
              {isDuplicate && (
                onRemoveDuplicates ? (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onRemoveDuplicates(text);
                    }}
                    className="shrink-0 p-0.5 -m-0.5 rounded active:bg-amber-500/20"
                  >
                    <Copy className="w-3 h-3 text-amber-500/70" />
                  </button>
                ) : (
                  <Copy className="w-3 h-3 text-amber-500/70 shrink-0" />
                )
              )}
            </div>
            {((creatorName && !isOwnItem) || (editorName && !isOwnEdit)) && (
              <p className="text-[11px] text-tg-hint tracking-wide truncate">
                {creatorName && !isOwnItem && creatorName.split(" ")[0]}
                {creatorName && !isOwnItem && editorName && !isOwnEdit && " · "}
                {editorName && !isOwnEdit && (
                  <>
                    <Pencil className="inline w-2.5 h-2.5 me-0.5" />
                    {editorName.split(" ")[0]}
                  </>
                )}
              </p>
            )}
          </div>
        )}
      </div>

      {isPending && (
        <Clock className="w-4 h-4 text-tg-hint shrink-0" />
      )}

      {onSkip && !completed && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            const tg = getTelegramWebApp();
            tg?.HapticFeedback?.impactOccurred("light");
            onSkip(id, !skipped);
          }}
          className="p-1.5 rounded-full shrink-0"
        >
          {skipped ? (
            <RotateCcw className="w-[18px] h-[18px] text-tg-link" />
          ) : (
            <CircleOff className="w-[18px] h-[18px] text-tg-hint" />
          )}
        </button>
      )}

      {onReminderTap && !completed && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onReminderTap(id);
          }}
          className="p-1.5 rounded-full shrink-0"
        >
          <Bell className={`w-[18px] h-[18px] ${reminderAt ? "text-tg-link" : "text-tg-hint"}`} />
        </button>
      )}

      <button
        onClick={(e) => {
          e.stopPropagation();
          onDelete(id);
        }}
        className="p-1.5 rounded-full shrink-0"
      >
        <X className="w-[18px] h-[18px] text-tg-hint/60 active:text-tg-destructive" />
      </button>
    </div>
  );
}
