"use client";

import { useEffect } from "react";

type TelegramWebApp = {
  ready?: () => void;
  expand?: () => void;
  requestFullscreen?: () => void;
  postEvent?: (eventType: string, eventData?: string) => void;
  isExpanded?: boolean;
  isFullscreen?: boolean;
  viewportHeight?: number;
  viewportStableHeight?: number;
  setHeaderColor?: (color: string) => void;
  setBackgroundColor?: (color: string) => void;
  disableVerticalSwipes?: () => void;
  onEvent?: (eventType: string, handler: () => void) => void;
  offEvent?: (eventType: string, handler: () => void) => void;
  version?: string;
  platform?: string;
};

declare global {
  interface Window {
    Telegram?: {
      WebApp?: TelegramWebApp;
    };
  }
}

export function TelegramWebAppInit() {
  useEffect(() => {
    const webApp = window.Telegram?.WebApp;
    const root = document.documentElement;

    if (!webApp) {
      return;
    }

    const syncTelegramViewport = () => {
      const height = Math.round(
        webApp.viewportStableHeight ?? webApp.viewportHeight ?? window.innerHeight
      );

      if (height > 0) {
        root.style.setProperty("--app-height", `${height}px`);
      }
    };

    const openFullscreen = () => {
      if (!webApp.isExpanded) {
        webApp.expand?.();
      }

      if (!webApp.isFullscreen) {
        webApp.requestFullscreen?.();
        webApp.postEvent?.("web_app_request_fullscreen");
      }

      syncTelegramViewport();
    };

    webApp.ready?.();
    syncTelegramViewport();
    openFullscreen();
    webApp.disableVerticalSwipes?.();
    webApp.setHeaderColor?.("#0f1722");
    webApp.setBackgroundColor?.("#0f1722");

    const retryTimers = [0, 80, 240, 600, 1200, 2000, 3200].map((delay) =>
      window.setTimeout(() => {
        openFullscreen();
      }, delay)
    );

    const retryIntervalId = window.setInterval(() => {
      openFullscreen();
    }, 1500);

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        openFullscreen();
      }
    };

    const handleFocus = () => {
      openFullscreen();
    };

    window.addEventListener("focus", handleFocus);
    window.addEventListener("pageshow", handleFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    webApp.onEvent?.("viewportChanged", openFullscreen);
    webApp.onEvent?.("fullscreenChanged", openFullscreen);
    webApp.onEvent?.("activated", openFullscreen);

    return () => {
      retryTimers.forEach((timerId) => {
        window.clearTimeout(timerId);
      });
      window.clearInterval(retryIntervalId);
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("pageshow", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      webApp.offEvent?.("viewportChanged", openFullscreen);
      webApp.offEvent?.("fullscreenChanged", openFullscreen);
      webApp.offEvent?.("activated", openFullscreen);
      root.style.removeProperty("--app-height");
    };
  }, []);

  return null;
}
