import { NextResponse } from "next/server";
import { generateAgentReply } from "@/lib/agent";

function detectRequestLanguage(message: unknown) {
  return "en" as const;
}

function toClientErrorMessage(error: unknown, language: "ru" | "en") {
  const fallback = "The external service is temporarily unavailable. Try again in a few seconds.";

  if (!(error instanceof Error)) {
    return fallback;
  }

  const message = error.message.trim();

  if (
    /status code 404/i.test(message) ||
    /returned 404/i.test(message) ||
    /response status code 404/i.test(message)
  ) {
    return "The external endpoint returned 404. Most likely the requested route, token, or service is unavailable right now.";
  }

  if (/status code 5\d\d/i.test(message) || /returned 5\d\d/i.test(message)) {
    return "The external service responded with a server error. Try again a bit later.";
  }

  if (/timeout|aborted|abort/i.test(message)) {
    return "The request timed out while contacting the external service. Try again.";
  }

  return message || fallback;
}

export async function POST(request: Request) {
  let body: unknown;

  try {
    body = await request.json();
    const reply = await generateAgentReply(body);
    return NextResponse.json(reply);
  } catch (error) {
    const language = detectRequestLanguage(
      body && typeof body === "object" && "message" in body
        ? (body as { message?: unknown }).message
        : undefined
    );

    return NextResponse.json(
      {
        error: toClientErrorMessage(error, language)
      },
      { status: 400 }
    );
  }
}
