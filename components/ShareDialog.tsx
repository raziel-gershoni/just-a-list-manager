"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslations } from "next-intl";
import { X, Copy, Check, Link2, Trash2 } from "lucide-react";
import { useTelegram } from "./TelegramProvider";

interface Collaborator {
  id: string;
  user_id: string;
  permission: string;
  status: string;
  users: { name: string; username: string | null };
}

interface ShareDialogProps {
  listId: string;
  listName: string;
  isOpen: boolean;
  onClose: () => void;
}

export default function ShareDialog({
  listId,
  listName,
  isOpen,
  onClose,
}: ShareDialogProps) {
  const { initData } = useTelegram();
  const t = useTranslations('share');
  const [permission, setPermission] = useState<"view" | "edit">("edit");
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [collaborators, setCollaborators] = useState<Collaborator[]>([]);
  const [loading, setLoading] = useState(false);

  const loadCollaborators = useCallback(async () => {
    if (!initData) return;
    try {
      const res = await fetch(`/api/share?listId=${listId}`, {
        headers: { "x-telegram-init-data": initData },
      });
      if (res.ok) {
        const data = await res.json();
        setCollaborators(data.collaborators || []);
        if (data.activeLink) {
          setInviteLink(data.activeLink);
        }
      }
    } catch (e) {
      console.error("[ShareDialog] Failed to load:", e);
    }
  }, [initData, listId]);

  useEffect(() => {
    if (isOpen && initData) {
      loadCollaborators();
    }
  }, [isOpen, initData, loadCollaborators]);

  const generateLink = async () => {
    if (!initData) return;
    setLoading(true);
    try {
      const res = await fetch("/api/share", {
        method: "POST",
        headers: {
          "x-telegram-init-data": initData,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ listId, permission }),
      });
      if (res.ok) {
        const { link } = await res.json();
        setInviteLink(link);
      }
    } catch (e) {
      console.error("[ShareDialog] Failed to generate link:", e);
    } finally {
      setLoading(false);
    }
  };

  const copyLink = async () => {
    if (!inviteLink) return;
    try {
      await navigator.clipboard.writeText(inviteLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for TG WebView
      const tg = (window as any).Telegram?.WebApp;
      if (tg?.openLink) {
        // On some TG clients, clipboard API isn't available
      }
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50">
      <div className="bg-tg-bg w-full max-w-lg rounded-t-2xl p-6 max-h-[80vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-tg-text">
            {t('title')} &ldquo;{listName}&rdquo;
          </h2>
          <button onClick={onClose} className="p-1">
            <X className="w-5 h-5 text-tg-hint" />
          </button>
        </div>

        {/* Permission selector */}
        <div className="flex gap-2 mb-4">
          <button
            onClick={() => setPermission("edit")}
            className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors ${
              permission === "edit"
                ? "bg-tg-button text-tg-button-text"
                : "bg-tg-secondary-bg text-tg-hint"
            }`}
          >
            {t('editPerm')}
          </button>
          <button
            onClick={() => setPermission("view")}
            className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors ${
              permission === "view"
                ? "bg-tg-button text-tg-button-text"
                : "bg-tg-secondary-bg text-tg-hint"
            }`}
          >
            {t('view')}
          </button>
        </div>

        {/* Generate or show link */}
        {inviteLink ? (
          <div className="flex gap-2 mb-6">
            <div className="flex-1 bg-tg-secondary-bg rounded-lg px-3 py-2 text-sm text-tg-text truncate">
              {inviteLink}
            </div>
            <button
              onClick={copyLink}
              className="px-3 py-2 rounded-lg bg-tg-button text-tg-button-text"
            >
              {copied ? (
                <Check className="w-4 h-4" />
              ) : (
                <Copy className="w-4 h-4" />
              )}
            </button>
          </div>
        ) : (
          <button
            onClick={generateLink}
            disabled={loading}
            className="w-full py-3 rounded-xl bg-tg-button text-tg-button-text font-medium mb-6 flex items-center justify-center gap-2 disabled:opacity-50"
          >
            <Link2 className="w-4 h-4" />
            {t('generateLink')}
          </button>
        )}

        {/* Collaborators list */}
        {collaborators.length > 0 && (
          <>
            <h3 className="text-sm font-medium text-tg-section-header mb-2">
              {t('collaborators')}
            </h3>
            <div className="space-y-2">
              {collaborators.map((c) => (
                <div
                  key={c.id}
                  className="flex items-center justify-between py-2 px-3 bg-tg-secondary-bg rounded-lg"
                >
                  <div>
                    <span className="text-sm text-tg-text">
                      {c.users?.name || "Unknown"}
                    </span>
                    <span className="text-xs text-tg-hint ms-2">
                      {c.status === "pending"
                        ? t('pendingApproval')
                        : c.permission === "edit"
                          ? t('editPerm')
                          : t('view')}
                    </span>
                  </div>
                  <span
                    className={`text-xs px-2 py-0.5 rounded-full ${
                      c.status === "approved"
                        ? "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300"
                        : c.status === "pending"
                          ? "bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300"
                          : "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300"
                    }`}
                  >
                    {c.status === "approved"
                      ? t('approved')
                      : c.status === "pending"
                        ? t('pendingApproval')
                        : t('declined')}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
