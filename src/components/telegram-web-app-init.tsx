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
    const pendingTimeouts = new Set<number>();
    let frameId = 0;

    if (!webApp) {
      return;
    }

    const syncTelegramViewport = () => {
      const liveViewportHeight =
        webApp.viewportHeight ?? window.visualViewport?.height ?? window.innerHeight;
      const stableViewportHeight = webApp.viewportStableHeight;
      const height = Math.round(
        liveViewportHeight > 0
          ? liveViewportHeight
          : stableViewportHeight ?? window.innerHeight
      );

      if (height > 0) {
        root.style.setProperty("--app-height", `${height}px`);
      }
    };

    const scheduleViewportSync = () => {
      syncTelegramViewport();

      if (frameId) {
        window.cancelAnimationFrame(frameId);
      }

      frameId = window.requestAnimationFrame(() => {
        frameId = 0;
        syncTelegramViewport();
      });

      [60, 180, 360].forEach((delay) => {
        const timeoutId = window.setTimeout(() => {
          pendingTimeouts.delete(timeoutId);
          syncTelegramViewport();
        }, delay);

        pendingTimeouts.add(timeoutId);
      });
    };

    const openFullscreen = () => {
      if (!webApp.isExpanded) {
        webApp.expand?.();
      }

      if (!webApp.isFullscreen) {
        webApp.requestFullscreen?.();
        webApp.postEvent?.("web_app_request_fullscreen");
      }

      scheduleViewportSync();
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

    const handleViewportChanged = () => {
      openFullscreen();
      scheduleViewportSync();
    };

    window.addEventListener("focus", handleFocus);
    window.addEventListener("pageshow", handleFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.visualViewport?.addEventListener("resize", scheduleViewportSync);
    window.visualViewport?.addEventListener("scroll", scheduleViewportSync);
    webApp.onEvent?.("viewportChanged", handleViewportChanged);
    webApp.onEvent?.("fullscreenChanged", handleViewportChanged);
    webApp.onEvent?.("activated", handleViewportChanged);

    return () => {
      retryTimers.forEach((timerId) => {
        window.clearTimeout(timerId);
      });
      pendingTimeouts.forEach((timeoutId) => {
        window.clearTimeout(timeoutId);
      });
      pendingTimeouts.clear();
      if (frameId) {
        window.cancelAnimationFrame(frameId);
      }
      window.clearInterval(retryIntervalId);
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("pageshow", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.visualViewport?.removeEventListener("resize", scheduleViewportSync);
      window.visualViewport?.removeEventListener("scroll", scheduleViewportSync);
      webApp.offEvent?.("viewportChanged", handleViewportChanged);
      webApp.offEvent?.("fullscreenChanged", handleViewportChanged);
      webApp.offEvent?.("activated", handleViewportChanged);
      root.style.removeProperty("--app-height");
    };
  }, []);

  return null;
}
