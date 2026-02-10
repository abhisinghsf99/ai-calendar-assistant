"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

// TypeScript declarations for Web Speech API
interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList;
  resultIndex: number;
}

interface SpeechRecognitionErrorEvent extends Event {
  error: string;
  message?: string;
}

interface SpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}

declare global {
  interface Window {
    SpeechRecognition: new () => SpeechRecognition;
    webkitSpeechRecognition: new () => SpeechRecognition;
  }
}

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  eventLink?: string; // Optional link to created event
  type?: "text" | "event_selection"; // Message type
  selectableEvents?: DeleteEventData[]; // Events for selection
}

interface AppointmentData {
  date: string | null;
  time: string | null;
  title: string | null;
  description: string | null;
  duration: number;
  needsClarification: boolean;
  clarificationMessage: string | null;
  allDay?: boolean;
  recurrence?: string;
}

interface Calendar {
  id: string;
  summary: string;
  primary: boolean;
  backgroundColor: string;
}

interface DeleteEventData {
  id: string;
  title: string;
  start: string;
  end: string;
  calendarId: string;
  calendarName?: string;
}

const STORAGE_KEY_ACTIVE_CALENDARS = "calAssist_activeCalendars";
const STORAGE_KEY_LAST_CALENDAR = "calAssist_lastUsedCalendar";

