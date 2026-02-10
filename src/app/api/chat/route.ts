import { createServerClient } from "@supabase/ssr";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

interface AppointmentData {
  date: string | null;
  time: string | null;
  title: string | null;
  description: string | null;
  duration: number;
  needsClarification: boolean;
  clarificationMessage: string | null;
}

interface DeleteSearch {
  searchTerm: string | null;
  date: string | null;
  time: string | null;
  timeRangeStart: string | null;
  timeRangeEnd: string | null;
  needsClarification?: boolean;
  clarificationQuestion?: string | null;
}

interface ChatResponse {
  message: string;
  speech?: string;
  action: "create" | "read" | "delete" | "none";
  appointment: AppointmentData | null;
  readRange: string | null;
  deleteSearch?: DeleteSearch | null;
}

interface CalendarEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  location?: string;
  calendarId?: string;
  calendarName?: string;
  calendarColor?: string;
}

interface CalendarInfo {
  id: string;
  name: string;
  color: string;
}

// Calculate date ranges server-side for accuracy
function calculateDateRange(rangeType: string): { timeMin: string; timeMax: string } {
  const now = new Date();

  // Get current time in LA
  const laFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  // Parse LA time components
  const parts = laFormatter.formatToParts(now);
  const getPart = (type: string) => parts.find(p => p.type === type)?.value || "0";

  const laYear = parseInt(getPart("year"));
  const laMonth = parseInt(getPart("month")) - 1;
  const laDay = parseInt(getPart("day"));

  // Create date in LA timezone context
  const todayLA = new Date(laYear, laMonth, laDay);

  // Format as ISO with timezone offset for LA (PST = -08:00, PDT = -07:00)
  // Determine if we're in PST or PDT based on the date
  const jan = new Date(laYear, 0, 1);
  const jul = new Date(laYear, 6, 1);
  const stdOffset = Math.max(jan.getTimezoneOffset(), jul.getTimezoneOffset());
  const isDST = now.getTimezoneOffset() < stdOffset;
  const tzOffset = isDST ? "-07:00" : "-08:00";

  const formatDate = (d: Date) => {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  };

  // Check if rangeType is "week_of:YYYY-MM-DD" format (for "week of [date]" queries)
  const weekOfMatch = rangeType.match(/^week_of:(\d{4})-(\d{2})-(\d{2})$/);
  if (weekOfMatch) {
    // Parse the date and find the Sunday-Saturday week containing it
    const [, yearStr, monthStr, dayStr] = weekOfMatch;
    const targetDate = new Date(parseInt(yearStr), parseInt(monthStr) - 1, parseInt(dayStr));
    const dayOfWeek = targetDate.getDay(); // 0 = Sunday, 6 = Saturday

    // Calculate Sunday (start of week)
    const sunday = new Date(targetDate);
    sunday.setDate(targetDate.getDate() - dayOfWeek);

    // Calculate Saturday (end of week)
    const saturday = new Date(sunday);
    saturday.setDate(sunday.getDate() + 6);

    return {
      timeMin: `${formatDate(sunday)}T00:00:00${tzOffset}`,
      timeMax: `${formatDate(saturday)}T23:59:59${tzOffset}`,
    };
  }

  // Check if rangeType is a specific date in ISO format (YYYY-MM-DD)
  const isoDateMatch = rangeType.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoDateMatch) {
    // It's a specific date - return that exact day
    const specificDate = rangeType;
    return {
      timeMin: `${specificDate}T00:00:00${tzOffset}`,
      timeMax: `${specificDate}T23:59:59${tzOffset}`,
    };
  }

  let startDate: Date;
  let endDate: Date;

  switch (rangeType.toLowerCase()) {
    case "today":
      startDate = new Date(todayLA);
      endDate = new Date(todayLA);
      break;

    case "yesterday":
      startDate = new Date(todayLA);
      startDate.setDate(startDate.getDate() - 1);
      endDate = new Date(startDate);
      break;

    case "tomorrow":
      startDate = new Date(todayLA);
      startDate.setDate(startDate.getDate() + 1);
      endDate = new Date(startDate);
      break;

    case "last_week":
    case "last week":
    case "past week":
      startDate = new Date(todayLA);
      startDate.setDate(startDate.getDate() - 7);
      endDate = new Date(todayLA);
      break;

    case "this_week":
    case "this week":
      // Get Monday of current week
      startDate = new Date(todayLA);
      const dayOfWeek = startDate.getDay();
      const daysToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
      startDate.setDate(startDate.getDate() - daysToMonday);
      // Get Sunday
      endDate = new Date(startDate);
      endDate.setDate(endDate.getDate() + 6);
      break;

    case "next_week":
    case "next week":
      // Get next Monday
      startDate = new Date(todayLA);
      const dow = startDate.getDay();
      const daysUntilMonday = dow === 0 ? 1 : 8 - dow;
      startDate.setDate(startDate.getDate() + daysUntilMonday);
      // Get next Sunday
      endDate = new Date(startDate);
      endDate.setDate(endDate.getDate() + 6);
      break;

    case "last_month":
    case "last month":
    case "past month":
      startDate = new Date(todayLA);
      startDate.setDate(startDate.getDate() - 30);
      endDate = new Date(todayLA);
      break;

    case "upcoming":
    case "schedule":
    default:
      startDate = new Date(todayLA);
      endDate = new Date(todayLA);
      endDate.setDate(endDate.getDate() + 7);
      break;
  }

  return {
    timeMin: `${formatDate(startDate)}T00:00:00${tzOffset}`,
    timeMax: `${formatDate(endDate)}T23:59:59${tzOffset}`,
  };
}

