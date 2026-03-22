"use client";

import { CHAIN, TonConnectUI, toUserFriendlyAddress } from "@tonconnect/ui";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";

type TonWalletLike = {
  account?: {
    address: string;
    chain?: string;
  };
  device?: {
    appName?: string;
  };
  provider?: string;
} | null;

type TonConnectUiLike = {
  onSingleWalletModalStateChange?: (
    handler: (state: { status: string }) => void
  ) => () => void;
  openSingleWalletModal?: (wallet: string) => Promise<unknown> | void;
  onModalStateChange?: (
    handler: (state: { status: string; closeReason?: string | null }) => void
  ) => () => void;
  openModal?: () => Promise<unknown> | void;
  connectWallet?: () => Promise<unknown>;
  disconnect?: () => Promise<unknown> | void;
  getWallets?: () => Promise<unknown[]>;
  modal?: {
    open?: () => Promise<unknown> | void;
    close?: () => void;
    state?: {
      status: string;
      closeReason?: string | null;
    };
  };
  sendTransaction?: (
    transaction: {
      validUntil: number;
      messages: Array<{
        address: string;
        amount: string;
        payload?: string;
        stateInit?: string;
      }>;
    },
    options?: {
      onRequestSent?: (redirectToWallet: () => void) => void;
    }
  ) => Promise<unknown>;
} | null;

type TonRuntimeValue = {
  wallet: TonWalletLike;
  walletAddress: string;
  tonConnectUI: TonConnectUiLike;
  tonConnectAvailable: boolean;
  connectionRestored: boolean;
};

const fallbackTonRuntime: TonRuntimeValue = {
  wallet: null,
  walletAddress: "",
  tonConnectUI: null,
  tonConnectAvailable: false,
  connectionRestored: false
};

const TonRuntimeContext = createContext<TonRuntimeValue>(fallbackTonRuntime);

export function useTonRuntime() {
  return useContext(TonRuntimeContext);
}

export function Providers({ children }: { children: ReactNode }) {
  const [wallet, setWallet] = useState<TonWalletLike>(null);
  const [walletAddress, setWalletAddress] = useState("");
  const [tonConnectUI, setTonConnectUI] = useState<TonConnectUiLike>(null);
  const [connectionRestored, setConnectionRestored] = useState(false);
  const tonConnectRef = useRef<TonConnectUI | null>(null);

  const manifestUrl = useMemo<`${string}://${string}`>(() => {
    const configured = process.env.NEXT_PUBLIC_TON_CONNECT_MANIFEST_URL?.trim();

    if (configured) {
      return configured as `${string}://${string}`;
    }

    return new URL("/api/ton-connect-manifest.json", window.location.origin)
      .toString() as `${string}://${string}`;
  }, []);

  const twaReturnUrl = (
    process.env.NEXT_PUBLIC_TWA_RETURN_URL?.trim() || "https://t.me/your_bot/your_app"
  ) as `${string}://${string}`;

  useEffect(() => {
    let disposed = false;

    const instance = new TonConnectUI({
      manifestUrl,
      widgetRootId: "tc-widget-root",
      restoreConnection: true,
      language: "ru",
      uiPreferences: {
        borderRadius: "s"
      },
      actionsConfiguration: {
        returnStrategy: "back",
        ...(twaReturnUrl !== "https://t.me/your_bot/your_app" ? { twaReturnUrl } : {})
      }
    });

    tonConnectRef.current = instance;
    setTonConnectUI(instance);
    setWallet(instance.wallet);

    if (instance.wallet?.account?.address) {
      setWalletAddress(
        toUserFriendlyAddress(
          instance.wallet.account.address,
          instance.wallet.account.chain === CHAIN.TESTNET
        )
      );
    }

    const unsubscribeStatus = instance.onStatusChange((nextWallet) => {
      if (disposed) {
        return;
      }

      setWallet(nextWallet);
      setWalletAddress(
        nextWallet?.account?.address
          ? toUserFriendlyAddress(
              nextWallet.account.address,
              nextWallet.account.chain === CHAIN.TESTNET
            )
          : ""
      );
    });

    instance.connectionRestored
      .then(() => {
        if (!disposed) {
          setConnectionRestored(true);
        }
      })
      .catch(() => {
        if (!disposed) {
          setConnectionRestored(true);
        }
      });

    return () => {
      disposed = true;
      unsubscribeStatus?.();
      tonConnectRef.current = null;
      setTonConnectUI(null);
    };
  }, [manifestUrl, twaReturnUrl]);

  const value = useMemo<TonRuntimeValue>(
    () => ({
      wallet,
      walletAddress,
      tonConnectUI,
      tonConnectAvailable: Boolean(tonConnectUI),
      connectionRestored
    }),
    [connectionRestored, tonConnectUI, wallet, walletAddress]
  );

  return <TonRuntimeContext.Provider value={value}>{children}</TonRuntimeContext.Provider>;
}
