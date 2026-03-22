"use client";

import { ChatShellBoundary } from "@/components/chat-shell-boundary";
import { Providers } from "@/components/providers";

export function AppClient() {
  return (
    <Providers>
      <ChatShellBoundary />
    </Providers>
  );
}