// Format events in clean, readable format - NO LIMIT on events shown
function formatEventsMessage(events: CalendarEvent[], rangeDescription: string, showCalendarName: boolean = false): string {
  if (events.length === 0) {
    return `You don't have any appointments ${rangeDescription}.`;
  }

  // Group events by date
  const grouped: Record<string, CalendarEvent[]> = {};

  for (const event of events) {
    const dateKey = event.start.split("T")[0] || event.start;
    if (!grouped[dateKey]) {
      grouped[dateKey] = [];
    }
    grouped[dateKey].push(event);
  }

  // Sort dates
  const sortedDates = Object.keys(grouped).sort();

  const eventBlocks: string[] = [];

  for (const dateKey of sortedDates) {
    const dateEvents = grouped[dateKey];
    const dateObj = new Date(dateKey + "T12:00:00");

    // Format date: "Monday, January 8, 2026"
    const dateFormatted = dateObj.toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
      timeZone: "America/Los_Angeles",
    });

    // Sort events within the day by time
    dateEvents.sort((a, b) => a.start.localeCompare(b.start));

    for (const event of dateEvents) {
      // Format time in 12-hour format
      let timeStr: string;
      if (event.start.includes("T")) {
        const startTime = new Date(event.start);
        timeStr = startTime.toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
          timeZone: "America/Los_Angeles",
        });
      } else {
        timeStr = "All day";
      }

      // Build event title with optional calendar badge
      const calBadge = showCalendarName && event.calendarName ? `[${event.calendarName}] ` : "";
      const eventTitle = `${calBadge}${event.title}`;

      // Location or N/A
      const locationStr = event.location || "N/A";

      // Build the event block with emojis
      eventBlocks.push(
        `📅 DATE: ${dateFormatted}\n📌 EVENT: ${eventTitle}\n🕐 TIME: ${timeStr}\n📍 LOCATION: ${locationStr}`
      );
    }
  }

  // Join all events with blank lines between them
  const result = `Here are your appointments ${rangeDescription}:\n\n${eventBlocks.join("\n\n")}`;

  return result;
}



