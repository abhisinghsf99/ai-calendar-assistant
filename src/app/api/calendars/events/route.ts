import { createServerClient } from "@supabase/ssr";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

interface EventRequest {
  calendarId: string;
  title: string;
  description?: string;
  location?: string;
  date: string;  // YYYY-MM-DD
  time?: string;  // HH:MM (optional if allDay)
  duration?: number;  // minutes (optional if allDay)
  allDay?: boolean;
  recurrence?: string;  // "none" | "daily" | "weekly" | "monthly" | "yearly"
}

interface CalendarEvent {
  id: string;
  summary?: string;
  start: { dateTime?: string; date?: string };
  end: { dateTime?: string; date?: string };
  location?: string;
  description?: string;
}

// GET: Fetch events from calendar
export async function GET(request: NextRequest) {
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

  const providerToken = session.provider_token;

  if (!providerToken) {
    return NextResponse.json(
      { error: "No calendar access. Please sign out and sign in again to grant calendar permissions." },
      { status: 403 }
    );
  }

  // Get query parameters
  const { searchParams } = new URL(request.url);
  const timeMin = searchParams.get("timeMin");
  const timeMax = searchParams.get("timeMax");
  const calendarId = searchParams.get("calendarId") || "primary";
  const maxResults = searchParams.get("maxResults") || "2500"; // No artificial limit

  if (!timeMin || !timeMax) {
    return NextResponse.json(
      { error: "Missing required parameters: timeMin, timeMax" },
      { status: 400 }
    );
  }

  try {
    const params = new URLSearchParams({
      timeMin,
      timeMax,
      maxResults,
      singleEvents: "true",
      orderBy: "startTime",
    });

    const response = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
      {
        headers: {
          Authorization: `Bearer ${providerToken}`,
        },
      }
    );

    if (!response.ok) {
      const error = await response.text();
      console.error("[Events API] Google API error:", error);

      if (response.status === 401) {
        return NextResponse.json(
          { error: "Calendar access expired. Please sign out and sign in again." },
          { status: 401 }
        );
      }

      return NextResponse.json({ error: "Failed to fetch events" }, { status: 500 });
    }

    const data = await response.json();

    // Format events for response
    const events = (data.items || []).map((event: CalendarEvent) => ({
      id: event.id,
      title: event.summary || "(No title)",
      start: event.start.dateTime || event.start.date,
      end: event.end.dateTime || event.end.date,
      location: event.location,
      description: event.description,
    }));

    return NextResponse.json({ events });
  } catch (error) {
    console.error("[Events API] Request error:", error);
    return NextResponse.json({ error: "Failed to fetch events" }, { status: 500 });
  }
}

