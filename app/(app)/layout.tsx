import TelegramProvider from "@/components/TelegramProvider";

// One TelegramProvider for every signed-in screen, so the session (JWT, user, realtime
// client) survives moving between them. /login and /login/callback stay outside the group:
// they must never run the Telegram bootstrap or its web-mode redirect to /login.
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <TelegramProvider>{children}</TelegramProvider>;
}
