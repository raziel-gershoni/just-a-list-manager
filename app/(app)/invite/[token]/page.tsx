"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Loader2, RefreshCw } from "lucide-react";
import { useTelegram } from "@/components/TelegramProvider";
import { requestToJoin, cancelJoinRequest, inviteAuthHeaders } from "@/src/utils/invite-requests";

export default function InvitePage() {
  const { initData, isReady, jwt, jwtRef } = useTelegram();
  const t = useTranslations();
  const params = useParams();
  const router = useRouter();
  const token = params.token as string;

  const [status, setStatus] = useState<
    "loading" | "waiting" | "approved" | "declined" | "error" | "already" | "retry"
  >("loading");
  const [listName, setListName] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- setListId is used, value consumed by future navigation
  const [listId, setListId] = useState("");
  const [collaboratorId, setCollaboratorId] = useState("");
  const [cancelFailed, setCancelFailed] = useState(false);

  // Set once the join was sent, so a later token refresh does not send it again.
  const askedRef = useRef(false);

  const acceptInvite = useCallback(async () => {
    const headers = inviteAuthHeaders(initData, jwtRef.current);
    if (!headers) {
      // The sign-in gave up: Retry, or a JWT that arrives later, asks again.
      console.warn("[Invite] No credentials to ask to join yet");
      setStatus("retry");
      return;
    }
    askedRef.current = true;
    const outcome = await requestToJoin(token, headers);
    switch (outcome.kind) {
      case "member":
        setListId(outcome.listId);
        setStatus("already");
        router.push(`/list/${outcome.listId}`);
        return;
      case "pending":
        setListName(outcome.listName);
        setListId(outcome.listId);
        setCollaboratorId(outcome.collaboratorId);
        setStatus("waiting");
        return;
      case "invalid":
        setErrorMessage(outcome.message);
        setStatus("error");
        return;
      case "retry":
        setStatus("retry");
        return;
    }
  }, [token, initData, jwtRef, router]);

  const retryInvite = () => {
    setStatus("loading");
    void acceptInvite();
  };

  // Once the session settled: with fresh initData, else the JWT (on the web, and after a
  // Telegram "Reload page" more than 5 minutes in).
  useEffect(() => {
    if (!isReady || askedRef.current) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async invite flow sets state after await
    void acceptInvite();
  }, [isReady, jwt, acceptInvite]);

  const cancelRequest = async () => {
    if (!collaboratorId) return;
    setCancelFailed(false);
    const jwt = jwtRef.current;
    // Use JWT if available, fall back to initData for early cancellation
    const headers: Record<string, string> = jwt
      ? { Authorization: `Bearer ${jwt}` }
      : initData
        ? { "x-telegram-init-data": initData }
        : {};
    if (Object.keys(headers).length === 0) {
      console.warn("[Invite] No credentials to cancel the join request, collaboratorId:", collaboratorId);
      setCancelFailed(true);
      return;
    }
    // Go home only once the server confirmed; otherwise the request would stay pending
    // while the invitee believes it is withdrawn.
    if (!(await cancelJoinRequest(token, collaboratorId, headers))) {
      setCancelFailed(true);
      return;
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
        <div className="w-16 h-16 rounded-2xl bg-red-50 dark:bg-red-950/50 flex items-center justify-center mb-4">
          <span className="text-2xl">!</span>
        </div>
        <h2 className="text-lg font-semibold text-tg-text mb-2">
          {t('share.inviteInvalid')}
        </h2>
        <p className="text-tg-hint mb-6">{errorMessage}</p>
        <button
          onClick={() => router.push("/")}
          className="px-6 py-3.5 rounded-2xl bg-tg-button text-tg-button-text font-medium active:scale-[0.98]"
        >
          {t('common.goHome')}
        </button>
      </div>
    );
  }

  if (status === "retry") {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen px-6 text-center">
        <p className="text-tg-hint mb-6">{t('errors.generic')}</p>
        <div className="flex flex-col items-center gap-3">
          <button
            onClick={retryInvite}
            className="flex items-center gap-2 px-6 py-3.5 rounded-2xl bg-tg-button text-tg-button-text font-medium active:scale-[0.98]"
          >
            <RefreshCw className="w-4 h-4" />
            {t('common.retry')}
          </button>
          <button
            onClick={() => router.push("/")}
            className="px-6 py-3.5 rounded-2xl bg-tg-secondary-bg text-tg-text font-medium active:scale-[0.98]"
          >
            {t('common.goHome')}
          </button>
        </div>
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
        <p className="text-tg-hint mb-10">
          {t('share.waitingDescription')}
        </p>
        <button
          onClick={cancelRequest}
          className="px-6 py-3.5 rounded-2xl bg-tg-secondary-bg text-tg-text font-medium active:scale-[0.98]"
        >
          {t('share.cancelRequest')}
        </button>
        {cancelFailed && (
          <p role="alert" className="mt-3 text-sm text-tg-destructive text-center">
            {t('errors.generic')}
          </p>
        )}
      </div>
    );
  }

  return null;
}
