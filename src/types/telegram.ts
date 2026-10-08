/** Minimal Telegram WebApp type for client-side access */
export interface TelegramWebApp {
  initData?: string;
  HapticFeedback?: {
    impactOccurred: (style: string) => void;
    notificationOccurred: (type: string) => void;
  };
  openLink?: (url: string) => void;
  showConfirm?: (message: string, callback: (confirmed: boolean) => void) => void;
}

/** Window with optional Telegram global */
export interface WindowWithTelegram extends Window {
  Telegram?: {
    WebApp?: TelegramWebApp;
  };
}

/** Helper to get the Telegram WebApp instance from the global window */
export function getTelegramWebApp(): TelegramWebApp | undefined {
  return (window as WindowWithTelegram).Telegram?.WebApp;
}

/** Ask before a destructive action: Telegram's native confirm, else window.confirm. */
export function askConfirm(message: string, onConfirm: () => void): void {
  const tg = getTelegramWebApp();
  if (tg?.showConfirm) {
    tg.showConfirm(message, (confirmed: boolean) => {
      if (confirmed) onConfirm();
    });
  } else if (window.confirm(message)) {
    onConfirm();
  }
}
