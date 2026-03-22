"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useTonRuntime } from "@/components/providers";
import type {
  ChatMessage,
  FeeEstimateData,
  NftAsset,
  NftGalleryData,
  PortfolioData
} from "@/lib/types";

const chatsStorageKey = "ton-ai-chats-v2";
const legacyIntroText =
  "TON AI is online. Connect your wallet and use natural language prompts like `sell 5 TON`, `swap 3 TON to USDT`, or `send 1 TON to ...`.";

const quickPromptPool = [
  "Send 1 TON to this address",
  "Send 0.3 TON to this wallet",
  "What NFTs do I have?",
  "How much TON is in my wallet right now?",
  "Show all tokens in my wallet",
  "Sell 5 TON",
  "Swap 3 TON to USDT",
  "What is the network fee for sending 3 TON?",
  "How much does a Telegram username cost?"
];

type ChatThread = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
  quickPrompts: string[];
};

function isEmptyChatThread(chat: ChatThread) {
  return chat.title === "New chat" && chat.messages.length === 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function toIsoStringOrFallback(value: unknown, fallback: string) {
  if (!isNonEmptyString(value)) {
    return fallback;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString();
}

function sanitizeChatMessage(raw: unknown): ChatMessage | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const candidate = raw as Partial<ChatMessage>;
  const role = candidate.role === "user" || candidate.role === "assistant"
    ? candidate.role
    : null;

  if (!role || !isNonEmptyString(candidate.text)) {
    return null;
  }

  const createdAt = toIsoStringOrFallback(
    candidate.createdAt,
    "2026-01-01T00:00:00.000Z"
  );

  return {
    id: isNonEmptyString(candidate.id) ? candidate.id : crypto.randomUUID(),
    role,
    text: candidate.text,
    createdAt,
    intent: candidate.intent,
    execution: candidate.execution,
    portfolio: candidate.portfolio,
    nftGallery: candidate.nftGallery,
    feeEstimate: candidate.feeEstimate,
    understanding: candidate.understanding
  };
}

function sanitizeChatThread(raw: unknown): ChatThread | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const candidate = raw as Partial<ChatThread>;
  const sanitizedMessages = Array.isArray(candidate.messages)
    ? candidate.messages
        .map(sanitizeChatMessage)
        .filter((message) => message?.text !== legacyIntroText)
        .filter((message): message is ChatMessage => Boolean(message))
    : [];

  const fallbackCreatedAt = "2026-01-01T00:00:00.000Z";
  const createdAt = toIsoStringOrFallback(candidate.createdAt, fallbackCreatedAt);
  const updatedAt = toIsoStringOrFallback(candidate.updatedAt, createdAt);

  return {
    id: isNonEmptyString(candidate.id) ? candidate.id : crypto.randomUUID(),
    title: isNonEmptyString(candidate.title) ? candidate.title : "New chat",
    createdAt,
    updatedAt,
    messages: sanitizedMessages,
    quickPrompts: getRandomQuickPrompts()
  };
}

function getRandomQuickPrompts(count = 5) {
  const pool = [...quickPromptPool];

  for (let index = pool.length - 1; index > 0; index -= 1) {
    const nextIndex = Math.floor(Math.random() * (index + 1));
    [pool[index], pool[nextIndex]] = [pool[nextIndex], pool[index]];
  }

  return pool.slice(0, count);
}

function createChatThread(): ChatThread {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    title: "New chat",
    createdAt: now,
    updatedAt: now,
    messages: [],
    quickPrompts: getRandomQuickPrompts()
  };
}

const initialChatThread: ChatThread = {
  id: "initial-chat",
  title: "New chat",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  messages: [],
  quickPrompts: getRandomQuickPrompts()
};

function isWalletRejection(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes("reject") ||
    message.includes("cancel") ||
    message.includes("declin") ||
    message.includes("closed") ||
    message.includes("abort")
  );
}

function getWalletErrorText(error: unknown) {
  if (isWalletRejection(error)) {
    return "The user cancelled the wallet confirmation.";
  }

  if (
    error instanceof Error &&
    error.message.toLowerCase().includes("transaction was not sent")
  ) {
    return "The wallet did not send the transaction. Check that it opened correctly and try again.";
  }

  if (error instanceof Error && error.message.trim()) {
    return `The wallet returned an error while confirming: ${error.message}`;
  }

  return "Could not send the transaction to the wallet for confirmation.";
}

function formatAssistantText(text: string) {
  return text.split("\n").map((line, index) => (
    <p key={`${index}-${line.slice(0, 20)}`}>{line}</p>
  ));
}

