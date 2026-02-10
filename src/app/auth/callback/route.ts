import { createServerClient } from "@supabase/ssr";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/chat";

  if (!code) {
    console.error("[Auth Callback] No code provided");
    return NextResponse.redirect(`${origin}/?error=auth`);
  }

  // Collect cookies to set on the response
  const cookiesToSet: Array<{
    name: string;
    value: string;
    options: Record<string, unknown>;
  }> = [];

  // Create Supabase client that collects cookies for the response
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookies) {
          cookiesToSet.push(
            ...cookies.map(({ name, value, options }) => ({
              name,
              value,
              options: options as Record<string, unknown>,
            }))
          );
        },
      },
    }
  );

  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    console.error("[Auth Callback] Error exchanging code:", error.message);
    return NextResponse.redirect(`${origin}/?error=auth`);
  }

  // Create redirect response and set all cookies on it
  const response = NextResponse.redirect(`${origin}${next}`);

  // Apply all cookies to the response
  for (const { name, value, options } of cookiesToSet) {
    response.cookies.set(name, value, options);
  }

  console.log("[Auth Callback] Success, set", cookiesToSet.length, "cookies, redirecting to:", next);
  return response;
}
