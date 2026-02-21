"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import TelegramProvider, { useTelegram } from "@/components/TelegramProvider";

function InviteContent() {
  const { initData, isReady, jwtRef } = useTelegram();
  const t = useTranslations();
  const params = useParams();
  const router = useRouter();
  const token = params.token as string;

  const [status, setStatus] = useState<
    "loading" | "waiting" | "approved" | "declined" | "error" | "already"
  >("loading");
  const [listName, setListName] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [listId, setListId] = useState("");
  const [collaboratorId, setCollaboratorId] = useState("");

  const acceptInvite = useCallback(async () => {
    try {
      const res = await fetch(`/api/share/${token}`, {
        method: "POST",
        headers: {
          "x-telegram-init-data": initData!,
          "Content-Type": "application/json",
        },
      });

      const data = await res.json();

      if (!res.ok) {
        if (data.status === "already_approved") {
          setListId(data.listId);
          setStatus("already");
          router.push(`/list/${data.listId}`);
          return;
        }
        if (data.status === "already_pending") {
          setListName(data.listName || "");
          setListId(data.listId || "");
          setCollaboratorId(data.collaboratorId || "");
          setStatus("waiting");
          return;
        }
        setErrorMessage(data.error || "This invite is no longer valid.");
        setStatus("error");
        return;
      }

      setListName(data.listName || "");
      setListId(data.listId || "");
      setCollaboratorId(data.collaboratorId || "");
      setStatus("waiting");
    } catch {
      setErrorMessage("Something went wrong. Please try again.");
      setStatus("error");
    }
  }, [token, initData, router]);

  useEffect(() => {
    if (!isReady || !initData) return;
    acceptInvite();
  }, [isReady, initData, acceptInvite]);

  const cancelRequest = async () => {
    if (!collaboratorId) return;
    const jwt = jwtRef.current;
    // Use JWT if available, fall back to initData for early cancellation
    const headers: Record<string, string> = jwt
      ? { Authorization: `Bearer ${jwt}` }
      : initData
        ? { "x-telegram-init-data": initData }
        : {};
    if (Object.keys(headers).length === 0) return;
    try {
      await fetch(`/api/share/${token}?collaboratorId=${collaboratorId}`, {
        method: "DELETE",
        headers,
      });
    } catch {
      // ignore
    }
    router.push("/");
  };

  if (status === "loading") {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen">
        <Loader2 className="w-8 h-8 text-tg-button animate-spin mb-4" />
        <p className="text-tg-hint">{t('share.processingInvite')}</p>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen px-6 text-center">
        <div className="w-16 h-16 rounded-full bg-red-100 dark:bg-red-900 flex items-center justify-center mb-4">
          <span className="text-2xl">!</span>
        </div>
        <h2 className="text-lg font-semibold text-tg-text mb-2">
          {t('share.inviteInvalid')}
        </h2>
        <p className="text-tg-hint mb-6">{errorMessage}</p>
        <button
          onClick={() => router.push("/")}
          className="px-6 py-3 rounded-xl bg-tg-button text-tg-button-text font-medium"
        >
          {t('common.goHome')}
        </button>
      </div>
    );
  }

  if (status === "waiting") {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen px-6 text-center">
        <Loader2 className="w-8 h-8 text-tg-button animate-spin mb-4" />
        <h2 className="text-lg font-semibold text-tg-text mb-2">
          {t('share.waitingApproval')}
        </h2>
        {listName && (
          <p className="text-tg-text mb-1 font-medium">{listName}</p>
        )}
        <p className="text-tg-hint mb-8">
          {t('share.waitingDescription')}
        </p>
        <button
          onClick={cancelRequest}
          className="px-6 py-3 rounded-xl bg-tg-secondary-bg text-tg-text font-medium"
        >
          {t('share.cancelRequest')}
        </button>
      </div>
    );
  }

  return null;
}

export default function InvitePage() {
  return (
    <TelegramProvider>
      <InviteContent />
    </TelegramProvider>
  );
}
