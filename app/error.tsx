"use client";

import { useEffect } from "react";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[ErrorBoundary]", error);
  }, [error]);

  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-4">
      <p className="text-tg-hint mb-4">Something went wrong</p>
      <button
        onClick={reset}
        className="px-6 py-3 rounded-xl bg-tg-button text-tg-button-text font-medium"
      >
        Try again
      </button>
    </div>
  );
}
