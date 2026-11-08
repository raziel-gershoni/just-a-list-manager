"use client";

import { useState, useRef, useEffect } from "react";
import { useTranslations } from "next-intl";
import { Check, Clock, Copy, Pencil, Repeat, RotateCcw, Truck, X } from "lucide-react";
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
  ordered?: boolean;
  recurring?: boolean;
  /** Grocery lists only: the item's quantity, shown at the end of the row. */
  quantity?: string | null;
  /** Grocery lists only: a tap on the row opens the item sheet instead of the inline editor. */
  onOpenDetails?: (id: string) => void;
  onRemoveDuplicates?: (text: string) => void;
  isExiting?: boolean;
  isJustAdded?: boolean;
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
  ordered,
  recurring,
  quantity,
  onOpenDetails,
  onRemoveDuplicates,
  isExiting,
  isJustAdded,
}: ItemRowProps) {
  const t = useTranslations("items");
  // A grocery row: the name opens the item sheet, which holds every action, so the row itself
  // carries only the circle, the marks and the quantity.
  const sheetMode = !!onOpenDetails;
  // A completed row shows its quantity too, read-only.
  const showQty = !!quantity && (sheetMode || completed);
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState(text);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  // The edit box grows with its text, so a long item is edited in full rather than
  // scrolled sideways in a one-line field.
  useEffect(() => {
    const box = inputRef.current;
    if (!isEditing || !box) return;
    box.style.height = "auto";
    box.style.height = `${box.scrollHeight}px`;
  }, [isEditing, editText]);

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
    <div className={`flex items-start gap-3 py-3.5 px-5 border-b border-separator ${isExiting ? "item-exit" : ""} ${isJustAdded ? "item-enter" : ""}`}>
      <button
        onClick={(e) => {
          e.stopPropagation();
          handleToggle();
        }}
        className={`w-[22px] h-[22px] mt-1 rounded-full flex items-center justify-center shrink-0 transition-all duration-200 ${
          completed
            ? "bg-tg-button border-[1.5px] border-tg-button"
            : "border-[1.5px] border-tg-hint/60"
        }`}
      >
        {completed && <Check className="w-3.5 h-3.5 text-tg-button-text" />}
      </button>

      <div className={`flex-1 min-w-0 ${isEditing && !completed ? "" : "pt-[3px]"} ${isPending ? "opacity-60" : ""} ${skipped ? "opacity-50" : ""}`}>
        {isEditing && !completed ? (
          <textarea
            ref={inputRef}
            rows={1}
            value={editText}
            // An item is one line of text: a pasted line break becomes a space.
            onChange={(e) => setEditText(e.target.value.replace(/[^\S\r\n]*[\r\n]+[^\S\r\n]*/g, " "))}
            onBlur={handleSave}
            onKeyDown={handleKeyDown}
            onPointerDown={(e) => e.stopPropagation()}
            className="block w-full resize-none overflow-hidden wrap-anywhere bg-transparent text-tg-text outline-none border-b-2 border-tg-button/60 py-1"
            maxLength={500}
          />
        ) : (
          <div
            {...(sheetMode
              ? {
                  role: "button",
                  tabIndex: 0,
                  "aria-haspopup": "dialog" as const,
                  onKeyDown: (e: React.KeyboardEvent) => {
                    // Keys from the Remove duplicates button inside must reach that button.
                    if (e.target !== e.currentTarget) return;
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onOpenDetails!(id);
                    }
                  },
                }
              : {})}
            onClick={() => {
              if (sheetMode) {
                onOpenDetails!(id);
                return;
              }
              if (!completed && onEdit) {
                setEditText(text);
                setIsEditing(true);
              }
            }}
            className={sheetMode ? "flex items-start gap-3 cursor-pointer" : showQty ? "flex items-start gap-3" : undefined}
          >
            <div className={sheetMode || showQty ? "flex-1 min-w-0" : undefined}>
              <div className="flex items-start gap-1.5">
                <span
                  className={`min-w-0 wrap-anywhere ${
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
                      className="shrink-0 p-0.5 -m-0.5 mt-1.5 rounded active:bg-amber-500/20"
                    >
                      <Copy className="w-3 h-3 text-amber-500/70" />
                    </button>
                  ) : (
                    <Copy className="w-3 h-3 mt-1.5 text-amber-500/70 shrink-0" />
                  )
                )}
                {sheetMode && ordered && (
                  <Truck aria-label={t("ordered.label")} role="img" className="w-3.5 h-3.5 shrink-0 mt-[5px] text-amber-500" strokeWidth={3} />
                )}
                {sheetMode && recurring && (
                  <Repeat aria-label={t("recurring.title")} role="img" className="w-3.5 h-3.5 shrink-0 mt-[5px] text-tg-active" strokeWidth={3} />
                )}
                {sheetMode && isPending && (
                  <Clock className="w-3.5 h-3.5 shrink-0 mt-[5px] text-tg-hint" />
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
            {showQty && (
              <span data-qty className="shrink-0 max-w-[40%] text-end text-[15px] leading-6 text-tg-hint tabular-nums wrap-anywhere">
                {quantity}
              </span>
            )}
          </div>
        )}
      </div>

      {isPending && !sheetMode && (
        <Clock className="w-4 h-4 mt-[7px] text-tg-hint shrink-0" />
      )}

      {skipped && onSkip && !completed && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            const tg = getTelegramWebApp();
            tg?.HapticFeedback?.impactOccurred("light");
            onSkip(id, false);
          }}
          className="p-1.5 rounded-full shrink-0"
          aria-label={t("unskip")}
        >
          <RotateCcw className="w-[18px] h-[18px] text-tg-link" />
        </button>
      )}

      {!sheetMode && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete(id);
          }}
          className="p-1.5 rounded-full shrink-0"
        >
          <X className="w-[18px] h-[18px] text-tg-hint/60 active:text-tg-destructive" />
        </button>
      )}
    </div>
  );
}