// Generate short speech summary for TTS - natural, conversational, max 1-2 sentences
function formatEventsSpeech(events: CalendarEvent[], rangeDescription: string): string {
  if (events.length === 0) {
    return `You have no appointments ${rangeDescription}.`;
  }

  if (events.length === 1) {
    const event = events[0];
    const timeStr = event.start.includes('T')
      ? new Date(event.start).toLocaleTimeString('en-US', {
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
          timeZone: 'America/Los_Angeles',
        })
      : 'all day';
    // Short location - just city or first part
    const shortLocation = event.location
      ? event.location.split(',')[0].trim()
      : null;
    const locationPart = shortLocation ? ` in ${shortLocation}` : '';
    return `You have ${event.title} at ${timeStr}${locationPart}.`;
  }

  // Multiple events - group by day and summarize
  const grouped: Record<string, CalendarEvent[]> = {};
  for (const event of events) {
    const dateKey = event.start.split('T')[0] || event.start;
    if (!grouped[dateKey]) grouped[dateKey] = [];
    grouped[dateKey].push(event);
  }

  const days = Object.keys(grouped).sort();
  
  if (days.length === 1) {
    // All on same day
    const dayEvents = grouped[days[0]];
    if (dayEvents.length <= 3) {
      // List them briefly
      const parts = dayEvents.map(e => {
        const time = e.start.includes('T')
          ? new Date(e.start).toLocaleTimeString('en-US', {
              hour: 'numeric',
              minute: '2-digit',
              hour12: true,
              timeZone: 'America/Los_Angeles',
            })
          : '';
        return time ? `${e.title} at ${time}` : e.title;
      });
      return `You have ${dayEvents.length} appointments ${rangeDescription}: ${parts.join(', and ')}.`;
    } else {
      return `You have ${dayEvents.length} appointments ${rangeDescription}.`;
    }
  }

  // Multiple days
  if (events.length <= 5) {
    // Brief summary of each
    const summaries: string[] = [];
    for (const day of days.slice(0, 3)) {
      const dayEvents = grouped[day];
      const dayName = new Date(day + 'T12:00:00').toLocaleDateString('en-US', {
        weekday: 'long',
        timeZone: 'America/Los_Angeles',
      });
      if (dayEvents.length === 1) {
        summaries.push(`${dayEvents[0].title} on ${dayName}`);
      } else {
        summaries.push(`${dayEvents.length} on ${dayName}`);
      }
    }
    return `You have ${events.length} appointments ${rangeDescription}: ${summaries.join(', ')}.`;
  }

  return `You have ${events.length} appointments ${rangeDescription}.`;
}

