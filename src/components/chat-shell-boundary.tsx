"use client";

import { Component, type ReactNode } from "react";
import { ChatShell } from "@/components/chat-shell";

type State = {
  hasError: boolean;
  message?: string;
};

class ChatShellBoundaryInner extends Component<{ children: ReactNode }, State> {
  state: State = {
    hasError: false
  };

  static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      message: error.message
    };
  }

  componentDidCatch(error: unknown) {
    console.error("Chat shell crashed", error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <main className="app-shell">
          <section className="chat-frame crash-shell">
            <div className="crash-card">
              <strong>Mini App client error</strong>
              <p>
                The interface crashed inside Telegram WebView. Restart the Mini App.
              </p>
              {this.state.message ? (
                <p className="crash-copy">{this.state.message}</p>
              ) : null}
            </div>
          </section>
        </main>
      );
    }

    return this.props.children;
  }
}

export function ChatShellBoundary() {
  return (
    <ChatShellBoundaryInner>
      <ChatShell />
    </ChatShellBoundaryInner>
  );
}
