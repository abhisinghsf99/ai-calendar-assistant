"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export default function Home() {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const supabase = createClient();

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      setIsAuthenticated(!!user);
    });
  }, []);

  async function signInWithGoogle() {
    setLoading(true);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
        queryParams: {
          access_type: "offline",
          prompt: "consent",
        },
        scopes: "https://www.googleapis.com/auth/calendar",
      },
    });
    if (error) setLoading(false);
  }

  return (
    <div className="flex min-h-svh flex-col items-center justify-center bg-gradient-to-b from-indigo-50 to-white px-6">
      <div className="flex flex-col items-center gap-6 text-center">
        <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-indigo-600 text-4xl text-white shadow-lg">
          📅
        </div>
        <h1 className="text-4xl font-bold tracking-tight text-gray-900">
          AI Calendar Assistant
        </h1>
        <p className="max-w-sm text-lg text-gray-600">
          Add events to your Google Calendar instantly using natural language.
          Just type what you need.
        </p>

        {isAuthenticated === null ? (
          <div className="mt-4 h-12 w-40 animate-pulse rounded-full bg-gray-200" />
        ) : isAuthenticated ? (
          <button
            onClick={() => router.push("/chat")}
            className="mt-4 rounded-full bg-indigo-600 px-8 py-3 text-lg font-medium text-white shadow-md transition-colors hover:bg-indigo-700 active:bg-indigo-800"
          >
            Get Started
          </button>
        ) : (
          <button
            onClick={signInWithGoogle}
            disabled={loading}
            className="mt-4 flex items-center gap-3 rounded-full bg-indigo-600 px-8 py-3 text-lg font-medium text-white shadow-md transition-colors hover:bg-indigo-700 active:bg-indigo-800 disabled:opacity-60"
          >
            {loading ? (
              <svg
                className="h-5 w-5 animate-spin"
                viewBox="0 0 24 24"
                fill="none"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                />
              </svg>
            ) : (
              <svg className="h-5 w-5" viewBox="0 0 24 24">
                <path
                  fill="currentColor"
                  d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
                />
                <path
                  fill="currentColor"
                  d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                />
                <path
                  fill="currentColor"
                  d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                />
                <path
                  fill="currentColor"
                  d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                />
              </svg>
            )}
            Sign in with Google
          </button>
        )}
      </div>
    </div>
  );
}
