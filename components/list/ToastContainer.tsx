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
        <div className="fixed bottom-6 start-4 end-4 bg-tg-destructive text-white rounded-xl py-3 px-4 z-30 shadow-lg">
          <span className="text-sm">{errorToast}</span>
        </div>
      )}

      {/* Reminder toast */}
      {reminderToast && !undoAction && !errorToast && (
        <div className="fixed bottom-6 start-4 end-4 bg-tg-button text-tg-button-text rounded-xl py-3 px-4 z-30 shadow-lg">
          <span className="text-sm">{reminderToast}</span>
        </div>
      )}

      {/* Duplicate warning toast */}
      {duplicateWarning && !undoAction && !reminderToast && !errorToast && (
        <div className="fixed bottom-6 start-4 end-4 bg-amber-500 text-white rounded-xl py-3 px-4 z-30 shadow-lg">
          <span className="text-sm">{duplicateWarning}</span>
        </div>
      )}

      {/* Undo toast */}
      {undoAction && (
        <div className="fixed bottom-6 start-4 end-4 bg-foreground text-background rounded-xl py-3 px-4 flex items-center justify-between z-30 shadow-lg">
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
