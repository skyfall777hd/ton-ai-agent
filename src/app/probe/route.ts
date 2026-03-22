import { NextResponse } from "next/server";

export function GET() {
  return new NextResponse(
    `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Probe</title>
  </head>
  <body style="margin:0;background:#ffef00;color:#111;font:20px system-ui,sans-serif;">
    <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center;">
      <div style="background:#fff;border:4px solid #111;border-radius:20px;padding:24px;max-width:640px;">
        <div style="font-size:34px;font-weight:800;">PROBE OK</div>
        <div style="margin-top:12px;">Path: /probe</div>
        <div style="margin-top:12px;">Build: 2026-03-19 11:50 UTC</div>
      </div>
    </div>
  </body>
</html>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store, no-cache, must-revalidate, max-age=0"
      }
    }
  );
}