export async function POST(request: NextRequest) {
  // Create Supabase client to verify auth and get session
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

  if (authError || !session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { message, conversationHistory, calendars } = await request.json();

  // calendars is an optional array of { id, name, color } for multi-calendar search
  const activeCalendars: CalendarInfo[] = Array.isArray(calendars) ? calendars : [];

  if (!message || typeof message !== "string") {
    return NextResponse.json({ error: "Message is required" }, { status: 400 });
  }

  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    console.error("[Chat API] OpenAI API key not configured");
    return NextResponse.json({ error: "AI service not configured" }, { status: 500 });
  }

  // Get current date in user's timezone (America/Los_Angeles)
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const currentDate = formatter.format(now);

  // Get ISO date for calculations
  const isoFormatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const todayISO = isoFormatter.format(now);

  // Extract current year for the prompt
  const currentYear = now.getFullYear();

  const systemPrompt = `You are a calendar assistant. Be EXTREMELY brief. Never be conversational.

TODAY: ${currentDate}
TODAY'S DATE: ${todayISO}
CURRENT YEAR: ${currentYear}

=== STRICT RULES FOR EVENT CREATION ===

RULE 1: ONE QUESTION AT A TIME
Never combine questions. Ask exactly one thing, wait for answer.

RULE 2: ULTRA-SHORT RESPONSES (3-6 words max)
GOOD: "What time?"
BAD: "What time would you like to schedule this appointment for?"

GOOD: "What's it for?"
BAD: "What would you like me to call this appointment?"

RULE 3: QUESTION SEQUENCE
When creating events, collect info in this order:
1. DATE (if missing)
2. TITLE (if missing)
3. TIME (if missing - or accept "all day")

RULE 4: DECISION TREE FOR MISSING INFO

Has DATE only → Ask: "What's it for?"
Has DATE + TITLE → Ask: "What time?"
Has DATE + TIME → Ask: "What's it for?"
Has TITLE only → Ask: "What date?"
Has TIME only → Ask: "What date?"
Has TITLE + TIME → Ask: "What date?"
Has DATE + TITLE + TIME → CREATE IMMEDIATELY (no question)

RULE 5: ACCEPT "ALL DAY"
If user says "all day", "no time", "doesn't matter" → set allDay: true, proceed

RULE 6: SMART PARSING - Accept messy input
"dr appt tmrw 2" → Doctor appointment, tomorrow, 2:00 PM
"dentist 3/15 2pm" → Dentist, March 15, 2:00 PM
"lunch sarah fri" → Lunch with Sarah, this Friday
"2" or "2pm" or "at 2" → 14:00

RULE 7: SMART DEFAULTS
- Year: ${currentYear} (unless specified)
- Duration: 60 minutes
- Recurrence: none
- "tomorrow" / "tmrw" / "tom" = tomorrow's date
- "next [day]" = next occurrence of that day

RULE 8: SPECIFIC TITLES - Create immediately
These are specific enough (no need to ask):
- Any name: "dr johnson", "sarah", "mom"
- Any profession: "dentist", "doctor", "lawyer", "vet"
- Any activity: "haircut", "oil change", "lunch", "dinner", "breakfast"
- Any descriptor: "team meeting", "doctor appt", "work thing"

RULE 9: VAGUE TITLES - Ask once
Only ask "What's it for?" if user says JUST:
- "appointment" / "appt" (with no other words)
- "meeting" (alone)
- "event" (alone)
- "thing" (alone)

=== RESPONSE FORMAT ===

Always respond with valid JSON. Include both "message" (for display) and "speech" (for voice).
- "message": Full text for UI display
- "speech": Short natural summary for TTS (1-2 sentences max, no addresses, conversational)

For CREATING (has all info):
{
  "message": "Dentist on March 15 at 2pm?",
  "speech": "Dentist March 15 at 2?",
  "action": "create",
  "appointment": {
    "date": "YYYY-MM-DD",
    "time": "HH:MM",
    "title": "Title",
    "description": null,
    "duration": 60,
    "allDay": false,
    "recurrence": "none",
    "needsClarification": false,
    "clarificationMessage": null
  },
  "readRange": null
}

For CREATING (missing info - ask ONE question):
{
  "message": "What time?",
  "speech": "What time?",
  "action": "create",
  "appointment": {
    "date": "2026-03-15",
    "time": null,
    "title": "Dentist",
    "description": null,
    "duration": 60,
    "allDay": false,
    "recurrence": "none",
    "needsClarification": true,
    "clarificationMessage": "What time?"
  },
  "readRange": null
}

For READING events:
{
  "message": "Checking...",
  "speech": "Checking your calendar.",
  "action": "read",
  "appointment": null,
  "readRange": "today|tomorrow|yesterday|this_week|next_week|last_week|upcoming|YYYY-MM-DD|week_of:YYYY-MM-DD"
}

For DELETING events:
{
  "message": "Which one?",
  "speech": "Which one?",
  "action": "delete",
  "appointment": null,
  "readRange": null,
  "deleteSearch": {
    "searchTerm": "title or null",
    "date": "YYYY-MM-DD or null",
    "time": "HH:MM or null",
    "timeRangeStart": null,
    "timeRangeEnd": null,
    "needsClarification": true/false,
    "clarificationQuestion": null
  }
}

For general:
{
  "message": "response",
  "speech": "short response for voice",
  "action": "none",
  "appointment": null,
  "readRange": null
}

=== EXAMPLES ===

User: "dentist march 15 2pm"
→ {"message": "Dentist on March 15 at 2pm?", "action": "create", "appointment": {"date": "${currentYear}-03-15", "time": "14:00", "title": "Dentist", "duration": 60, "allDay": false, "recurrence": "none", "needsClarification": false}, "readRange": null}

User: "appointment tomorrow"
→ {"message": "What's it for?", "action": "create", "appointment": {"date": "TOMORROW", "time": null, "title": null, "needsClarification": true}, "readRange": null}

User: (after above) "dentist"
→ {"message": "What time?", "action": "create", "appointment": {"date": "TOMORROW", "time": null, "title": "Dentist", "needsClarification": true}, "readRange": null}

User: (after above) "2"
→ {"message": "Dentist tomorrow at 2pm?", "action": "create", "appointment": {"date": "TOMORROW", "time": "14:00", "title": "Dentist", "needsClarification": false}, "readRange": null}

User: "oil change friday"
→ {"message": "What time?", "action": "create", "appointment": {"date": "NEXT_FRIDAY", "time": null, "title": "Oil Change", "needsClarification": true}, "readRange": null}

User: "all day"
→ {"message": "Oil Change on Friday, all day?", "action": "create", "appointment": {"date": "NEXT_FRIDAY", "time": null, "title": "Oil Change", "allDay": true, "needsClarification": false}, "readRange": null}

User: "what do i have tomorrow"
→ {"message": "Checking...", "action": "read", "readRange": "tomorrow"}

User: "delete the dentist"
→ {"message": "Looking...", "action": "delete", "deleteSearch": {"searchTerm": "dentist", "date": null, "time": null}}

User: "hi" or "hello"
→ {"message": "What can I schedule?", "action": "none"}

REMEMBER: Be terse. One question. Short responses. Get to the point.`;

  // Build messages array with conversation history
  const messages: Array<{ role: string; content: string }> = [
    { role: "system", content: systemPrompt },
  ];

  // Add conversation history if provided
  if (Array.isArray(conversationHistory)) {
    for (const msg of conversationHistory) {
      if (msg.role === "user" || msg.role === "assistant") {
        messages.push({ role: msg.role, content: msg.content });
      }
    }
  }

  // Add current message
  messages.push({ role: "user", content: message });

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${openaiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages,
        temperature: 0.3,
        max_tokens: 500,
        response_format: { type: "json_object" },
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error("[Chat API] OpenAI error:", error);
      return NextResponse.json({ error: "AI service error" }, { status: 500 });
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      return NextResponse.json({ error: "No response from AI" }, { status: 500 });
    }

    // Parse the JSON response
    let parsed: ChatResponse;
    try {
      parsed = JSON.parse(content);
    } catch {
      console.error("[Chat API] Failed to parse AI response:", content);
      return NextResponse.json({
        message: "I had trouble understanding that. Could you rephrase?",
        speech: "I had trouble understanding that. Could you rephrase?",
        action: "none",
        appointment: null,
        readRange: null,
      });
    }

    // If action is "read", calculate date range server-side and fetch events
    if (parsed.action === "read" && parsed.readRange) {
      const providerToken = session.provider_token;

      if (!providerToken) {
        return NextResponse.json({
          message: "I can't access your calendar. Please sign out and sign in again to grant calendar permissions.",
          speech: "I can't access your calendar. Please sign out and sign in again.",
          action: "none",
          appointment: null,
          readRange: null,
        });
      }

      // Calculate the date range SERVER-SIDE for accuracy
      const dateRange = calculateDateRange(parsed.readRange);

      // Determine which calendars to search
      // If activeCalendars provided, use those; otherwise just search primary
      const calendarsToSearch: CalendarInfo[] = activeCalendars.length > 0
        ? activeCalendars
        : [{ id: "primary", name: "Primary", color: "#4285f4" }];

      // Log for debugging
      console.log("[Chat API] Reading events:", {
        rangeType: parsed.readRange,
        timeMin: dateRange.timeMin,
        timeMax: dateRange.timeMax,
        calendars: calendarsToSearch.map(c => c.name),
      });

      try {
        const params = new URLSearchParams({
          timeMin: dateRange.timeMin,
          timeMax: dateRange.timeMax,
          maxResults: "2500", // No artificial limit - show all events
          singleEvents: "true",
          orderBy: "startTime",
        });

        // Fetch events from ALL active calendars in parallel
        const fetchPromises = calendarsToSearch.map(async (cal) => {
          try {
            const response = await fetch(
              `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events?${params}`,
              {
                headers: {
                  Authorization: `Bearer ${providerToken}`,
                },
              }
            );

            if (!response.ok) {
              console.error(`[Chat API] Failed to fetch calendar ${cal.name}:`, await response.text());
              return [];
            }

            const data = await response.json();
            return (data.items || []).map((event: {
              id: string;
              summary?: string;
              start: { dateTime?: string; date?: string };
              end: { dateTime?: string; date?: string };
              location?: string;
            }) => ({
              id: event.id,
              title: event.summary || "(No title)",
              start: event.start.dateTime || event.start.date,
              end: event.end.dateTime || event.end.date,
              location: event.location,
              calendarId: cal.id,
              calendarName: cal.name,
              calendarColor: cal.color,
            }));
          } catch (err) {
            console.error(`[Chat API] Error fetching calendar ${cal.name}:`, err);
            return [];
          }
        });

        const allEventsArrays = await Promise.all(fetchPromises);

        // Flatten and sort all events by start time
        const events: CalendarEvent[] = allEventsArrays
          .flat()
          .sort((a, b) => a.start.localeCompare(b.start));

        // Create human-readable range description
        const rangeDescriptions: Record<string, string> = {
          today: "for today",
          yesterday: "from yesterday",
          tomorrow: "for tomorrow",
          last_week: "from the past week",
          "last week": "from the past week",
          this_week: "for this week",
          "this week": "for this week",
          next_week: "for next week",
          "next week": "for next week",
          last_month: "from the past month",
          "last month": "from the past month",
          upcoming: "coming up",
        };

        // Check if it's a specific date (YYYY-MM-DD format) or week_of format
        let rangeDescription = rangeDescriptions[parsed.readRange] || "";

        // Handle "week_of:YYYY-MM-DD" format
        const weekOfMatch = parsed.readRange.match(/^week_of:(\d{4}-\d{2}-\d{2})$/);
        if (!rangeDescription && weekOfMatch) {
          const targetDate = new Date(weekOfMatch[1] + "T12:00:00");
          const formattedDate = targetDate.toLocaleDateString("en-US", {
            month: "long",
            day: "numeric",
            year: "numeric",
            timeZone: "America/Los_Angeles",
          });
          rangeDescription = `for the week of ${formattedDate}`;
        }
        // Handle specific date (YYYY-MM-DD format)
        else if (!rangeDescription && parsed.readRange.match(/^\d{4}-\d{2}-\d{2}$/)) {
          // Format the specific date nicely
          const specificDate = new Date(parsed.readRange + "T12:00:00");
          const formattedDate = specificDate.toLocaleDateString("en-US", {
            weekday: "long",
            month: "long",
            day: "numeric",
            year: "numeric",
            timeZone: "America/Los_Angeles",
          });
          rangeDescription = `for ${formattedDate}`;
        }
        // Show calendar names if searching multiple calendars
        const showCalendarNames = calendarsToSearch.length > 1;
        const eventsMessage = formatEventsMessage(events, rangeDescription, showCalendarNames);
        const eventsSpeech = formatEventsSpeech(events, rangeDescription);

        return NextResponse.json({
          message: eventsMessage,
          speech: eventsSpeech,
          action: "none",
          appointment: null,
          readRange: null,
          events,
        });
      } catch (error) {
        console.error("[Chat API] Error fetching events:", error);
        return NextResponse.json({
          message: "I had trouble fetching your calendar. Please try again.",
          speech: "I had trouble fetching your calendar. Please try again.",
          action: "none",
          appointment: null,
          readRange: null,
        });
      }
    }

    // If action is "delete", search for matching events
    if (parsed.action === "delete" && parsed.deleteSearch) {
      const { searchTerm, date, time, timeRangeStart, timeRangeEnd, needsClarification } = parsed.deleteSearch;

      // If AI is asking for clarification, return the message without searching
      if (needsClarification) {
        return NextResponse.json({
          message: parsed.message,
          action: "none", // Don't trigger delete flow yet
          appointment: null,
          readRange: null,
        });
      }

      const providerToken = session.provider_token;

      if (!providerToken) {
        return NextResponse.json({
          message: "I can't access your calendar. Please sign out and sign in again to grant calendar permissions.",
          speech: "I can't access your calendar. Please sign out and sign in again.",
          action: "none",
          appointment: null,
          readRange: null,
        });
      }

      // Determine date range to search
      let timeMin: string;
      let timeMax: string;

      // Get timezone offset (PST/PDT)
      const nowDate = new Date();
      const jan = new Date(nowDate.getFullYear(), 0, 1);
      const jul = new Date(nowDate.getFullYear(), 6, 1);
      const stdOffset = Math.max(jan.getTimezoneOffset(), jul.getTimezoneOffset());
      const isDST = nowDate.getTimezoneOffset() < stdOffset;
      const tzOffset = isDST ? "-07:00" : "-08:00";

      if (date) {
        // Search specific date
        timeMin = `${date}T00:00:00${tzOffset}`;
        timeMax = `${date}T23:59:59${tzOffset}`;
      } else {
        // Search upcoming 30 days and past 30 days
        const now = new Date();
        const past = new Date(now);
        past.setDate(past.getDate() - 30);
        const future = new Date(now);
        future.setDate(future.getDate() + 30);

        const formatDate = (d: Date) => d.toISOString().split("T")[0];
        timeMin = `${formatDate(past)}T00:00:00${tzOffset}`;
        timeMax = `${formatDate(future)}T23:59:59${tzOffset}`;
      }

      // Time filters
      const filterTime = time; // e.g., "13:00" - specific time
      const filterTimeRangeStart = timeRangeStart; // e.g., "12:00" - range start
      const filterTimeRangeEnd = timeRangeEnd; // e.g., "17:00" - range end

      const calendarsToSearch: CalendarInfo[] = activeCalendars.length > 0
        ? activeCalendars
        : [{ id: "primary", name: "Primary", color: "#4285f4" }];

      try {
        const params = new URLSearchParams({
          timeMin,
          timeMax,
          maxResults: "100",
          singleEvents: "true",
          orderBy: "startTime",
        });

        // Fetch events from all calendars
        const fetchPromises = calendarsToSearch.map(async (cal) => {
          try {
            const response = await fetch(
              `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events?${params}`,
              {
                headers: {
                  Authorization: `Bearer ${providerToken}`,
                },
              }
            );

            if (!response.ok) return [];

            const data = await response.json();
            return (data.items || []).map((event: {
              id: string;
              summary?: string;
              start: { dateTime?: string; date?: string };
              end: { dateTime?: string; date?: string };
              location?: string;
            }) => ({
              id: event.id,
              title: event.summary || "(No title)",
              start: event.start.dateTime || event.start.date,
              end: event.end.dateTime || event.end.date,
              location: event.location,
              calendarId: cal.id,
              calendarName: cal.name,
            }));
          } catch {
            return [];
          }
        });

        const allEventsArrays = await Promise.all(fetchPromises);
        let events: CalendarEvent[] = allEventsArrays.flat();

        // Filter by search term if provided
        if (searchTerm) {
          const searchLower = searchTerm.toLowerCase();
          events = events.filter(e =>
            e.title.toLowerCase().includes(searchLower)
          );
        }

        // Filter by specific time if provided
        if (filterTime) {
          const [filterHour, filterMin] = filterTime.split(":").map(Number);
          events = events.filter(e => {
            if (!e.start.includes("T")) return false; // Skip all-day events
            const eventDate = new Date(e.start);
            const eventHour = eventDate.getHours();
            const eventMin = eventDate.getMinutes();
            // Match within the same hour (allow some flexibility)
            return eventHour === filterHour && Math.abs(eventMin - filterMin) <= 30;
          });
        }

        // Filter by time range if provided
        if (filterTimeRangeStart && filterTimeRangeEnd) {
          const [startHour, startMin] = filterTimeRangeStart.split(":").map(Number);
          const [endHour, endMin] = filterTimeRangeEnd.split(":").map(Number);
          const rangeStartMinutes = startHour * 60 + startMin;
          const rangeEndMinutes = endHour * 60 + endMin;

          events = events.filter(e => {
            if (!e.start.includes("T")) return false; // Skip all-day events
            const eventDate = new Date(e.start);
            const eventMinutes = eventDate.getHours() * 60 + eventDate.getMinutes();
            return eventMinutes >= rangeStartMinutes && eventMinutes <= rangeEndMinutes;
          });
        }

        if (events.length === 0) {
          return NextResponse.json({
            message: "I couldn't find any appointments matching that. Can you give me more details like the exact time or what the appointment is for?",
            speech: "I couldn't find that appointment. Can you give me more details?",
            action: "none",
            appointment: null,
            readRange: null,
          });
        }

        if (events.length === 1) {
          // Found exactly one match - return it for confirmation
          const evt = events[0];
          const evtTime = evt.start.includes('T')
            ? new Date(evt.start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/Los_Angeles' })
            : 'all day';
          return NextResponse.json({
            message: parsed.message,
            speech: `Delete ${evt.title} at ${evtTime}?`,
            action: "delete",
            appointment: null,
            readRange: null,
            deleteEvent: events[0],
          });
        }

        // Multiple matches - return interactive selection
        const eventsToShow = events.slice(0, 10);

        return NextResponse.json({
          message: `I found ${events.length} appointment${events.length > 1 ? "s" : ""} matching your request. Select which ones to delete:`,
          speech: `Found ${events.length} matching appointments. Please select on screen.`,
          action: "delete_multiple",
          appointment: null,
          readRange: null,
          multipleEvents: eventsToShow,
        });

      } catch (error) {
        console.error("[Chat API] Error searching for events to delete:", error);
        return NextResponse.json({
          message: "I had trouble searching your calendar. Please try again.",
          speech: "I had trouble searching your calendar. Please try again.",
          action: "none",
          appointment: null,
          readRange: null,
        });
      }
    }

    // Ensure speech field exists (use message as fallback)
    const finalResponse = {
      ...parsed,
      speech: parsed.speech || parsed.message,
    };
    return NextResponse.json(finalResponse);
  } catch (error) {
    console.error("[Chat API] Request error:", error);
    return NextResponse.json({ error: "Failed to process request" }, { status: 500 });
  }
}
