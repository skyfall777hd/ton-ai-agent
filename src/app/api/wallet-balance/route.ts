import { NextRequest, NextResponse } from "next/server";

const endpoint =
  process.env.TON_API_ENDPOINT ?? "https://toncenter.com/api/v2/jsonRPC";
const apiKey = process.env.TON_API_KEY;

const nanotonsPerTon = 1_000_000_000;

function formatTonBalance(value: string) {
  const balance = Number(value) / nanotonsPerTon;
  return balance.toFixed(2);
}

export async function GET(request: NextRequest) {
  const address = request.nextUrl.searchParams.get("address");

  if (!address) {
    return NextResponse.json({ error: "Address is required" }, { status: 400 });
  }

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { "X-API-Key": apiKey } : {})
      },
      body: JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "getAddressBalance",
        params: {
          address
        }
      }),
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error(`TON API returned ${response.status}`);
    }

    const payload = (await response.json()) as {
      result?: string;
      error?: {
        message?: string;
      };
    };

    if (!payload.result) {
      throw new Error(payload.error?.message ?? "Balance is unavailable");
    }

    return NextResponse.json({
      balance: formatTonBalance(payload.result),
      symbol: "TON"
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to fetch wallet balance";

    return NextResponse.json({ error: message }, { status: 400 });
  }
}