// POST: Create a new event
export async function POST(request: NextRequest) {
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

  const providerToken = session.provider_token;

  if (!providerToken) {
    return NextResponse.json(
      { error: "No calendar access. Please sign out and sign in again to grant calendar permissions." },
      { status: 403 }
    );
  }

  const body: EventRequest = await request.json();
  const { calendarId, title, description, location, date, time, duration, allDay, recurrence } = body;

  // Validate required fields
  if (!calendarId || !title || !date) {
    return NextResponse.json(
      { error: "Missing required fields: calendarId, title, date" },
      { status: 400 }
    );
  }

  // Validate date format
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: "Invalid date format. Use YYYY-MM-DD" }, { status: 400 });
  }

  // For non-all-day events, time is required
  if (!allDay && !time) {
    return NextResponse.json({ error: "Time is required for non-all-day events" }, { status: 400 });
  }

  // Validate time format if provided
  if (time && !/^\d{2}:\d{2}$/.test(time)) {
    return NextResponse.json({ error: "Invalid time format. Use HH:MM" }, { status: 400 });
  }

  // Build the event object
  interface GoogleEvent {
    summary: string;
    description?: string;
    location?: string;
    start: { dateTime?: string; date?: string; timeZone?: string };
    end: { dateTime?: string; date?: string; timeZone?: string };
    recurrence?: string[];
  }

  let event: GoogleEvent;

  if (allDay) {
    // All-day event uses date (not dateTime)
    // End date should be the next day for a single all-day event
    const endDate = new Date(date);
    endDate.setDate(endDate.getDate() + 1);
    const endDateStr = endDate.toISOString().split("T")[0];

    event = {
      summary: title,
      description: description || undefined,
      location: location || undefined,
      start: { date },
      end: { date: endDateStr },
    };
  } else {
    // Timed event
    const startDateTime = `${date}T${time}:00`;
    const eventDuration = duration || 60;

    // Calculate end time
    const [hours, minutes] = time!.split(":").map(Number);
    const totalMinutes = hours * 60 + minutes + eventDuration;
    const endHours = Math.floor(totalMinutes / 60) % 24;
    const endMinutes = totalMinutes % 60;
    const endTime = `${endHours.toString().padStart(2, "0")}:${endMinutes.toString().padStart(2, "0")}`;
    const endDateTime = `${date}T${endTime}:00`;

    event = {
      summary: title,
      description: description || undefined,
      location: location || undefined,
      start: {
        dateTime: startDateTime,
        timeZone: "America/Los_Angeles",
      },
      end: {
        dateTime: endDateTime,
        timeZone: "America/Los_Angeles",
      },
    };
  }

  // Add recurrence rule if specified
  if (recurrence && recurrence !== "none") {
    const recurrenceRules: Record<string, string> = {
      daily: "RRULE:FREQ=DAILY",
      weekly: "RRULE:FREQ=WEEKLY",
      monthly: "RRULE:FREQ=MONTHLY",
      yearly: "RRULE:FREQ=YEARLY",
    };
    if (recurrenceRules[recurrence]) {
      event.recurrence = [recurrenceRules[recurrence]];
    }
  }

  try {
    const response = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${providerToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(event),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      console.error("[Events API] Google API error:", error);

      if (response.status === 401) {
        return NextResponse.json(
          { error: "Calendar access expired. Please sign out and sign in again." },
          { status: 401 }
        );
      }

      return NextResponse.json({ error: "Failed to create event" }, { status: 500 });
    }

    const createdEvent = await response.json();

    return NextResponse.json({
      success: true,
      event: {
        id: createdEvent.id,
        title: createdEvent.summary,
        start: createdEvent.start,
        end: createdEvent.end,
        htmlLink: createdEvent.htmlLink,
      },
    });
  } catch (error) {
    console.error("[Events API] Request error:", error);
    return NextResponse.json({ error: "Failed to create event" }, { status: 500 });
  }
}

// DELETE: Delete an event
export async function DELETE(request: NextRequest) {
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

  const providerToken = session.provider_token;

  if (!providerToken) {
    return NextResponse.json(
      { error: "No calendar access. Please sign out and sign in again to grant calendar permissions." },
      { status: 403 }
    );
  }

  // Get query parameters
  const { searchParams } = new URL(request.url);
  const calendarId = searchParams.get("calendarId") || "primary";
  const eventId = searchParams.get("eventId");

  if (!eventId) {
    return NextResponse.json({ error: "Missing eventId parameter" }, { status: 400 });
  }

  try {
    const response = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${providerToken}`,
        },
      }
    );

    if (!response.ok) {
      const error = await response.text();
      console.error("[Events API] Google API delete error:", error);

      if (response.status === 401) {
        return NextResponse.json(
          { error: "Calendar access expired. Please sign out and sign in again." },
          { status: 401 }
        );
      }

      if (response.status === 404) {
        return NextResponse.json({ error: "Event not found" }, { status: 404 });
      }

      return NextResponse.json({ error: "Failed to delete event" }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[Events API] Delete request error:", error);
    return NextResponse.json({ error: "Failed to delete event" }, { status: 500 });
  }
}
