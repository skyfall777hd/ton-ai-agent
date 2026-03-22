import { NextRequest, NextResponse } from "next/server";

export function GET(request: NextRequest) {
  const baseUrl =
    process.env.NEXT_PUBLIC_APP_URL ?? new URL(request.url).origin;

  return NextResponse.json({
    url: baseUrl,
    name: "TON AI",
    iconUrl: `${baseUrl}/ton-ai-mark.svg`,
    termsOfUseUrl: `${baseUrl}/terms`,
    privacyPolicyUrl: `${baseUrl}/privacy`
  });
}
