import { NextResponse } from "next/server";
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export async function POST(request: Request) {
  try {
    const { text, voice = "nova", speed = 1.0 } = await request.json();

    if (!text || typeof text !== "string") {
      return NextResponse.json({ error: "Text is required" }, { status: 400 });
    }

    // Clean up text for better speech (remove emojis and special formatting)
    const cleanText = text
      .replace(/[📅📌🕐📍✅❌🗑️]/g, "")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // Remove markdown links
      .replace(/\*\*([^*]+)\*\*/g, "$1") // Remove bold
      .replace(/\n+/g, ". ") // Replace newlines with pauses
      .trim();

    if (!cleanText) {
      return NextResponse.json({ error: "No speakable text" }, { status: 400 });
    }

    const mp3 = await openai.audio.speech.create({
      model: "tts-1",
      voice: voice as "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer",
      input: cleanText,
      speed: Math.max(0.25, Math.min(4.0, speed)),
    });

    const buffer = Buffer.from(await mp3.arrayBuffer());

    return new Response(buffer, {
      headers: {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-cache",
      },
    });
  } catch (error) {
    console.error("TTS error:", error);
    return NextResponse.json(
      { error: "Failed to generate speech" },
      { status: 500 }
    );
  }
}
