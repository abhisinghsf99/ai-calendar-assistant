import { createServerClient } from "@supabase/ssr";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

interface GoogleCalendar {
  id: string;
  summary: string;
  primary?: boolean;
  accessRole: string;
  backgroundColor?: string;
}

export async function GET(request: NextRequest) {
  // Create Supabase client to get session and provider token
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll() {},
      },
    }
  );

  const { data: { session }, error: authError } = await supabase.auth.getSession();

  if (authError || !session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Get the Google OAuth access token from the session
  const providerToken = session.provider_token;

  if (!providerToken) {
    return NextResponse.json(
      { error: "No calendar access. Please sign out and sign in again to grant calendar permissions." },
      { status: 403 }
    );
  }

  try {
    // Fetch user's calendars from Google Calendar API
    const response = await fetch(
      "https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=writer",
      {
        headers: {
          Authorization: `Bearer ${providerToken}`,
        },
      }
    );

    if (!response.ok) {
      const error = await response.text();
      console.error("[Calendars API] Google API error:", error);

      if (response.status === 401) {
        return NextResponse.json(
          { error: "Calendar access expired. Please sign out and sign in again." },
          { status: 401 }
        );
      }

      return NextResponse.json({ error: "Failed to fetch calendars" }, { status: 500 });
    }

    const data = await response.json();

    // Filter and format calendars - include backgroundColor for UI
    const calendars = (data.items || [])
      .filter((cal: GoogleCalendar) => cal.accessRole === "owner" || cal.accessRole === "writer")
      .map((cal: GoogleCalendar) => ({
        id: cal.id,
        summary: cal.summary,
        primary: cal.primary || false,
        backgroundColor: cal.backgroundColor || "#4285f4", // Default Google blue
      }));

    return NextResponse.json({ calendars });
  } catch (error) {
    console.error("[Calendars API] Request error:", error);
    return NextResponse.json({ error: "Failed to fetch calendars" }, { status: 500 });
  }
}