export default function Chat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [calendars, setCalendars] = useState<Calendar[]>([]);
  const [activeCalendarIds, setActiveCalendarIds] = useState<Set<string>>(new Set());
  const [menuOpen, setMenuOpen] = useState(false);
  const [calendarsLoaded, setCalendarsLoaded] = useState(false);
  const [pendingAppointment, setPendingAppointment] = useState<AppointmentData | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<DeleteEventData | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [selectedEventIds, setSelectedEventIds] = useState<Set<string>>(new Set());
  const [isDeletingMultiple, setIsDeletingMultiple] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const [successMessage, setSuccessMessage] = useState("");
  const [successLink, setSuccessLink] = useState<string | null>(null);
  const [selectedCalendarId, setSelectedCalendarId] = useState<string>("");

  // Voice mode state - simplified
  const [isVoiceMode, setIsVoiceMode] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState("");
  const [voiceStatus, setVoiceStatus] = useState<"idle" | "listening" | "processing" | "speaking">("idle");

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const voiceModeRef = useRef(false);
  const isMutedRef = useRef(false);
  const isProcessingRef = useRef(false);
  const silenceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const restartTimerRef = useRef<NodeJS.Timeout | null>(null);
  const currentTranscriptRef = useRef<string>("");
  const router = useRouter();
  const supabase = createClient();

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) router.replace("/");
      else loadCalendarsOnMount();
    });
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height =
        Math.min(textareaRef.current.scrollHeight, 96) + "px";
    }
  }, [input]);

  // Load calendars on mount for multi-calendar search
  async function loadCalendarsOnMount() {
    try {
      const response = await fetch("/api/calendars/list");
      const data = await response.json();

      if (response.ok && data.calendars) {
        setCalendars(data.calendars);
        setCalendarsLoaded(true);

        // Load saved active calendars from localStorage
        const savedActive = localStorage.getItem(STORAGE_KEY_ACTIVE_CALENDARS);
        if (savedActive) {
          try {
            const savedIds = JSON.parse(savedActive);
            const validIds = savedIds.filter((id: string) =>
              data.calendars.some((c: Calendar) => c.id === id)
            );
            setActiveCalendarIds(new Set(validIds.length > 0 ? validIds : data.calendars.map((c: Calendar) => c.id)));
          } catch {
            setActiveCalendarIds(new Set(data.calendars.map((c: Calendar) => c.id)));
          }
        } else {
          setActiveCalendarIds(new Set(data.calendars.map((c: Calendar) => c.id)));
        }
      }
    } catch (error) {
      console.error("Error loading calendars:", error);
    }
  }

  // Auto-focus input when not sending
  useEffect(() => {
    if (!sending) {
      setTimeout(() => {
        textareaRef.current?.focus();
      }, 100);
    }
  }, [sending]);

  async function handleSignOut() {
    setMessages([]); // Clear chat on signout
    await supabase.auth.signOut();
    router.replace("/");
  }

  // Clear chat and reset all state
  function clearChat() {
    setMessages([]);
    setPendingAppointment(null);
    setShowConfirm(false);
    setPendingDelete(null);
    setShowDeleteConfirm(false);
    setSelectedEventIds(new Set());
    setShowSuccess(false);
    setSelectedCalendarId("");
    setMenuOpen(false);
  }

  function toggleCalendarActive(calendarId: string) {
    setActiveCalendarIds((prev) => {
      const next = new Set(prev);
      if (next.has(calendarId)) {
        if (next.size > 1) {
          next.delete(calendarId);
        }
      } else {
        next.add(calendarId);
      }
      localStorage.setItem(STORAGE_KEY_ACTIVE_CALENDARS, JSON.stringify([...next]));
      return next;
    });
  }

  function getActiveCalendars() {
    return calendars.filter((c) => activeCalendarIds.has(c.id));
  }

  function getPrimaryCalendar(): Calendar | undefined {
    return calendars.find((c) => c.primary) || calendars[0];
  }

  // Get default calendar: last used → primary → first available
  function getDefaultCalendarId(): string {
    // 1. Try last used
    const lastUsed = localStorage.getItem(STORAGE_KEY_LAST_CALENDAR);
    if (lastUsed && calendars.some((c) => c.id === lastUsed)) {
      return lastUsed;
    }
    // 2. Try primary
    const primary = calendars.find((c) => c.primary);
    if (primary) return primary.id;
    // 3. First calendar
    return calendars[0]?.id || "";
  }

  // Create event directly via API
  async function createEvent(appointment: AppointmentData, calendarId?: string): Promise<{ success: boolean; link?: string; error?: string }> {
    // Use provided calendarId, or fall back to primary
    const targetCalendarId = calendarId || getPrimaryCalendar()?.id;
    if (!targetCalendarId) {
      return { success: false, error: "No calendar available" };
    }

    try {
      const response = await fetch("/api/calendars/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          calendarId: targetCalendarId,
          title: appointment.title,
          description: appointment.description || undefined,
          date: appointment.date,
          time: appointment.allDay ? undefined : appointment.time,
          duration: appointment.allDay ? undefined : (appointment.duration || 60),
          allDay: appointment.allDay || false,
          recurrence: appointment.recurrence || "none",
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        return { success: false, error: data.error || "Failed to create event" };
      }

      return { success: true, link: data.event.htmlLink };
    } catch (error) {
      console.error("Error creating event:", error);
      return { success: false, error: "Failed to create event" };
    }
  }

  // Format appointment for display
  function formatAppointmentConfirmation(appt: AppointmentData): string {
    const dateObj = new Date(appt.date + "T12:00:00");
    const dateStr = dateObj.toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
      timeZone: "America/Los_Angeles",
    });

    if (appt.allDay) {
      let msg = `${appt.title} scheduled as an all-day event on ${dateStr}`;
      if (appt.recurrence && appt.recurrence !== "none") {
        msg += `, repeating ${appt.recurrence}`;
      }
      return msg;
    }

    // Format time
    const [hours, minutes] = (appt.time || "09:00").split(":");
    const hour = parseInt(hours);
    const ampm = hour >= 12 ? "PM" : "AM";
    const hour12 = hour % 12 || 12;
    const timeStr = `${hour12}:${minutes} ${ampm}`;

    let msg = `${appt.title} scheduled for ${dateStr} at ${timeStr}`;
    if (appt.recurrence && appt.recurrence !== "none") {
      msg += `, repeating ${appt.recurrence}`;
    }
    return msg;
  }

  async function handleSend() {
    const text = input.trim();
    if (!text || sending) return;

    const userMsg: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
    };

    setInput("");
    setSending(true);
    setMessages((prev) => [...prev, userMsg]);

    try {
      // Only send last 4 messages for short-term context (clarification flow)
      // This prevents old conversations from confusing the AI
      const recentMessages = messages.slice(-4);
      const conversationHistory = recentMessages.map((m) => ({
        role: m.role,
        content: m.content,
      }));

      // Build active calendars array for multi-calendar search
      const activeCalendarsForApi = getActiveCalendars().map((c) => ({
        id: c.id,
        name: c.summary,
        color: c.backgroundColor,
      }));

      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          conversationHistory,
          calendars: activeCalendarsForApi,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to process message");
      }

      // Handle create action - show confirmation modal
      if (data.action === "create" && data.appointment) {
        const appt = data.appointment as AppointmentData;

        // Check if we need clarification (missing title or explicit flag)
        const needsMoreInfo = !appt.title || appt.needsClarification || !appt.date || (!appt.allDay && !appt.time);

        if (!needsMoreInfo) {
          // We have all the info - show confirmation modal directly (no AI message first)
          setPendingAppointment(appt);
          setSelectedCalendarId(getDefaultCalendarId()); // Set default calendar
          setShowConfirm(true);
        } else {
          // Need clarification - show the AI's response asking for more info
          const assistantMsg: Message = {
            id: crypto.randomUUID(),
            role: "assistant",
            content: data.message,
          };
          setMessages((prev) => [...prev, assistantMsg]);
        }
      } else if (data.action === "delete" && data.deleteEvent) {
        // Handle delete action - show delete confirmation modal for single event
        setPendingDelete(data.deleteEvent as DeleteEventData);
        setShowDeleteConfirm(true);
      } else if (data.action === "delete_multiple" && data.multipleEvents) {
        // Handle multiple events - show interactive selection
        setSelectedEventIds(new Set()); // Reset selection
        const selectionMsg: Message = {
          id: crypto.randomUUID(),
          role: "assistant",
          content: data.message,
          type: "event_selection",
          selectableEvents: data.multipleEvents as DeleteEventData[],
        };
        setMessages((prev) => [...prev, selectionMsg]);
      } else {
        // For read actions or general conversation, just show the response
        const assistantMsg: Message = {
          id: crypto.randomUUID(),
          role: "assistant",
          content: data.message,
        };
        setMessages((prev) => [...prev, assistantMsg]);
      }
    } catch (error) {
      console.error("Error sending message:", error);
      const errorMsg: Message = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: "Sorry, I had trouble processing that. Please try again.",
      };
      setMessages((prev) => [...prev, errorMsg]);
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  // Handle confirmation - with success celebration
  async function handleConfirmCreate() {
    if (!pendingAppointment) return;

    setIsCreating(true);
    const result = await createEvent(pendingAppointment, selectedCalendarId);
    setIsCreating(false);
    setShowConfirm(false);

    // Save selected calendar as default for next time
    if (selectedCalendarId) {
      localStorage.setItem(STORAGE_KEY_LAST_CALENDAR, selectedCalendarId);
    }

    if (result.success) {
      // Show brief success celebration with calendar name
      const calendarName = calendars.find((c) => c.id === selectedCalendarId)?.summary || "calendar";
      setSuccessMessage(`${pendingAppointment.title} added to ${calendarName}!`);
      setSuccessLink(result.link || null);
      setShowSuccess(true);

      // Also add to messages for history
      const confirmationText = formatAppointmentConfirmation(pendingAppointment);
      const successMsg: Message = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: `✅ ${confirmationText}.`,
        eventLink: result.link,
      };
      setMessages((prev) => [...prev, successMsg]);

      // Auto-dismiss after 2 seconds
      setTimeout(() => {
        setShowSuccess(false);
        setSuccessMessage("");
        setSuccessLink(null);
      }, 2000);
    } else {
      const errorMsg: Message = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: `❌ Couldn't add event: ${result.error}. Try again?`,
      };
      setMessages((prev) => [...prev, errorMsg]);
    }

    setPendingAppointment(null);
  }

  // Handle cancel
  function handleCancelCreate() {
    setShowConfirm(false);
    setPendingAppointment(null);

    const cancelMsg: Message = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: "No problem! Let me know if you'd like to schedule something else.",
    };
    setMessages((prev) => [...prev, cancelMsg]);
  }

  // Format time for display
  function formatTimeDisplay(time: string): string {
    const [hours, minutes] = time.split(":");
    const hour = parseInt(hours);
    const ampm = hour >= 12 ? "PM" : "AM";
    const hour12 = hour % 12 || 12;
    return `${hour12}:${minutes} ${ampm}`;
  }

  // Render confirmation modal - BOTTOM SHEET STYLE for easy thumb access
  function renderConfirmModal() {
    if (!showConfirm || !pendingAppointment) return null;

    const dateObj = new Date(pendingAppointment.date + "T12:00:00");
    const dateStr = dateObj.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      timeZone: "America/Los_Angeles",
    });
    const timeStr = pendingAppointment.allDay
      ? "All day"
      : formatTimeDisplay(pendingAppointment.time || "09:00");

    return (
      <div
        className="fixed inset-0 z-50 flex items-end justify-center bg-black/40"
        onClick={handleCancelCreate}
      >
        <div
          className="w-full max-w-lg rounded-t-3xl bg-white px-6 pb-8 pt-4 shadow-2xl animate-[slideUp_0.2s_ease-out]"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Drag handle */}
          <div className="mx-auto mb-4 h-1 w-12 rounded-full bg-gray-300" />

          {/* Compact summary - all on one line when possible */}
          <div className="mb-4 text-center">
            <p className="text-xl font-semibold text-gray-900">{pendingAppointment.title}</p>
            <p className="mt-1 text-lg text-gray-600">
              {dateStr} · {timeStr}
              {pendingAppointment.recurrence && pendingAppointment.recurrence !== "none" && (
                <span className="text-gray-400"> · Repeats {pendingAppointment.recurrence}</span>
              )}
            </p>
          </div>

          {/* Calendar selector - show ALL calendars */}
          {calendars.length > 1 && (
            <div className="mb-6">
              <label className="mb-2 block text-sm font-medium text-gray-600">Add to calendar:</label>
              <select
                value={selectedCalendarId}
                onChange={(e) => setSelectedCalendarId(e.target.value)}
                className="w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-base text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              >
                {calendars.map((cal) => (
                  <option key={cal.id} value={cal.id}>
                    {cal.summary}{cal.primary ? " (Primary)" : ""}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Large buttons - 60px height for easy thumb tap */}
          <div className="space-y-3">
            <button
              onClick={handleConfirmCreate}
              disabled={isCreating}
              className="flex h-[60px] w-full items-center justify-center rounded-2xl bg-indigo-600 text-lg font-semibold text-white transition-colors hover:bg-indigo-700 active:bg-indigo-800 disabled:opacity-50"
            >
              {isCreating ? (
                <span className="flex items-center gap-3">
                  <svg className="h-6 w-6 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Adding...
                </span>
              ) : (
                <>
                  <svg className="mr-2 h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                  Confirm
                </>
              )}
            </button>
            <button
              onClick={handleCancelCreate}
              disabled={isCreating}
              className="flex h-[52px] w-full items-center justify-center rounded-2xl text-lg font-medium text-gray-500 transition-colors hover:bg-gray-100 active:bg-gray-200 disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Handle delete confirmation
  async function handleConfirmDelete() {
    if (!pendingDelete) return;

    setIsDeleting(true);

    try {
      const response = await fetch(
        `/api/calendars/events?calendarId=${encodeURIComponent(pendingDelete.calendarId)}&eventId=${encodeURIComponent(pendingDelete.id)}`,
        { method: "DELETE" }
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to delete event");
      }

      const deleteMsg: Message = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: `🗑️ ${pendingDelete.title} deleted.`,
      };
      setMessages((prev) => [...prev, deleteMsg]);
    } catch (error) {
      console.error("Error deleting event:", error);
      const errorMsg: Message = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: `❌ Sorry, I couldn't delete that event. Please try again.`,
      };
      setMessages((prev) => [...prev, errorMsg]);
    } finally {
      setIsDeleting(false);
      setShowDeleteConfirm(false);
      setPendingDelete(null);
    }
  }

  // Handle cancel delete
  function handleCancelDelete() {
    setShowDeleteConfirm(false);
    setPendingDelete(null);

    const cancelMsg: Message = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: "OK, I won't delete that event.",
    };
    setMessages((prev) => [...prev, cancelMsg]);
  }

  // Toggle event selection
  function toggleEventSelection(eventId: string) {
    setSelectedEventIds((prev) => {
      const next = new Set(prev);
      if (next.has(eventId)) {
        next.delete(eventId);
      } else {
        next.add(eventId);
      }
      return next;
    });
  }

  // Handle delete selected events
  async function handleDeleteSelected(events: DeleteEventData[], messageId: string) {
    const selectedEvents = events.filter((e) => selectedEventIds.has(e.id));
    if (selectedEvents.length === 0) return;

    setIsDeletingMultiple(true);

    let successCount = 0;
    let failCount = 0;

    for (const event of selectedEvents) {
      try {
        const response = await fetch(
          `/api/calendars/events?calendarId=${encodeURIComponent(event.calendarId)}&eventId=${encodeURIComponent(event.id)}`,
          { method: "DELETE" }
        );

        if (response.ok) {
          successCount++;
        } else {
          failCount++;
        }
      } catch {
        failCount++;
      }
    }

    // Remove the selection message and add result
    setMessages((prev) => {
      const filtered = prev.filter((m) => m.id !== messageId);
      const resultMsg: Message = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: failCount === 0
          ? `🗑️ ${successCount} event${successCount > 1 ? "s" : ""} deleted.`
          : `🗑️ ${successCount} deleted, ${failCount} failed.`,
      };
      return [...filtered, resultMsg];
    });

    setSelectedEventIds(new Set());
    setIsDeletingMultiple(false);
  }

  // Handle cancel selection
  function handleCancelSelection(messageId: string) {
    setMessages((prev) => {
      const filtered = prev.filter((m) => m.id !== messageId);
      const cancelMsg: Message = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: "OK, I won't delete any events.",
      };
      return [...filtered, cancelMsg];
    });
    setSelectedEventIds(new Set());
  }

  // ========== VOICE MODE - ROBUST IMPLEMENTATION ==========

  const retryCountRef = useRef(0);
  const maxRetries = 3;

  // Clear all timers
  const clearAllTimers = useCallback(() => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    if (restartTimerRef.current) {
      clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
    }
  }, []);

  // Speak text using OpenAI TTS API
  const speakText = useCallback(async (text: string): Promise<void> => {
    if (typeof window === "undefined" || isMuted || !text.trim()) {
      isProcessingRef.current = false;
      return;
    }

    // Stop any currently playing audio
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }

    try {
      setIsSpeaking(true);
      setVoiceStatus("speaking");

      const response = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, voice: "nova", speed: 1.05 }),
      });

      if (!response.ok) throw new Error("TTS failed");

      const audioBlob = await response.blob();
      const audioUrl = URL.createObjectURL(audioBlob);
      const audio = new Audio(audioUrl);
      audioRef.current = audio;

      await new Promise<void>((resolve) => {
        audio.onended = () => {
          setIsSpeaking(false);
          URL.revokeObjectURL(audioUrl);
          audioRef.current = null;
          resolve();
        };
        audio.onerror = () => {
          setIsSpeaking(false);
          URL.revokeObjectURL(audioUrl);
          audioRef.current = null;
          resolve();
        };
        audio.play().catch(() => {
          setIsSpeaking(false);
          URL.revokeObjectURL(audioUrl);
          audioRef.current = null;
          resolve();
        });
      });
    } catch (error) {
      console.error("TTS error:", error);
      setIsSpeaking(false);
    }
  }, [isMuted]);

  // Process voice input and handle response
  const processVoiceInput = useCallback(async (text: string) => {
    if (!text.trim()) {
      isProcessingRef.current = false;
      return;
    }

    const userMsg: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
    };

    setSending(true);
    setVoiceStatus("processing");
    setIsListening(false);
    setMessages((prev) => [...prev, userMsg]);

    try {
      // Only send last 4 messages for short-term context
      const recentMessages = messages.slice(-4);
      const conversationHistory = recentMessages.map((m) => ({
        role: m.role,
        content: m.content,
      }));

      const activeCalendarsForApi = getActiveCalendars().map((c) => ({
        id: c.id,
        name: c.summary,
        color: c.backgroundColor,
      }));

      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          conversationHistory,
          calendars: activeCalendarsForApi,
        }),
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error);

      // Handle create action - INSTANT when all info provided
      if (data.action === "create" && data.appointment) {
        const appt = data.appointment as AppointmentData;
        const hasAllInfo = appt.title && appt.date && (appt.allDay || appt.time);

        if (hasAllInfo && !appt.needsClarification) {
          // Create immediately - no confirmation needed in voice mode
          const defaultCalId = getDefaultCalendarId();
          const result = await createEvent(appt, defaultCalId);
          // Save the calendar used
          if (defaultCalId) {
            localStorage.setItem(STORAGE_KEY_LAST_CALENDAR, defaultCalId);
          }
          if (result.success) {
            const successText = `Done! ${appt.title} scheduled for ${appt.date}${appt.time ? ` at ${appt.time}` : ""}.`;
            setMessages((prev) => [...prev, {
              id: crypto.randomUUID(),
              role: "assistant",
              content: successText,
              eventLink: result.link,
            }]);
            await speakText(successText);
          } else {
            const errorText = `Sorry, couldn't create the event: ${result.error}`;
            setMessages((prev) => [...prev, {
              id: crypto.randomUUID(),
              role: "assistant",
              content: errorText,
            }]);
            await speakText(errorText);
          }
        } else {
          // Need more info - ask ONE question
          setMessages((prev) => [...prev, {
            id: crypto.randomUUID(),
            role: "assistant",
            content: data.message,
          }]);
          await speakText(data.speech || data.message);
        }
      } else if (data.action === "delete" && data.deleteEvent) {
        // For delete, still confirm but make it quick
        setPendingDelete(data.deleteEvent as DeleteEventData);
        const confirmText = data.speech || `Delete ${data.deleteEvent.title}?`;
        setMessages((prev) => [...prev, {
          id: crypto.randomUUID(),
          role: "assistant",
          content: data.message || confirmText,
        }]);
        await speakText(confirmText);
        setShowDeleteConfirm(true);
      } else if (data.action === "delete_multiple" && data.multipleEvents) {
        setSelectedEventIds(new Set());
        setMessages((prev) => [...prev, {
          id: crypto.randomUUID(),
          role: "assistant",
          content: data.message,
          type: "event_selection",
          selectableEvents: data.multipleEvents as DeleteEventData[],
        }]);
        await speakText(data.speech || "Found multiple events. Please select on screen.");
      } else {
        // Regular response
        setMessages((prev) => [...prev, {
          id: crypto.randomUUID(),
          role: "assistant",
          content: data.message,
        }]);
        await speakText(data.speech || data.message);
      }
    } catch (error) {
      console.error("Voice input error:", error);
      const errorText = "Sorry, something went wrong. Please try again.";
      setMessages((prev) => [...prev, {
        id: crypto.randomUUID(),
        role: "assistant",
        content: errorText,
      }]);
      await speakText(errorText);
    } finally {
      setSending(false);
      isProcessingRef.current = false;
    }
  }, [messages, getActiveCalendars, createEvent, speakText]);

  // Start listening with robust error handling
  const startListening = useCallback(() => {
    if (!recognitionRef.current || !voiceModeRef.current || isProcessingRef.current) return;

    clearAllTimers();
    currentTranscriptRef.current = "";
    setInterimTranscript("");

    try {
      recognitionRef.current.start();
    } catch {
      // Already running or error - retry after delay
      restartTimerRef.current = setTimeout(() => {
        if (voiceModeRef.current && !isProcessingRef.current && !isMutedRef.current) {
          startListening();
        }
      }, 500);
    }
  }, [clearAllTimers]);

  // Initialize speech recognition with robust error handling
  const initSpeechRecognition = useCallback(() => {
    if (typeof window === "undefined") return null;

    const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognitionAPI) return null;

    // Clean up old instance
    if (recognitionRef.current) {
      try { recognitionRef.current.abort(); } catch {}
      recognitionRef.current = null;
    }

    const recognition = new SpeechRecognitionAPI();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onstart = () => {
      retryCountRef.current = 0;
      setIsListening(true);
      setVoiceStatus("listening");
      currentTranscriptRef.current = "";
    };

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let finalTranscript = "";
      let interimTranscript = "";

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalTranscript += transcript + " ";
        } else {
          interimTranscript += transcript;
        }
      }

      const displayText = (finalTranscript + interimTranscript).trim();
      currentTranscriptRef.current = displayText;
      setInterimTranscript(displayText);

      // Clear existing timer
      if (silenceTimerRef.current) {
        clearTimeout(silenceTimerRef.current);
      }

      // If we have final transcript, process immediately
      if (finalTranscript.trim()) {
        isProcessingRef.current = true;
        setInterimTranscript("");
        processVoiceInput(finalTranscript.trim());
        return;
      }

      // For interim, wait 1.5s of silence then process
      silenceTimerRef.current = setTimeout(() => {
        if (currentTranscriptRef.current.trim() && voiceModeRef.current && !isProcessingRef.current) {
          isProcessingRef.current = true;
          const text = currentTranscriptRef.current.trim();
          setInterimTranscript("");
          currentTranscriptRef.current = "";
          processVoiceInput(text);
        }
      }, 1500);
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      console.log("Speech error:", event.error);

      if (event.error === "aborted") {
        // We aborted intentionally, ignore
        return;
      }

      if (event.error === "no-speech") {
        // No speech detected - restart if still active
        if (voiceModeRef.current && !isProcessingRef.current && !isMutedRef.current) {
          restartTimerRef.current = setTimeout(() => startListening(), 500);
        }
      } else if (event.error === "not-allowed" || event.error === "audio-capture") {
        // Permission error - exit voice mode
        setIsListening(false);
        setVoiceStatus("idle");
        voiceModeRef.current = false;
        setIsVoiceMode(false);
        alert("Microphone access denied. Please check your browser settings.");
      } else {
        // Other errors - retry with backoff
        if (voiceModeRef.current && !isProcessingRef.current && !isMutedRef.current) {
          if (retryCountRef.current < maxRetries) {
            retryCountRef.current++;
            restartTimerRef.current = setTimeout(() => startListening(), 1000);
          }
        }
      }
    };

    recognition.onend = () => {
      setIsListening(false);

      // If we got speech, it's being processed
      // If not and voice mode still active (and not muted), restart listening
      if (voiceModeRef.current && !isProcessingRef.current && !isSpeaking && !isMutedRef.current) {
        restartTimerRef.current = setTimeout(() => startListening(), 300);
      }
    };

    return recognition;
  }, [processVoiceInput, isSpeaking, startListening]);

  // Toggle voice mode
  const toggleVoiceMode = useCallback(async () => {
    if (isVoiceMode) {
      // Turn off
      voiceModeRef.current = false;
      isProcessingRef.current = false;
      clearAllTimers();
      setIsVoiceMode(false);
      setVoiceStatus("idle");
      setInterimTranscript("");
      currentTranscriptRef.current = "";
      if (recognitionRef.current) {
        try { recognitionRef.current.abort(); } catch {}
        recognitionRef.current = null;
      }
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
      // Stop all microphone tracks
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach(track => track.stop());
        mediaStreamRef.current = null;
      }
      setIsSpeaking(false);
      setIsListening(false);
      setIsMuted(false);
      isMutedRef.current = false;
    } else {
      // Turn on
      const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SpeechRecognitionAPI) {
        alert("Speech recognition not supported. Try Chrome, Safari, or Edge.");
        return;
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaStreamRef.current = stream;
      } catch {
        alert("Microphone access required. Please allow and try again.");
        return;
      }

      const recognition = initSpeechRecognition();
      if (recognition) {
        recognitionRef.current = recognition;
        voiceModeRef.current = true;
        isProcessingRef.current = false;
        retryCountRef.current = 0;
        setIsVoiceMode(true);
        setVoiceStatus("listening");
        try {
          recognition.start();
        } catch {
          alert("Failed to start voice mode. Please try again.");
          voiceModeRef.current = false;
          setIsVoiceMode(false);
        }
      }
    }
  }, [isVoiceMode, initSpeechRecognition, clearAllTimers]);

  // Toggle mute - mutes/unmutes the microphone input
  const toggleMute = useCallback(() => {
    const newMutedState = !isMutedRef.current;
    isMutedRef.current = newMutedState;
    
    if (newMutedState) {
      // Muting: stop recognition
      if (recognitionRef.current) {
        try { recognitionRef.current.stop(); } catch {}
      }
      setIsListening(false);
      
      // Also pause TTS
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
        setIsSpeaking(false);
      }
    } else {
      // Unmuting: restart recognition if voice mode is active
      if (voiceModeRef.current && !isProcessingRef.current) {
        startListening();
      }
    }
    
    setIsMuted(newMutedState);
  }, [startListening]);

  // Manual stop and process
  const stopAndProcess = useCallback(() => {
    clearAllTimers();
    const text = currentTranscriptRef.current.trim();

    if (recognitionRef.current) {
      try { recognitionRef.current.stop(); } catch {}
    }

    if (text && !isProcessingRef.current) {
      isProcessingRef.current = true;
      setInterimTranscript("");
      currentTranscriptRef.current = "";
      processVoiceInput(text);
    }
  }, [clearAllTimers, processVoiceInput]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return;

      if (e.code === "Space" && isVoiceMode && !e.repeat) {
        e.preventDefault();
        if (isListening && currentTranscriptRef.current.trim()) {
          stopAndProcess();
        } else if (!sending && !isSpeaking && !isListening) {
          startListening();
        }
      }

      if (e.code === "KeyM" && isVoiceMode && !e.repeat) {
        e.preventDefault();
        toggleMute();
      }

      if (e.code === "Escape" && isVoiceMode) {
        e.preventDefault();
        toggleVoiceMode();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isVoiceMode, isListening, sending, isSpeaking, toggleMute, toggleVoiceMode, startListening, stopAndProcess]);

  // Cleanup
  useEffect(() => {
    return () => {
      voiceModeRef.current = false;
      if (recognitionRef.current) recognitionRef.current.abort();
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
    };
  }, []);

  // Resume listening after speaking completes
  useEffect(() => {
    if (voiceModeRef.current && !isSpeaking && !isProcessingRef.current && !isListening && !sending && !isMutedRef.current) {
      restartTimerRef.current = setTimeout(() => {
        if (voiceModeRef.current && !isProcessingRef.current && !isMutedRef.current) {
          startListening();
        }
      }, 500);
    }
  }, [isSpeaking, isListening, sending, startListening]);

  // Render voice mode overlay - SIMPLIFIED
  function renderVoiceModeOverlay() {
    if (!isVoiceMode) return null;

    const statusText = sending ? "Processing..." : isSpeaking ? "Speaking..." : isListening ? "Listening..." : "Tap to speak";
    const statusColor = sending ? "text-amber-300" : isSpeaking ? "text-emerald-300" : isListening ? "text-blue-300" : "text-white/60";
    const micColor = sending ? "bg-amber-500" : isSpeaking ? "bg-emerald-500" : isListening ? "bg-blue-500" : "bg-gray-600";

    // Get last 3 messages for transcript view
    const recentMessages = messages.slice(-3);

    return (
      <div className="fixed inset-0 z-40 flex flex-col bg-slate-900">
        {/* Header - Exit only */}
        <div className="flex items-center justify-between px-4 py-3">
          <button
            onClick={toggleVoiceMode}
            className="flex h-12 w-12 items-center justify-center rounded-full text-white/70 hover:bg-white/10"
          >
            <svg className="h-7 w-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
          <div className="w-12" /> {/* Spacer for balance */}
        </div>

        {/* Main content */}
        <div className="flex flex-1 flex-col items-center justify-center px-6">
          {/* Mic button with pulse animation */}
          <div className="relative mb-8">
            {isListening && !sending && (
              <div className="absolute -inset-4 animate-ping rounded-full bg-blue-400/20" style={{ animationDuration: "2s" }} />
            )}
            {sending && (
              <div className="absolute -inset-4 rounded-full border-4 border-amber-500/30 border-t-amber-400 animate-spin" />
            )}
            <button
              onClick={() => {
                if (isListening && currentTranscriptRef.current.trim()) {
                  stopAndProcess();
                } else if (!sending && !isSpeaking) {
                  startListening();
                }
              }}
              disabled={sending || isSpeaking}
              className={`relative flex h-24 w-24 items-center justify-center rounded-full transition-all ${micColor} shadow-lg`}
            >
              {sending ? (
                <div className="flex gap-1">
                  <div className="h-2 w-2 rounded-full bg-white animate-bounce" />
                  <div className="h-2 w-2 rounded-full bg-white animate-bounce" style={{ animationDelay: "150ms" }} />
                  <div className="h-2 w-2 rounded-full bg-white animate-bounce" style={{ animationDelay: "300ms" }} />
                </div>
              ) : (
                <svg className="h-12 w-12 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z" />
                </svg>
              )}
            </button>
          </div>

          {/* Status */}
          <p className={`text-xl font-medium ${statusColor}`}>{statusText}</p>

          {/* Live transcript */}
          {interimTranscript && (
            <div className="mt-6 max-w-md w-full">
              <div className="rounded-xl bg-blue-500/20 px-4 py-3">
                <p className="text-center text-white">{interimTranscript}</p>
              </div>
              {isListening && (
                <button
                  onClick={stopAndProcess}
                  className="mt-2 w-full rounded-full bg-blue-600 py-2.5 text-white font-medium"
                >
                  Done
                </button>
              )}
            </div>
          )}

          {/* Recent messages transcript */}
          {!interimTranscript && recentMessages.length > 0 && (
            <div className="mt-6 max-w-md w-full space-y-2">
              {recentMessages.map((msg) => (
                <div
                  key={msg.id}
                  className={`rounded-lg px-4 py-2 text-sm ${
                    msg.role === "user" ? "bg-white/10 text-white/80" : "bg-white/5 text-white/60"
                  }`}
                >
                  <span className="text-white/40 text-xs">{msg.role === "user" ? "You:" : "AI:"}</span>
                  <p className="mt-0.5">{msg.content.slice(0, 100)}{msg.content.length > 100 ? "..." : ""}</p>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer with mute button and hints */}
        <div className="px-6 py-4">
          {/* Mute button - centered */}
          <div className="flex justify-center mb-3">
            <button
              onClick={toggleMute}
              className={`flex h-14 w-14 items-center justify-center rounded-full transition-all ${
                isMuted 
                  ? "bg-red-500/20 text-red-400 ring-2 ring-red-500/50" 
                  : "bg-white/10 text-white/70 hover:bg-white/20"
              }`}
              title={isMuted ? "Unmute microphone" : "Mute microphone"}
            >
              {isMuted ? (
                <svg className="h-7 w-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 3l18 18" />
                </svg>
              ) : (
                <svg className="h-7 w-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z" />
                </svg>
              )}
            </button>
          </div>
          {/* Keyboard hints */}
          <p className="text-xs text-white/30 text-center">
            <kbd className="rounded bg-white/10 px-1">Space</kbd> send ·{" "}
            <kbd className="rounded bg-white/10 px-1">M</kbd> mute ·{" "}
            <kbd className="rounded bg-white/10 px-1">Esc</kbd> exit
          </p>
        </div>
      </div>
    );
  }

  // Format event for display
  function formatEventDisplay(event: DeleteEventData): { date: string; time: string } {
    const dateObj = new Date(event.start);
    const isAllDay = !event.start.includes("T");

    const dateStr = dateObj.toLocaleDateString("en-US", {
      weekday: "long",
      month: "short",
      day: "numeric",
      timeZone: "America/Los_Angeles",
    });

    if (isAllDay) {
      return { date: dateStr, time: "All day" };
    }

    const timeStr = dateObj.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: "America/Los_Angeles",
    });

    return { date: dateStr, time: timeStr };
  }

  // Render success celebration - auto-dismisses
  function renderSuccessModal() {
    if (!showSuccess) return null;

    return (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
        onClick={() => setShowSuccess(false)}
      >
        <div className="flex flex-col items-center rounded-3xl bg-white px-8 py-6 shadow-2xl animate-[fadeIn_0.2s_ease-out]">
          {/* Checkmark animation */}
          <div className="flex h-20 w-20 items-center justify-center rounded-full bg-green-100 animate-[checkmark_0.4s_ease-out]">
            <svg className="h-10 w-10 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <p className="mt-4 text-xl font-semibold text-gray-900">{successMessage}</p>
          {successLink && (
            <a
              href={successLink}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="mt-3 flex h-12 items-center gap-2 rounded-full bg-gray-100 px-5 text-base font-medium text-indigo-600 hover:bg-gray-200"
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
              </svg>
              View in Calendar
            </a>
          )}
        </div>
      </div>
    );
  }

  // Render delete confirmation modal - BOTTOM SHEET STYLE
  function renderDeleteConfirmModal() {
    if (!showDeleteConfirm || !pendingDelete) return null;

    const dateObj = new Date(pendingDelete.start);
    const isAllDay = !pendingDelete.start.includes("T");
    const dateStr = dateObj.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      timeZone: "America/Los_Angeles",
    });
    const timeStr = isAllDay
      ? "All day"
      : dateObj.toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
          timeZone: "America/Los_Angeles",
        });

    return (
      <div
        className="fixed inset-0 z-50 flex items-end justify-center bg-black/40"
        onClick={handleCancelDelete}
      >
        <div
          className="w-full max-w-lg rounded-t-3xl bg-white px-6 pb-8 pt-4 shadow-2xl animate-[slideUp_0.2s_ease-out]"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Drag handle */}
          <div className="mx-auto mb-4 h-1 w-12 rounded-full bg-gray-300" />

          {/* Compact summary */}
          <div className="mb-6 text-center">
            <p className="text-xl font-semibold text-gray-900">{pendingDelete.title}</p>
            <p className="mt-1 text-lg text-gray-600">{dateStr} · {timeStr}</p>
          </div>

          {/* Large buttons - 60px height */}
          <div className="space-y-3">
            <button
              onClick={handleConfirmDelete}
              disabled={isDeleting}
              className="flex h-[60px] w-full items-center justify-center rounded-2xl bg-red-600 text-lg font-semibold text-white transition-colors hover:bg-red-700 active:bg-red-800 disabled:opacity-50"
            >
              {isDeleting ? (
                <span className="flex items-center gap-3">
                  <svg className="h-6 w-6 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Deleting...
                </span>
              ) : (
                <>
                  <svg className="mr-2 h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                  Delete
                </>
              )}
            </button>
            <button
              onClick={handleCancelDelete}
              disabled={isDeleting}
              className="flex h-[52px] w-full items-center justify-center rounded-2xl text-lg font-medium text-gray-500 transition-colors hover:bg-gray-100 active:bg-gray-200 disabled:opacity-50"
            >
              Keep Event
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Render slide-out menu
  function renderMenu() {
    return (
      <>
        {/* Backdrop */}
        <div
          className={`fixed inset-0 z-40 bg-black/50 transition-opacity duration-300 ${
            menuOpen ? "opacity-100" : "pointer-events-none opacity-0"
          }`}
          onClick={() => setMenuOpen(false)}
        />
        {/* Drawer */}
        <div
          className={`fixed inset-y-0 left-0 z-50 w-64 bg-white shadow-xl transition-transform duration-300 ${
            menuOpen ? "translate-x-0" : "-translate-x-full"
          }`}
        >
          <div className="flex h-full flex-col">
            {/* Header */}
            <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
              <h2 className="text-lg font-semibold text-gray-900">Menu</h2>
              <button
                onClick={() => setMenuOpen(false)}
                className="flex h-10 w-10 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100"
              >
                <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            {/* Menu Items */}
            <nav className="flex-1 overflow-y-auto px-2 py-4">
              <a
                href="https://calendar.google.com"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-gray-700 hover:bg-gray-100"
                onClick={() => setMenuOpen(false)}
              >
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
                </svg>
                Open Google Calendar
              </a>

              {/* Calendar Management Section */}
              <div className="mt-4 border-t border-gray-200 pt-4">
                <h3 className="mb-2 px-3 text-xs font-semibold uppercase tracking-wider text-gray-500">
                  My Calendars
                </h3>
                <p className="mb-2 px-3 text-xs text-gray-400">
                  Select which calendars to search
                </p>
                {calendars.length === 0 ? (
                  <div className="px-3 py-2 text-sm text-gray-400">Loading calendars...</div>
                ) : (
                  <div className="space-y-1">
                    {calendars.map((cal) => (
                      <label
                        key={cal.id}
                        className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 hover:bg-gray-50"
                      >
                        <input
                          type="checkbox"
                          checked={activeCalendarIds.has(cal.id)}
                          onChange={() => toggleCalendarActive(cal.id)}
                          className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                        />
                        <span
                          className="h-3 w-3 shrink-0 rounded-full"
                          style={{ backgroundColor: cal.backgroundColor }}
                        />
                        <span className="truncate text-sm text-gray-700">
                          {cal.summary}
                          {cal.primary && <span className="ml-1 text-xs text-gray-400">(Primary)</span>}
                        </span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </nav>
            {/* Footer */}
            <div className="border-t border-gray-200 px-2 py-4">
              <button
                onClick={() => {
                  setMenuOpen(false);
                  handleSignOut();
                }}
                className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-red-600 hover:bg-red-50"
              >
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15m3 0l3-3m0 0l-3-3m3 3H9" />
                </svg>
                Sign Out
              </button>
            </div>
          </div>
        </div>
      </>
    );
  }

  return (
    <div className="relative flex flex-col bg-white overflow-hidden" style={{ height: "100dvh" }}>
      {/* Voice mode overlay */}
      {renderVoiceModeOverlay()}

      {/* Slide-out menu */}
      {renderMenu()}

      {/* Confirmation modal */}
      {renderConfirmModal()}

      {/* Delete confirmation modal */}
      {renderDeleteConfirmModal()}

      {/* Success celebration */}
      {renderSuccessModal()}

      {/* Top nav */}
      <header className="flex shrink-0 items-center justify-between border-b border-gray-200 bg-white px-4 py-3 z-10">
        <button
          onClick={() => setMenuOpen(true)}
          className="flex h-11 w-11 items-center justify-center rounded-lg text-gray-600 hover:bg-gray-100 active:bg-gray-200"
        >
          <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
          </svg>
        </button>
        <h1 className="text-lg font-semibold text-gray-900">AI Calendar Assistant</h1>
        <a
          href="https://calendar.google.com"
          target="_blank"
          rel="noopener noreferrer"
          className="flex h-11 w-11 items-center justify-center rounded-lg text-gray-600 hover:bg-gray-100 active:bg-gray-200"
        >
          <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5" />
          </svg>
        </a>
      </header>

      {/* Messages - scrollable area */}
      <div className="flex-1 overflow-y-auto px-4 py-4 pb-24" style={{ WebkitOverflowScrolling: "touch" }}>
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-6">
            {/* Large voice button for empty state - primary action */}
            <button
              onClick={toggleVoiceMode}
              className="mb-6 flex h-20 w-20 items-center justify-center rounded-full bg-indigo-600 text-white shadow-lg shadow-indigo-600/30 transition-transform hover:scale-105 active:scale-95"
            >
              <svg className="h-10 w-10" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z" />
              </svg>
            </button>
            <p className="text-lg font-medium text-gray-700">Tap to speak</p>
            <p className="mt-2 max-w-xs text-center text-base text-gray-400">
              or type below
            </p>
            <p className="mt-4 text-sm text-gray-400">
              Try: "dentist march 15 2pm"
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"} animate-[fadeIn_0.2s_ease-out]`}
              >
                {/* Event selection message with checkboxes */}
                {msg.type === "event_selection" && msg.selectableEvents ? (
                  <div className="max-w-[90%] rounded-2xl rounded-bl-md bg-gray-100 px-4 py-3 text-[15px] text-gray-900">
                    <p className="mb-3 whitespace-pre-wrap">{msg.content}</p>
                    <div className="space-y-2">
                      {msg.selectableEvents.map((event) => {
                        const { date, time } = formatEventDisplay(event);
                        const isSelected = selectedEventIds.has(event.id);
                        return (
                          <label
                            key={event.id}
                            className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${
                              isSelected
                                ? "border-indigo-500 bg-indigo-50"
                                : "border-gray-200 hover:bg-gray-50"
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => toggleEventSelection(event.id)}
                              className="mt-0.5 h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                            />
                            <div className="flex-1">
                              <p className="font-medium text-gray-900">{event.title}</p>
                              <p className="text-sm text-gray-500">
                                {date} {time !== "All day" ? `at ${time}` : `(${time})`}
                              </p>
                            </div>
                          </label>
                        );
                      })}
                    </div>
                    <div className="mt-4 flex gap-2">
                      <button
                        onClick={() => handleCancelSelection(msg.id)}
                        disabled={isDeletingMultiple}
                        className="flex-1 rounded-full border border-gray-300 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={() => handleDeleteSelected(msg.selectableEvents!, msg.id)}
                        disabled={selectedEventIds.size === 0 || isDeletingMultiple}
                        className="flex-1 rounded-full bg-red-600 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-50"
                      >
                        {isDeletingMultiple ? (
                          <span className="flex items-center justify-center gap-1">
                            <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
                              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                            </svg>
                            Deleting...
                          </span>
                        ) : (
                          `Delete Selected (${selectedEventIds.size})`
                        )}
                      </button>
                    </div>
                  </div>
                ) : (
                  /* Regular text message */
                  <div
                    className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-[15px] leading-relaxed ${
                      msg.role === "user"
                        ? "rounded-br-md bg-indigo-600 text-white"
                        : "rounded-bl-md bg-gray-100 text-gray-900"
                    }`}
                  >
                    <span className="whitespace-pre-wrap">{msg.content}</span>
                    {msg.eventLink && (
                      <a
                        href={msg.eventLink}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="ml-2 inline-flex items-center gap-1 text-indigo-600 hover:text-indigo-800 hover:underline"
                      >
                        View in Calendar
                        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
                        </svg>
                      </a>
                    )}
                  </div>
                )}
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* Input bar - fixed at bottom with safe area */}
      <div className="fixed bottom-0 left-0 right-0 z-20 border-t border-gray-200 bg-white px-3 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <div className="flex items-end gap-3">
          {/* Voice button - large 56px touch target */}
          <button
            onClick={toggleVoiceMode}
            className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-indigo-600 transition-colors hover:bg-indigo-200 active:bg-indigo-300"
            title="Voice mode"
            aria-label="Start voice mode"
          >
            <svg className="h-7 w-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z" />
            </svg>
          </button>
          {/* Input field - larger text, helpful placeholder */}
          <div className="relative flex-1">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="dentist march 15 2pm"
              rows={1}
              disabled={sending}
              className="w-full resize-none rounded-2xl border border-gray-300 bg-gray-50 px-4 py-3 pr-14 text-base text-gray-900 placeholder:text-gray-400 focus:border-indigo-400 focus:outline-none disabled:opacity-50"
              style={{ fontSize: '16px' }} // Prevent iOS zoom
            />
            {/* Send button inside input for compact layout */}
            <button
              onClick={handleSend}
              disabled={!input.trim() || sending}
              className="absolute bottom-1.5 right-1.5 flex h-10 w-10 items-center justify-center rounded-full bg-indigo-600 text-white transition-all disabled:opacity-30 disabled:scale-90"
              aria-label="Send message"
            >
              {sending ? (
                <svg className="h-5 w-5 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
              ) : (
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </div>

      <style jsx global>{`
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes waveform {
          0%, 100% { transform: scaleY(0.5); }
          50% { transform: scaleY(1.5); }
        }
        @keyframes slideUp {
          from { opacity: 0; transform: translateY(100%); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes checkmark {
          0% { transform: scale(0); }
          50% { transform: scale(1.2); }
          100% { transform: scale(1); }
        }
        /* Ensure minimum touch targets */
        button, a { min-height: 44px; min-width: 44px; }
        /* Prevent text selection on buttons */
        button { -webkit-user-select: none; user-select: none; }
      `}</style>
    </div>
  );
}
