"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { CalendarOff, CircleOff, Repeat, RotateCcw, Trash2, Truck } from "lucide-react";
import SwitchRow from "@/components/ui/SwitchRow";
import { getTelegramWebApp } from "@/src/types/telegram";
import type { ItemData } from "@/src/types/items";

export interface ItemSheetProps {
  /** The live item; undefined when it is gone. */
  item: ItemData | undefined;
  /** Was it a Not available item when the sheet opened. */
  openedSkipped: boolean;
  onClose: () => void;
  onEdit: (id: string, text: string) => void;
  onSetQuantity: (id: string, quantity: string | null) => void;
  onSkip: (id: string, skipped: boolean) => void;
  onOrder: (id: string, ordered: boolean) => void;
  onSetRecurring: (id: string, recurring: boolean) => void;
  onPause: (id: string) => void;
  onDelete: (id: string) => void;
}

const ACTION =
  "w-full min-h-11 flex items-center gap-3 py-3 px-4 rounded-2xl bg-tg-secondary-bg text-tg-text font-medium text-start active:scale-[0.98]";
const ICON = "w-5 h-5 shrink-0";

// The one place a grocery item is edited: its name, its quantity and every action on it.
// Drafts are saved when the sheet closes (Done, the backdrop, or an action).
export default function ItemSheet({
  item, openedSkipped, onClose, onEdit, onSetQuantity, onSkip, onOrder, onSetRecurring, onPause, onDelete,
}: ItemSheetProps) {
  const t = useTranslations();
  // Drafts: null until the user types, so the field shows the live value (a rename from another
  // device shows up) until then.
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [qtyDraft, setQtyDraft] = useState<string | null>(null);
  const nameRef = useRef<HTMLTextAreaElement | null>(null);

  const shownName = nameDraft ?? item?.text ?? "";
  // Grow the name box to fit its text, like the row's edit box.
  useEffect(() => {
    const el = nameRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [shownName]);

  // commitName/commitQuantity only report a change; saveName/saveQuantity also drop the draft.
  // An emptied name keeps the old one.
  const commitName = (it: ItemData) => {
    if (nameDraft === null) return;
    const trimmed = nameDraft.trim();
    if (trimmed && trimmed !== it.text) onEdit(it.id, trimmed);
  };
  // An emptied quantity is null, never "".
  const commitQuantity = (it: ItemData) => {
    if (qtyDraft === null) return;
    const trimmed = qtyDraft.trim();
    if (trimmed !== (it.quantity ?? "")) onSetQuantity(it.id, trimmed || null);
  };
  const saveName = (it: ItemData) => { commitName(it); setNameDraft(null); };
  const saveQuantity = (it: ItemData) => { commitQuantity(it); setQtyDraft(null); };
  const saveDrafts = (it: ItemData) => { saveName(it); saveQuantity(it); };

  const gone = !item || !!item.deleted_at;
  const moved = !!item && (item.skipped_at != null) !== openedSkipped;

  // Gone or deleted: close and drop the drafts. Completed, or moved between the list and Not
  // available: save the drafts, then close. The drafts are not reset here (no setState in an
  // effect): the parent unmounts the sheet on close, and a repeat save is a no-op once the
  // item shows the saved value.
  useEffect(() => {
    if (!item || item.deleted_at) { onClose(); return; }
    if (item.completed || moved) { commitName(item); commitQuantity(item); onClose(); }
  });

  if (gone || item.completed || moved) return null;

  const finish = () => { saveDrafts(item); onClose(); };
  const act = (fn: () => void) => { saveDrafts(item); fn(); onClose(); };
  const ordered = item.ordered_at != null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-sm backdrop-enter"
      onClick={finish}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={item.text}
        className="bg-tg-bg w-full max-w-lg rounded-t-3xl px-4 pt-3 pb-6 sheet-enter max-h-[90dvh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="w-10 h-1 rounded-full bg-tg-hint/30 mx-auto mb-4" />

        <textarea
          ref={nameRef}
          rows={1}
          aria-label={t("items.sheet.name")}
          maxLength={500}
          value={shownName}
          // An item is one line of text: a pasted line break becomes a space.
          onChange={(e) => setNameDraft(e.target.value.replace(/[^\S\r\n]*[\r\n]+[^\S\r\n]*/g, " "))}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            saveName(item);
            e.currentTarget.blur();
          }}
          className="block w-full resize-none overflow-hidden wrap-anywhere bg-transparent text-[17px] leading-6 font-semibold text-tg-text outline-none border-b-2 border-tg-hint/20 focus:border-tg-button/60 pb-2 mb-3"
        />

        <label className="flex items-center gap-3 min-h-11 px-4 py-2 rounded-2xl bg-tg-secondary-bg mb-4">
          <span className="text-tg-text font-medium shrink-0">{t("items.quantity.label")}</span>
          <input
            type="text"
            inputMode="text"
            enterKeyHint="done"
            maxLength={30}
            placeholder={t("items.quantity.placeholder")}
            value={qtyDraft ?? item.quantity ?? ""}
            onChange={(e) => setQtyDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              saveQuantity(item);
              e.currentTarget.blur();
            }}
            className="flex-1 min-w-0 bg-transparent text-base text-end text-tg-text placeholder:text-tg-hint outline-none tabular-nums"
          />
        </label>

        <div className="flex flex-col gap-2">
          {openedSkipped ? (
            <button
              type="button"
              aria-label={t("items.unskip")}
              onClick={() => act(() => onSkip(item.id, false))}
              className={ACTION}
            >
              <RotateCcw className={`${ICON} text-tg-link`} />
              {t("items.unskip")}
            </button>
          ) : (
            <>
              <button
                type="button"
                aria-label={t("items.skip")}
                onClick={() => act(() => onSkip(item.id, true))}
                className={ACTION}
              >
                <CircleOff className={`${ICON} text-tg-hint`} />
                {t("items.skip")}
              </button>
              <SwitchRow
                label={t("items.ordered.title")}
                checked={ordered}
                onChange={() => onOrder(item.id, !ordered)}
                icon={<Truck className={`${ICON} ${ordered ? "text-amber-500" : "text-tg-hint"}`} strokeWidth={ordered ? 3 : 2} />}
              />
              <SwitchRow
                label={t("items.recurring.title")}
                checked={item.recurring}
                onChange={() => onSetRecurring(item.id, !item.recurring)}
                icon={<Repeat className={`${ICON} ${item.recurring ? "text-tg-active" : "text-tg-hint"}`} strokeWidth={item.recurring ? 3 : 2} />}
              />
              {item.recurring && (
                <button
                  type="button"
                  aria-label={t("items.recurring.notThisWeek")}
                  onClick={() => act(() => {
                    // handlePause gives no haptic itself, while the other handlers do.
                    getTelegramWebApp()?.HapticFeedback?.impactOccurred("light");
                    onPause(item.id);
                  })}
                  className={ACTION}
                >
                  <CalendarOff className={`${ICON} text-tg-hint`} />
                  {t("items.recurring.notThisWeek")}
                </button>
              )}
            </>
          )}
          <button
            type="button"
            aria-label={t("common.delete")}
            onClick={() => act(() => onDelete(item.id))}
            className={`${ACTION} mt-2`}
          >
            <Trash2 className={`${ICON} text-tg-destructive`} />
            <span className="text-tg-destructive">{t("common.delete")}</span>
          </button>
        </div>

        <button
          type="button"
          onClick={finish}
          className="w-full mt-4 py-3.5 rounded-2xl bg-tg-button text-tg-button-text font-medium active:scale-[0.98]"
        >
          {t("common.done")}
        </button>
      </div>
    </div>
  );
}
