"use client";

import { useState, useRef, useEffect } from "react";
import { Check, Clock, Copy, Pencil, X } from "lucide-react";

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
    const tg = (window as any).Telegram?.WebApp;
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
    <div className="flex items-center gap-3 py-3 px-4 bg-tg-bg">
      <button
        onClick={(e) => {
          e.stopPropagation();
          handleToggle();
        }}
        className={`w-6 h-6 rounded-full border-2 flex items-center justify-center shrink-0 transition-colors ${
          completed
            ? "bg-tg-button border-tg-button"
            : "border-tg-hint"
        }`}
      >
        {completed && <Check className="w-4 h-4 text-tg-button-text" />}
      </button>

      <div className={`flex-1 min-w-0 ${isPending ? "opacity-60" : ""}`}>
        {isEditing && !completed ? (
          <input
            ref={inputRef}
            type="text"
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            onBlur={handleSave}
            onKeyDown={handleKeyDown}
            onPointerDown={(e) => e.stopPropagation()}
            className="w-full bg-transparent text-tg-text outline-none border-b border-tg-button py-0.5"
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
              {isDuplicate && !completed && (
                <Copy className="w-3 h-3 text-amber-500/70 shrink-0" />
              )}
            </div>
            {((creatorName && !isOwnItem) || (editorName && !isOwnEdit)) && (
              <p className="text-[11px] text-tg-hint truncate">
                {creatorName && !isOwnItem && creatorName.split(" ")[0]}
                {creatorName && !isOwnItem && editorName && !isOwnEdit && " · "}
                {editorName && !isOwnEdit && (
                  <>
                    <Pencil className="inline w-2.5 h-2.5 mr-0.5" />
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

      <button
        onClick={(e) => {
          e.stopPropagation();
          onDelete(id);
        }}
        className="p-1 shrink-0"
      >
        <X className="w-4 h-4 text-tg-hint" />
      </button>
    </div>
  );
}
