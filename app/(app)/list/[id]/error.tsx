"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, RefreshCw } from "lucide-react";

export default function ListError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const router = useRouter();

  useEffect(() => {
    console.error("[ListErrorBoundary]", error);
  }, [error]);

  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-4 gap-4">
      <p className="text-tg-hint">Failed to load list</p>
      <div className="flex gap-3">
        <button
          onClick={() => router.push("/")}
          className="flex items-center gap-2 px-6 py-3 rounded-xl bg-tg-secondary-bg text-tg-text font-medium"
        >
          <ArrowLeft className="w-4 h-4" />
          Home
        </button>
        <button
          onClick={reset}
          className="flex items-center gap-2 px-6 py-3 rounded-xl bg-tg-button text-tg-button-text font-medium"
        >
          <RefreshCw className="w-4 h-4" />
          Retry
        </button>
      </div>
    </div>
  );
}
