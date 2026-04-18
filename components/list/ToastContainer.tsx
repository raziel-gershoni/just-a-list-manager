"use client";

import { useTranslations } from "next-intl";

interface UndoAction {
  message: string;
  undo: () => void;
  timeout: NodeJS.Timeout;
}

interface ToastContainerProps {
  reminderToast: string | null;
  duplicateWarning: string | null;
  errorToast?: string | null;
  undoAction: UndoAction | null;
}

export default function ToastContainer({
  reminderToast,
  duplicateWarning,
  errorToast,
  undoAction,
}: ToastContainerProps) {
  const t = useTranslations();

  return (
    <>
      {/* Error toast */}
      {errorToast && !undoAction && (
        <div className="fixed bottom-8 start-5 end-5 bg-tg-destructive text-white rounded-2xl py-3.5 px-5 z-30 shadow-xl shadow-black/10 dark:shadow-black/30 animate-in fade-in slide-in-from-bottom-4 duration-300">
          <span className="text-sm">{errorToast}</span>
        </div>
      )}

      {/* Reminder toast */}
      {reminderToast && !undoAction && !errorToast && (
        <div className="fixed bottom-8 start-5 end-5 bg-tg-button text-tg-button-text rounded-2xl py-3.5 px-5 z-30 shadow-xl shadow-black/10 dark:shadow-black/30 animate-in fade-in slide-in-from-bottom-4 duration-300">
          <span className="text-sm">{reminderToast}</span>
        </div>
      )}

      {/* Duplicate warning toast */}
      {duplicateWarning && !undoAction && !reminderToast && !errorToast && (
        <div className="fixed bottom-8 start-5 end-5 bg-amber-500/90 text-white rounded-2xl py-3.5 px-5 z-30 shadow-xl shadow-black/10 dark:shadow-black/30 animate-in fade-in slide-in-from-bottom-4 duration-300">
          <span className="text-sm">{duplicateWarning}</span>
        </div>
      )}

      {/* Undo toast */}
      {undoAction && (
        <div className="fixed bottom-8 start-5 end-5 bg-foreground/95 text-background rounded-2xl py-3.5 px-5 flex items-center justify-between z-30 shadow-xl shadow-black/10 dark:shadow-black/30 backdrop-blur-xl animate-in fade-in slide-in-from-bottom-4 duration-300">
          <span className="text-sm">{undoAction.message}</span>
          <button
            onClick={undoAction.undo}
            className="text-sm font-semibold ms-4"
          >
            {t('common.undo')}
          </button>
        </div>
      )}
    </>
  );
}
