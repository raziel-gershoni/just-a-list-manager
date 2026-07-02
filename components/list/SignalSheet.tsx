"use client";

import { useTranslations } from "next-intl";
import { Bell, CircleCheck, X } from "lucide-react";

interface SignalSheetProps {
  isOpen: boolean;
  onClose: () => void;
  onRemind: () => void;
  onReady: () => void;
}

export default function SignalSheet({ isOpen, onClose, onRemind, onReady }: SignalSheetProps) {
  const t = useTranslations("items.signal");
  if (!isOpen) return null;

  const fire = (fn: () => void) => {
    fn();
    onClose();
  };

  const rowBase =
    "w-full flex items-center gap-3.5 px-5 py-4 rounded-2xl bg-tg-secondary-bg active:scale-[0.99] transition-transform text-start";

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-sm backdrop-enter"
      onClick={onClose}
    >
      <div
        className="bg-tg-bg w-full max-w-lg rounded-t-3xl pt-3 pb-6 sheet-enter"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="w-10 h-1 rounded-full bg-tg-hint/30 mx-auto mb-3" />

        <div className="flex items-center gap-2 px-5 mb-3">
          <p className="flex-1 text-sm font-medium text-tg-text">{t("title")}</p>
          <button onClick={onClose} className="p-1.5 -m-1.5 rounded-full active:bg-tg-secondary-bg shrink-0">
            <X className="w-5 h-5 text-tg-hint" />
          </button>
        </div>

        <div className="flex flex-col gap-2 px-4">
          <button onClick={() => fire(onRemind)} className={rowBase}>
            <span className="shrink-0 w-9 h-9 rounded-full bg-tg-button/10 flex items-center justify-center">
              <Bell className="w-[18px] h-[18px] text-tg-button" strokeWidth={2.25} />
            </span>
            <span className="flex-1 min-w-0">
              <span className="block text-[15px] font-medium text-tg-text">{t("remind")}</span>
              <span className="block text-[12px] text-tg-hint truncate">{t("remindHint")}</span>
            </span>
          </button>

          <button onClick={() => fire(onReady)} className={rowBase}>
            <span className="shrink-0 w-9 h-9 rounded-full bg-emerald-500/10 flex items-center justify-center">
              <CircleCheck className="w-[18px] h-[18px] text-emerald-500" strokeWidth={2.25} />
            </span>
            <span className="flex-1 min-w-0">
              <span className="block text-[15px] font-medium text-tg-text">{t("ready")}</span>
              <span className="block text-[12px] text-tg-hint truncate">{t("readyHint")}</span>
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