function renderBalanceMessage(
  text: string,
  portfolio: PortfolioData | undefined,
  expanded: boolean,
  onToggleExpanded: () => void,
  unknownExpanded: boolean,
  onToggleUnknownExpanded: () => void
) {
  const sections = text.split("\n\n").map((part) => part.trim()).filter(Boolean);
  const walletLine = sections[0];
  const footerLine = sections.at(-1);
  const visibleTokens = portfolio?.tokens ?? [];
  const collapsedTokens = expanded ? visibleTokens : visibleTokens.slice(0, 5);
  const unknownTokens = portfolio?.unknownTokens ?? [];
  const hiddenCount = expanded ? 0 : Math.max(visibleTokens.length - collapsedTokens.length, 0);

  return (
    <>
      {walletLine ? (
        <div className="message-text">
          <p>{walletLine}</p>
        </div>
      ) : null}
      {portfolio?.ton ? (
        <section className="portfolio-card">
          <span className="portfolio-label">TON</span>
          <strong>
            {portfolio.ton.amount} TON
            {portfolio.ton.totalValueUsdt
              ? ` (est. ${portfolio.ton.totalValueUsdt} USDT`
              : ""}
            {portfolio.ton.unitPriceUsdt
              ? `${portfolio.ton.totalValueUsdt ? ", " : " ("}1 TON = ${portfolio.ton.unitPriceUsdt} USDT`
              : ""}
            {portfolio.ton.totalValueUsdt || portfolio.ton.unitPriceUsdt ? ")" : ""}
          </strong>
        </section>
      ) : null}
      {visibleTokens.length ? (
        <section className="portfolio-card">
          <span className="portfolio-label">Tokens</span>
          <div className="portfolio-token-head">
            <span>Token</span>
            <span>Amount</span>
            <span>Price</span>
            <span>Value</span>
          </div>
          <div className="portfolio-token-list">
            {collapsedTokens.map((asset, index) => (
              <div key={`${index}-${asset.symbol}`} className="portfolio-token-row">
                <div className="portfolio-token-cell portfolio-token-cell-symbol">
                  <div className="portfolio-token-name">
                    {asset.name && asset.name !== asset.symbol
                      ? asset.name
                      : asset.symbol.startsWith("JETTON ")
                        ? "Unknown token"
                        : asset.symbol}
                  </div>
                  {asset.name && asset.name !== asset.symbol ? (
                    <div className="portfolio-token-ticker">{asset.symbol}</div>
                  ) : asset.symbol.startsWith("JETTON ") ? (
                    <div className="portfolio-token-ticker">{asset.symbol}</div>
                  ) : null}
                </div>
                <div className="portfolio-token-cell">{asset.amount}</div>
                <div className="portfolio-token-cell">
                  {asset.unitPriceUsdt ? `${asset.unitPriceUsdt} USDT` : "—"}
                </div>
                <div className="portfolio-token-cell portfolio-token-cell-total">
                  {asset.totalValueUsdt ? `${asset.totalValueUsdt} USDT` : "—"}
                </div>
              </div>
            ))}
          </div>
          {hiddenCount > 0 ? (
            <button
              type="button"
              className="secondary-button portfolio-expand-button"
              onClick={onToggleExpanded}
            >
              Show {hiddenCount} more token(s)
            </button>
          ) : null}
          {expanded && visibleTokens.length > 5 ? (
            <button
              type="button"
              className="secondary-button portfolio-expand-button"
              onClick={onToggleExpanded}
            >
              Collapse list
            </button>
          ) : null}
        </section>
      ) : null}
      {unknownTokens.length ? (
        <section className="portfolio-card portfolio-card-muted">
          <span className="portfolio-label">Unknown tokens</span>
          <p className="portfolio-muted-copy">
            These assets did not return a readable name from the source, so they are hidden from the main list.
          </p>
          <button
            type="button"
            className="secondary-button portfolio-expand-button"
            onClick={onToggleUnknownExpanded}
          >
            {unknownExpanded
              ? "Hide unknown tokens"
              : `Show unknown tokens (${unknownTokens.length})`}
          </button>
          {unknownExpanded ? (
            <div className="portfolio-token-list">
              {unknownTokens.map((asset, index) => (
                <div key={`${index}-${asset.symbol}`} className="portfolio-token-row portfolio-token-row-fallback">
                  <div className="portfolio-token-cell portfolio-token-cell-symbol">
                    <div className="portfolio-token-name">{asset.symbol}</div>
                  </div>
                  <div className="portfolio-token-cell">{asset.amount}</div>
                  <div className="portfolio-token-cell">—</div>
                  <div className="portfolio-token-cell portfolio-token-cell-total">—</div>
                </div>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}
      {portfolio?.totalValueUsdt ? (
        <section className="portfolio-card portfolio-card-accent">
          <span className="portfolio-label">Portfolio</span>
          <strong>{portfolio.totalValueUsdt} USDT</strong>
        </section>
      ) : null}
      {footerLine &&
      footerLine !== walletLine &&
      footerLine !== "If you want, I can also prepare a transfer, swap, or sell flow next." ? (
        <div className="message-text">
          <p>{footerLine}</p>
        </div>
      ) : null}
    </>
  );
}

function renderNftMessage(
  text: string,
  nftGallery: NftGalleryData | undefined,
  onOpenNft: (item: NftAsset) => void
) {
  const sections = text.split("\n\n").map((part) => part.trim()).filter(Boolean);
  const walletLine = sections[0];
  const summaryLine = sections[1];
  const items = nftGallery?.items ?? [];

  return (
    <>
      {walletLine ? (
        <div className="message-text">
          <p>{walletLine}</p>
        </div>
      ) : null}
      {summaryLine ? (
        <div className="message-text">
          <p>{summaryLine}</p>
        </div>
      ) : null}
      {items.length ? (
        <section className="portfolio-card nft-card-list">
          <span className="portfolio-label">NFT</span>
          <div className="nft-grid">
            {items.map((item) => (
              <article key={item.address} className="nft-card">
                {item.imageUrl ? (
                  <div className="nft-card-image-wrap">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      className="nft-card-image"
                      src={item.imageUrl}
                      alt={item.name ?? item.collectionName ?? "NFT"}
                      loading="lazy"
                    />
                  </div>
                ) : (
                  <div className="nft-card-image-wrap nft-card-image-wrap-fallback">
                    <span>NFT</span>
                  </div>
                )}
                <button
                  type="button"
                  className="nft-card-button"
                  onClick={() => {
                    onOpenNft(item);
                  }}
                >
                  <div className="nft-card-body">
                  <strong className="nft-card-title">
                    {item.name ?? `NFT #${item.index ?? "?"}`}
                  </strong>
                  <span className="nft-card-collection">
                    {item.collectionName ?? item.collectionAddress ?? "Unnamed collection"}
                  </span>
                  <span className="nft-card-address">{shortenAddress(item.address)}</span>
                  {item.onSale ? (
                    <span className="nft-card-sale-badge">For sale</span>
                  ) : null}
                  <div className="nft-card-actions">
                    {item.marketplaceUrl ? (
                      <a
                        href={item.marketplaceUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="secondary-button nft-card-link"
                        onClick={(event) => {
                          event.stopPropagation();
                        }}
                      >
                        Open NFT
                      </a>
                    ) : null}
                    {item.collectionUrl ? (
                      <a
                        href={item.collectionUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="secondary-button nft-card-link"
                        onClick={(event) => {
                          event.stopPropagation();
                        }}
                      >
                        Collection
                      </a>
                    ) : null}
                    {item.contentUrl ? (
                      <a
                        href={item.contentUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="secondary-button nft-card-link"
                        onClick={(event) => {
                          event.stopPropagation();
                        }}
                      >
                        Metadata
                      </a>
                    ) : null}
                  </div>
                  </div>
                </button>
              </article>
            ))}
          </div>
          {nftGallery?.hiddenCount ? (
            <p className="portfolio-muted-copy">
              And {nftGallery.hiddenCount} more NFT(s) in the wallet.
            </p>
          ) : null}
        </section>
      ) : null}
    </>
  );
}

function renderExecutionCard(
  message: ChatMessage,
  activeExecutionMessageId: string | null,
  onConfirm: () => void
) {
  if (!message.execution) {
    return null;
  }

  const execution = message.execution;
  const quote = execution.quote;
  const transferMessage = execution.kind === "transfer" ? execution.messages?.[0] : null;
  const transferAmount =
    quote ? `${quote.inputAmount} ${quote.inputSymbol}` : null;

  return (
    <>
      {quote ? (
        <section className="intent-card execution-card">
          <span className="portfolio-label">Execution</span>
          <div className="execution-grid">
            <div className="execution-row">
              <span>Action</span>
              <strong>
                {execution.kind === "transfer" ? "Transfer" : "Swap"}
              </strong>
            </div>
            {execution.kind === "transfer" ? (
              <>
                <div className="execution-row">
                  <span>Amount</span>
                  <strong>{transferAmount ?? "—"}</strong>
                </div>
                <div className="execution-row">
                  <span>Recipient</span>
                  <strong>{transferMessage?.address ?? "—"}</strong>
                </div>
              </>
            ) : (
              <>
                <div className="execution-row">
                  <span>Route</span>
                  <strong>
                    {quote.inputAmount} {quote.inputSymbol} {"->"} {quote.outputAmount}{" "}
                    {quote.outputSymbol}
                  </strong>
                </div>
                <div className="execution-row">
                  <span>Expected output</span>
                  <strong>
                    {quote.outputAmount} {quote.outputSymbol}
                  </strong>
                </div>
              </>
            )}
            {quote.recommendedGasTon !== undefined ? (
              <div className="execution-row">
                <span>Estimated gas</span>
                <strong>{quote.recommendedGasTon} TON</strong>
              </div>
            ) : null}
            {quote.priceImpactPct !== undefined && execution.kind === "swap" ? (
              <div className="execution-row">
                <span>Price impact</span>
                <strong>{quote.priceImpactPct}%</strong>
              </div>
            ) : null}
            {message.intent?.comment ? (
              <div className="execution-row execution-row-stack">
                <span>Comment</span>
                <strong>{message.intent.comment}</strong>
              </div>
            ) : null}
          </div>
        </section>
      ) : null}
      {execution.status === "ready" &&
      execution.validUntil &&
      execution.messages?.length ? (
        <div className="intent-card execution-card execution-card-accent">
          <strong>Confirmation</strong>
          <p className="execution-copy">
            Review the details first, then open the wallet to sign the transaction.
          </p>
          <div className="message-actions">
            <button
              type="button"
              className="primary-button message-action-button"
              onClick={onConfirm}
              disabled={activeExecutionMessageId === message.id}
            >
              {activeExecutionMessageId === message.id
                ? "Opening wallet..."
                : "Confirm and open wallet"}
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}

function renderFeeEstimateCard(feeEstimate: FeeEstimateData | undefined) {
  if (!feeEstimate) {
    return null;
  }

  return (
    <section className="intent-card execution-card">
      <span className="portfolio-label">Fee estimate</span>
      <div className="execution-grid">
        <div className="execution-row">
          <span>Estimated fee</span>
          <strong>{feeEstimate.estimatedFeeTon} TON</strong>
        </div>
        {feeEstimate.amount ? (
          <div className="execution-row">
            <span>Transfer amount</span>
            <strong>{feeEstimate.amount}</strong>
          </div>
        ) : null}
        {feeEstimate.recipient ? (
          <div className="execution-row">
            <span>Recipient</span>
            <strong>{feeEstimate.recipient}</strong>
          </div>
        ) : null}
        {feeEstimate.comment ? (
          <div className="execution-row execution-row-stack">
            <span>Comment</span>
            <strong>{feeEstimate.comment}</strong>
          </div>
        ) : null}
        <div className="execution-row execution-row-stack">
          <span>Basis</span>
          <strong>{feeEstimate.basis}</strong>
        </div>
      </div>
    </section>
  );
}

function getThreadTitle(messages: ChatMessage[]) {
  const firstUserMessage = messages.find((message) => message.role === "user")?.text.trim();
  if (!firstUserMessage) {
    return "New chat";
  }

  return firstUserMessage.length > 36
    ? `${firstUserMessage.slice(0, 36).trimEnd()}...`
    : firstUserMessage;
}

function shortenAddress(address: string) {
  if (!address) {
    return "";
  }

  if (address.length <= 12) {
    return address;
  }

  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

function formatChatTimestamp(value: string) {
  const date = new Date(value);
  const now = new Date();
  const isSameYear = date.getFullYear() === now.getFullYear();

  return date.toLocaleString("en-US", {
    month: isSameYear ? "short" : "short",
    day: "numeric",
    ...(isSameYear ? {} : { year: "numeric" }),
    hour: "numeric",
    minute: "2-digit"
  });
}

function formatMessageTimestamp(value: string) {
  return new Date(value).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit"
  });
}

export function ChatShell() {
  const [chats, setChats] = useState<ChatThread[]>([initialChatThread]);
  const [activeChatId, setActiveChatId] = useState<string>(initialChatThread.id);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [isKeyboardOpen, setIsKeyboardOpen] = useState(false);
  const [expandedPortfolioMessages, setExpandedPortfolioMessages] = useState<
    Record<string, boolean>
  >({});
  const [walletBalance, setWalletBalance] = useState<string | null>(null);
  const [activeExecutionMessageId, setActiveExecutionMessageId] = useState<string | null>(null);
  const [activeNft, setActiveNft] = useState<NftAsset | null>(null);
  const [isPending, startTransition] = useTransition();
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const composerInputRef = useRef<HTMLInputElement | null>(null);
  const lastMessageRef = useRef<HTMLElement | null>(null);
  const viewportBaseHeightRef = useRef(0);
  const bottomLockTimeoutsRef = useRef<number[]>([]);
  const bottomLockIntervalRef = useRef<number | null>(null);
  const openFreshChatRef = useRef<() => void>(() => {});
  const lastMiniAppActivationRef = useRef(0);
  const {
    wallet,
    walletAddress,
    tonConnectUI,
    connectionRestored
  } = useTonRuntime();
  const activeChat =
    chats.find((chat) => chat.id === activeChatId) ??
    chats[0] ??
    initialChatThread;
  const messages = activeChat.messages;

  const scrollMessagesToBottom = (behavior: ScrollBehavior = "smooth") => {
    const node = messageListRef.current;

    if (!node) {
      return;
    }

    node.scrollTo({
      top: node.scrollHeight,
      behavior
    });
  };

  const revealLatestMessage = (behavior: ScrollBehavior = "smooth") => {
    const list = messageListRef.current;
    const lastMessage = lastMessageRef.current;

    if (!list || !lastMessage) {
      scrollMessagesToBottom(behavior);
      return;
    }

    const listStyle = window.getComputedStyle(list);
    const paddingBottom = Number.parseFloat(listStyle.paddingBottom) || 0;
    const bottomGap = 12;
    const targetTop =
      lastMessage.offsetTop +
      lastMessage.offsetHeight -
      list.clientHeight +
      paddingBottom +
      bottomGap;

    list.scrollTo({
      top: Math.max(0, targetTop),
      behavior
    });
  };

  const clearBottomLock = () => {
    bottomLockTimeoutsRef.current.forEach((timeoutId) => {
      window.clearTimeout(timeoutId);
    });
    bottomLockTimeoutsRef.current = [];

    if (bottomLockIntervalRef.current !== null) {
      window.clearInterval(bottomLockIntervalRef.current);
      bottomLockIntervalRef.current = null;
    }
  };

  const forceChatToBottom = () => {
    revealLatestMessage("auto");
  };

  const lockChatToBottom = () => {
    clearBottomLock();

    [0, 60, 140, 240, 360, 520, 760, 1000].forEach((delay) => {
      const timeoutId = window.setTimeout(() => {
        forceChatToBottom();
      }, delay);

      bottomLockTimeoutsRef.current.push(timeoutId);
    });

    bottomLockIntervalRef.current = window.setInterval(() => {
      forceChatToBottom();
    }, 120);

    const intervalStopId = window.setTimeout(() => {
      if (bottomLockIntervalRef.current !== null) {
        window.clearInterval(bottomLockIntervalRef.current);
        bottomLockIntervalRef.current = null;
      }
    }, 1400);

    bottomLockTimeoutsRef.current.push(intervalStopId);
  };

  const openTonConnect = async () => {
    if (!tonConnectUI?.openModal) {
      return;
    }

    void tonConnectUI.openModal();
  };

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const fallbackNode = document.getElementById("app-boot-fallback");
    fallbackNode?.setAttribute("data-mounted", "true");

    try {
      const raw = window.localStorage.getItem(chatsStorageKey);

      if (!raw) {
        return;
      }

      const parsed = JSON.parse(raw) as unknown;
      const restoredChats = Array.isArray(parsed)
        ? parsed
            .map(sanitizeChatThread)
            .filter((chat): chat is ChatThread => Boolean(chat))
            .filter((chat) => !isEmptyChatThread(chat))
        : [];

      if (restoredChats.length) {
        const nextChat = createChatThread();
        setChats([nextChat, ...restoredChats]);
        setActiveChatId(nextChat.id);
      }
    } catch {
      // Ignore malformed local storage data.
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const persistedChats = chats.filter((chat) => !isEmptyChatThread(chat));

    try {
      if (persistedChats.length) {
        window.localStorage.setItem(chatsStorageKey, JSON.stringify(persistedChats));
      } else {
        window.localStorage.removeItem(chatsStorageKey);
      }
    } catch {
      // Ignore local storage write errors.
    }
  }, [chats]);

  useEffect(() => {
    if (!activeChatId && chats.length) {
      setActiveChatId(chats[0].id);
    }
  }, [activeChatId, chats]);

  useEffect(() => {
    scrollMessagesToBottom("auto");
  }, [activeChatId]);

  useEffect(() => {
    scrollMessagesToBottom();
  }, [isPending, messages.length]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const viewport = window.visualViewport;
    const root = document.documentElement;

    const syncViewportInset = () => {
      const visibleHeight = Math.round(
        Math.min(window.innerHeight, viewport?.height ?? window.innerHeight)
      );
      const visibleBottom = Math.round((viewport?.offsetTop ?? 0) + visibleHeight);

      viewportBaseHeightRef.current = Math.max(
        viewportBaseHeightRef.current,
        window.innerHeight,
        Math.round(visibleBottom)
      );

      const keyboardInset = Math.max(0, viewportBaseHeightRef.current - visibleBottom);

      root.style.setProperty("--app-height", `${visibleHeight}px`);
      root.style.setProperty("--viewport-bottom-offset", `${keyboardInset}px`);
    };

    const syncViewportAndReveal = () => {
      syncViewportInset();

      if (document.activeElement === composerInputRef.current) {
        lockChatToBottom();
      }
    };

    syncViewportAndReveal();

    viewport?.addEventListener("resize", syncViewportAndReveal);
    viewport?.addEventListener("scroll", syncViewportAndReveal);
    window.addEventListener("resize", syncViewportAndReveal);

    return () => {
      viewport?.removeEventListener("resize", syncViewportAndReveal);
      viewport?.removeEventListener("scroll", syncViewportAndReveal);
      window.removeEventListener("resize", syncViewportAndReveal);
      clearBottomLock();
      root.style.removeProperty("--app-height");
      root.style.setProperty("--viewport-bottom-offset", "0px");
    };
  }, []);

  useEffect(() => {
    const input = composerInputRef.current;

    if (!input) {
      return;
    }

    const handleFocus = () => {
      setIsKeyboardOpen(true);
      lockChatToBottom();
    };

    const handleBlur = () => {
      setIsKeyboardOpen(false);
      clearBottomLock();
    };

    input.addEventListener("focus", handleFocus);
    input.addEventListener("blur", handleBlur);

    return () => {
      input.removeEventListener("focus", handleFocus);
      input.removeEventListener("blur", handleBlur);
    };
  }, [activeChatId, messages.length]);

  useEffect(() => {
    if (!wallet) {
      setWalletBalance(null);
    }
  }, [wallet]);

  useEffect(() => {
    if (!walletAddress) {
      setWalletBalance(null);
      return;
    }

    let cancelled = false;

    const loadWalletBalance = async () => {
      try {
        const response = await fetch(
          `/api/wallet-balance?address=${encodeURIComponent(walletAddress)}`,
          {
            cache: "no-store"
          }
        );

        if (!response.ok) {
          throw new Error(`Balance request failed with ${response.status}`);
        }

        const payload = (await response.json()) as {
          balance?: string;
        };

        if (!cancelled) {
          setWalletBalance(payload.balance ?? null);
        }
      } catch {
        if (!cancelled) {
          setWalletBalance(null);
        }
      }
    };

    void loadWalletBalance();

    const intervalId = window.setInterval(() => {
      void loadWalletBalance();
    }, 30000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [walletAddress]);

  const updateActiveChat = (
    updater: (chat: ChatThread) => ChatThread
  ) => {
    setChats((current) =>
      current.map((chat) => (chat.id === activeChat.id ? updater(chat) : chat))
    );
  };

  const openFreshChat = () => {
    const existingEmptyChat = chats.find((chat) => isEmptyChatThread(chat));

    if (existingEmptyChat) {
      setChats((current) =>
        current.map((chat) =>
          chat.id === existingEmptyChat.id
            ? {
                ...chat,
                updatedAt: new Date().toISOString(),
                quickPrompts: getRandomQuickPrompts()
              }
            : chat
        )
      );
      setActiveChatId(existingEmptyChat.id);
    } else {
      const nextChat = createChatThread();
      setChats((current) => [nextChat, ...current]);
      setActiveChatId(nextChat.id);
    }

    setDraft("");
    setActiveExecutionMessageId(null);
    setIsSidebarOpen(false);
  };

  openFreshChatRef.current = openFreshChat;

  const createNewChat = () => {
    openFreshChat();
  };

  const removeChat = (chatId: string) => {
    setChats((current) => {
      const remainingChats = current.filter((chat) => chat.id !== chatId);

      if (!remainingChats.length) {
        const nextChat = createChatThread();
        setActiveChatId(nextChat.id);
        return [nextChat];
      }

      if (activeChatId === chatId) {
        setActiveChatId(remainingChats[0].id);
      }

      return remainingChats;
    });

    setActiveExecutionMessageId(null);
  };

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const webApp = window.Telegram?.WebApp;

    if (!webApp?.onEvent) {
      return;
    }

    const handleMiniAppActivated = () => {
      const now = Date.now();

      if (now - lastMiniAppActivationRef.current < 1200) {
        return;
      }

      lastMiniAppActivationRef.current = now;
      openFreshChatRef.current();
    };

    webApp.onEvent("activated", handleMiniAppActivated);

    return () => {
      webApp.offEvent?.("activated", handleMiniAppActivated);
    };
  }, []);

  const disconnectWallet = async () => {
    if (!tonConnectUI?.disconnect) {
      return;
    }
    try {
      await tonConnectUI.disconnect();
      setWalletBalance(null);
    } catch {
      // Let TonConnect UI keep its own disconnect state.
    }
  };

  const confirmExecution = async (message: ChatMessage) => {
    if (
      message.execution?.status !== "ready" ||
      !message.execution.validUntil ||
      !message.execution.messages?.length ||
      !tonConnectUI ||
      !tonConnectUI.sendTransaction
    ) {
      return;
    }

    setActiveExecutionMessageId(message.id);
    let handoffFallbackTimeoutId: number | undefined;

    try {
      await tonConnectUI.sendTransaction({
        validUntil: message.execution.validUntil,
        messages: message.execution.messages.map((item) => ({
          address: item.address,
          amount: item.amount,
          payload: item.payload,
          stateInit: item.stateInit
        }))
      }, {
        onRequestSent: (redirectToWallet) => {
          try {
            let didLeaveApp = false;
            const markHidden = () => {
              didLeaveApp = true;
            };

            const cleanup = () => {
              window.removeEventListener("blur", markHidden);
              document.removeEventListener("visibilitychange", handleVisibilityChange);
            };

            const handleVisibilityChange = () => {
              if (document.visibilityState === "hidden") {
                didLeaveApp = true;
              }
            };

            window.addEventListener("blur", markHidden, { once: true });
            document.addEventListener("visibilitychange", handleVisibilityChange);
            redirectToWallet();

            handoffFallbackTimeoutId = window.setTimeout(() => {
              cleanup();
              if (!didLeaveApp) {
                const walletName = wallet?.device?.appName ?? "unknown wallet";
                const walletProvider = wallet?.provider ?? "unknown";
                const nextMessage: ChatMessage = {
                  id: crypto.randomUUID(),
                  role: "assistant",
                  text:
                    `The wallet did not open automatically. ` +
                    `Connected wallet: ${walletName} (${walletProvider}). ` +
                    `Most likely this connection does not support a proper Telegram Mini App handoff. ` +
                    `Reconnect the wallet from the same phone inside Telegram and try again.`,
                  createdAt: new Date().toISOString()
                };

                updateActiveChat((chat) => {
                  const nextMessages = [...chat.messages, nextMessage];
                  return {
                    ...chat,
                    messages: nextMessages,
                    title: getThreadTitle(nextMessages),
                    updatedAt: nextMessage.createdAt
                  };
                });
              }
            }, 900);
          } catch {
            // Let TonConnect handle the normal flow if redirect callback fails.
          }
        }
      });
      const nextMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        text:
          message.execution?.kind === "swap"
            ? "The wallet received the swap transaction for confirmation. After approval, the swap will be sent to the TON network."
            : "The wallet received the transfer for confirmation. After approval, the transaction will be sent to the TON network.",
        createdAt: new Date().toISOString()
      };

      updateActiveChat((chat) => {
        const nextMessages = [...chat.messages, nextMessage];
        return {
          ...chat,
          messages: nextMessages,
          title: getThreadTitle(nextMessages),
          updatedAt: nextMessage.createdAt
        };
      });
    } catch (error) {
      const nextMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        text: getWalletErrorText(error),
        createdAt: new Date().toISOString()
      };

      updateActiveChat((chat) => {
        const nextMessages = [...chat.messages, nextMessage];
        return {
          ...chat,
          messages: nextMessages,
          title: getThreadTitle(nextMessages),
          updatedAt: nextMessage.createdAt
        };
      });
    } finally {
      if (handoffFallbackTimeoutId) {
        window.clearTimeout(handoffFallbackTimeoutId);
      }
      setActiveExecutionMessageId(null);
    }
  };

  const sendMessage = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      text: trimmed,
      createdAt: new Date().toISOString()
    };

    const historyMessages = activeChat.messages;
    updateActiveChat((chat) => {
      const nextMessages = [...chat.messages, userMessage];
      return {
        ...chat,
        messages: nextMessages,
        title: getThreadTitle(nextMessages),
        updatedAt: userMessage.createdAt
      };
    });
    setDraft("");
    setIsSidebarOpen(false);

    startTransition(async () => {
      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            message: trimmed,
            walletAddress: walletAddress || undefined,
            walletConnected: Boolean(wallet),
            history: historyMessages.slice(-8).map((message) => ({
              role: message.role,
              text: message.text,
              intent: message.intent
                ? {
                    action: message.intent.action,
                    fromToken: message.intent.fromToken,
                    toToken: message.intent.toToken,
                    recipient: message.intent.recipient,
                    query: message.intent.query
                  }
                : undefined
            }))
          })
        });

        const payload = (await response.json()) as {
          text?: string;
          error?: string;
          intent?: ChatMessage["intent"];
          execution?: ChatMessage["execution"];
          portfolio?: ChatMessage["portfolio"];
          understanding?: ChatMessage["understanding"];
          feeEstimate?: ChatMessage["feeEstimate"];
        };

        const assistantMessage: ChatMessage = {
          id: crypto.randomUUID(),
          role: "assistant",
          text: payload.text ?? payload.error ?? "Could not process the request.",
          createdAt: new Date().toISOString(),
          intent: payload.intent,
          execution: payload.execution,
          portfolio: payload.portfolio,
          feeEstimate: payload.feeEstimate,
          understanding: payload.understanding
        };

        updateActiveChat((chat) => {
          const nextMessages = [...chat.messages, assistantMessage];
          return {
            ...chat,
            messages: nextMessages,
            title: getThreadTitle(nextMessages),
            updatedAt: assistantMessage.createdAt
          };
        });
      } catch {
        const assistantMessage: ChatMessage = {
          id: crypto.randomUUID(),
          role: "assistant",
          text: "Network or server error. Check /api/chat and the environment variables.",
          createdAt: new Date().toISOString()
        };

        updateActiveChat((chat) => {
          const nextMessages = [...chat.messages, assistantMessage];
          return {
            ...chat,
            messages: nextMessages,
            title: getThreadTitle(nextMessages),
            updatedAt: assistantMessage.createdAt
          };
        });
      }
    });
  };

  return (
    <main className="app-shell">
      {activeNft ? (
        <div className="nft-viewer-overlay" onClick={() => setActiveNft(null)}>
          <section
            className="nft-viewer"
            onClick={(event) => {
              event.stopPropagation();
            }}
          >
            <button
              type="button"
              className="nft-viewer-close"
              aria-label="Close NFT"
              onClick={() => {
                setActiveNft(null);
              }}
            >
              ×
            </button>
            {activeNft.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                className="nft-viewer-image"
                src={activeNft.imageUrl}
                alt={activeNft.name ?? activeNft.collectionName ?? "NFT"}
              />
            ) : (
              <div className="nft-viewer-image nft-viewer-image-fallback">NFT</div>
            )}
            <div className="nft-viewer-body">
              <strong className="nft-viewer-title">
                {activeNft.name ?? `NFT #${activeNft.index ?? "?"}`}
              </strong>
              <span className="nft-viewer-collection">
                {activeNft.collectionName ?? activeNft.collectionAddress ?? "Unnamed collection"}
              </span>
              <span className="nft-viewer-address">{activeNft.address}</span>
              {activeNft.onSale ? (
                <span className="nft-card-sale-badge nft-viewer-sale-badge">For sale</span>
              ) : null}
              <div className="nft-viewer-actions">
                {activeNft.marketplaceUrl ? (
                  <a
                    href={activeNft.marketplaceUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="secondary-button nft-card-link"
                  >
                    Open NFT
                  </a>
                ) : null}
                {activeNft.collectionUrl ? (
                  <a
                    href={activeNft.collectionUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="secondary-button nft-card-link"
                  >
                    Open collection
                  </a>
                ) : null}
                {activeNft.contentUrl ? (
                  <a
                    href={activeNft.contentUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="secondary-button nft-card-link"
                  >
                    Open metadata
                  </a>
                ) : null}
              </div>
            </div>
          </section>
        </div>
      ) : null}
      {isSidebarOpen ? (
        <button
          type="button"
          className="sidebar-backdrop"
          aria-label="Close chat menu"
          onClick={() => {
            setIsSidebarOpen(false);
          }}
        />
      ) : null}
      <aside className={`chat-sidebar ${isSidebarOpen ? "open" : ""}`}>
        <div className="chat-sidebar-header">
          <strong>Chats</strong>
          <button
            type="button"
            className="secondary-button sidebar-new-chat"
            onClick={createNewChat}
          >
            New chat
          </button>
        </div>
        <div className="chat-thread-list">
          {chats.map((chat) => (
            <div key={chat.id} className="chat-thread-row">
              <button
                type="button"
                className={`chat-thread-item ${chat.id === activeChat.id ? "active" : ""}`}
                onClick={() => {
                  setActiveChatId(chat.id);
                  setIsSidebarOpen(false);
                }}
              >
                <strong>{chat.title}</strong>
                <span>
                  {formatChatTimestamp(chat.updatedAt)}
                </span>
              </button>
              <button
                type="button"
                className="chat-thread-delete"
                aria-label={`Delete chat ${chat.title}`}
                onClick={(event) => {
                  event.stopPropagation();
                  removeChat(chat.id);
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      </aside>
      <section className={`chat-frame ${isKeyboardOpen ? "keyboard-open" : ""}`}>
        <header className="chat-header">
          <div className="chat-title">
            <button
              type="button"
              className="sidebar-toggle"
              aria-label="Open chat menu"
              onClick={() => {
                setIsSidebarOpen((current) => !current);
              }}
            >
              <span />
              <span />
              <span />
            </button>
            <div className="avatar">AI</div>
            <div>
              <h1>TON AI Agent</h1>
            </div>
          </div>
          <div className="wallet-control">
            <div className="wallet-summary">
              {walletBalance ? (
                <div className="wallet-balance-pill">
                  {Number(walletBalance).toFixed(2)} TON
                </div>
              ) : null}
              {wallet && connectionRestored ? (
                <div className="wallet-balance-pill">
                  {shortenAddress(walletAddress)}
                </div>
              ) : null}
              {wallet && connectionRestored ? (
                <button
                  type="button"
                  className="secondary-button wallet-disconnect-button"
                  onClick={() => {
                    tonConnectUI?.disconnect?.();
                  }}
                >
                  Disconnect
                </button>
              ) : (
                <button
                  type="button"
                  className="secondary-button wallet-connect-fallback"
                  onClick={() => {
                    void openTonConnect();
                  }}
                >
                  Connect wallet
                </button>
              )}
            </div>
          </div>
        </header>

        <div ref={messageListRef} className="message-list">
          {messages.length === 0 ? (
            <section className="quick-prompts-state">
              <div className="quick-prompts-copy">
                <h2>What do you want to do?</h2>
                <p>Pick a ready-made prompt or type your own.</p>
              </div>
              <div className="quick-prompts-grid">
                {activeChat.quickPrompts.map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    className="quick-prompt-button"
                    onClick={() => {
                      void sendMessage(prompt);
                    }}
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </section>
          ) : null}
          {messages.map((message) => (
            <article
              key={message.id}
              ref={message.id === messages.at(-1)?.id ? lastMessageRef : null}
              className={`message ${message.role === "user" ? "user" : "assistant"}`}
            >
              <div className="message-meta">
                <span>{message.role === "user" ? "You" : "TON AI"}</span>
                <span>
                  {formatMessageTimestamp(message.createdAt)}
                </span>
              </div>
              {message.role === "assistant" && message.intent?.action === "balance"
                ? renderBalanceMessage(
                    message.text,
                    message.portfolio,
                    Boolean(expandedPortfolioMessages[message.id]),
                    () => {
                      setExpandedPortfolioMessages((current) => ({
                        ...current,
                        [message.id]: !current[message.id]
                      }));
                    },
                    Boolean(expandedPortfolioMessages[`${message.id}:unknown`]),
                    () => {
                      setExpandedPortfolioMessages((current) => ({
                        ...current,
                        [`${message.id}:unknown`]: !current[`${message.id}:unknown`]
                      }));
                    }
                  )
                : message.role === "assistant" && message.intent?.action === "nft"
                  ? renderNftMessage(
                      message.text,
                      message.nftGallery,
                      (item) => {
                        setActiveNft(item);
                      }
                    )
                  : <div className="message-text">{formatAssistantText(message.text)}</div>}
              {message.role === "assistant"
                ? renderExecutionCard(
                    message,
                    activeExecutionMessageId,
                    () => {
                      void confirmExecution(message);
                    }
                  )
                : null}
              {message.role === "assistant" && message.intent?.action === "fee_estimate"
                ? renderFeeEstimateCard(message.feeEstimate)
                : null}
            </article>
          ))}
        </div>

        <div className="composer">
          <form
            className="composer-form"
            onSubmit={(event) => {
              event.preventDefault();
              void sendMessage(draft);
            }}
          >
            <input
              className="composer-input"
              ref={composerInputRef}
              type="text"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Ask about wallet, swap, or username..."
            />
            <button
              className="composer-send-button"
              type="submit"
              disabled={isPending || !draft.trim()}
              aria-label={isPending ? "Processing message" : "Send message"}
            >
              <span className="composer-send-icon" aria-hidden="true">
                {isPending ? (
                  "..."
                ) : (
                  <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path
                      d="M21.5 3.5L10.8 14.2"
                      stroke="currentColor"
                      strokeWidth="1.9"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                    <path
                      d="M21.5 3.5L14.7 20.5L10.8 14.2L4.5 10.3L21.5 3.5Z"
                      stroke="currentColor"
                      strokeWidth="1.9"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
              </span>
            </button>
          </form>
        </div>
      </section>
    </main>
  );
}
