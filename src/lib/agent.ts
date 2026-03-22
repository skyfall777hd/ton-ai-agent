import { Address } from "@ton/core";
import { z } from "zod";
import {
  buildExecutionPlan,
  getListedTokenBySymbol,
  getSwapCoffeeQuote,
  getSwapCoffeeTokenMetadata
} from "@/lib/execution";
import { getCapabilitiesText } from "@/lib/mcp";
import type {
  AgentIntent,
  NftGalleryData,
  PortfolioData,
  UnderstandingData
} from "@/lib/types";
import { getWalletPortfolioViaMcp } from "@/lib/wallet-mcp";

type JettonMetadata = {
  symbol?: string;
  name?: string;
  decimals?: number | string;
};

type WalletJetton = {
  name?: string;
  symbol: string;
  balance: string;
  numericBalance: number;
  hasReadableMetadata: boolean;
};

type WalletNft = {
  address: string;
  name?: string;
  collection?: string;
  collectionAddress?: string;
  index?: string;
  imageUrl?: string;
  contentUri?: string;
  marketplaceUrl?: string;
  onSale: boolean;
};

type TokenResearchData = {
  subject: string;
  symbol?: string;
  name?: string;
  address?: string;
  listedOnSwapCoffee: boolean;
  estimatedPriceUsdt?: number | null;
  quoteSource?: string;
  notes: string[];
};

type AddressCheckData = {
  input: string;
  normalizedAddress?: string;
  resolvedFromDns?: string;
  tonBalance?: string | null;
  jettons: WalletJetton[];
  nfts: WalletNft[];
  notes: string[];
};

type WalletTransaction = {
  hash: string;
  direction: "in" | "out" | "unknown";
  amountTon?: string;
  timestamp?: number;
  from?: string;
  to?: string;
  comment?: string;
};

function isDefined<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

const historyItemSchema = z.object({
  role: z.enum(["user", "assistant"]),
  text: z.string().min(1).max(4000),
  intent: z
    .object({
      action: z
        .enum([
          "swap",
          "sell",
          "buy",
          "send",
          "balance",
          "transactions",
          "nft",
          "username_price",
          "fee_estimate",
          "token_research",
          "address_check",
          "contract_explain",
          "unknown"
        ])
        .optional(),
      fromToken: z.string().optional(),
      toToken: z.string().optional(),
      recipient: z.string().optional(),
      query: z.string().optional(),
      comment: z.string().optional()
    })
    .optional()
});

const chatInputSchema = z.object({
  message: z.string().min(1).max(1500),
  walletAddress: z.string().optional(),
  walletConnected: z.boolean().optional(),
  history: z.array(historyItemSchema).max(12).optional()
});

const amountTokenPattern =
  /(?:(?:swap|sell|buy|send|свап|продай|продать|купи|купить|отправь|переведи)\s+)?(\d+(?:[.,]\d+)?)\s+([a-zA-Zа-яА-ЯёЁ$]{2,12})/i;

const tokenAliases: Record<string, string> = {
  ton: "TON",
  "тон": "TON",
  usdt: "USDT",
  "юсдт": "USDT",
  usdc: "USDC",
  "юсдц": "USDC",
  btc: "BTC",
  "биток": "BTC",
  "биткоин": "BTC",
  eth: "ETH",
  "эфир": "ETH",
  "эфириум": "ETH"
};

const parsedIntentSchema = z.object({
  action: z.enum([
    "swap",
    "sell",
    "buy",
    "send",
    "balance",
    "transactions",
    "nft",
    "username_price",
    "fee_estimate",
    "token_research",
    "address_check",
    "contract_explain",
    "unknown"
  ]),
  amount: z.number().positive().optional(),
  fromToken: z.string().min(1).optional(),
  toToken: z.string().min(1).optional(),
  recipient: z.string().min(1).optional(),
  query: z.string().min(1).optional(),
  comment: z.string().min(1).optional(),
  normalizedRequest: z.string().min(1).optional(),
  confidence: z.enum(["low", "medium", "high"]).optional()
});

const conversationStateSchema = z.object({
  lastAction: z
    .enum([
      "swap",
      "sell",
      "buy",
      "send",
      "balance",
      "transactions",
      "nft",
      "username_price",
      "fee_estimate",
      "token_research",
      "address_check",
      "contract_explain",
      "unknown"
    ])
    .optional(),
  lastUsernameQuery: z.string().optional(),
  lastRecipient: z.string().optional(),
  lastFromToken: z.string().optional(),
  lastToToken: z.string().optional(),
  lastComment: z.string().optional()
});

const typoReplacements: Array<[RegExp, string]> = [
  [/\bсколь\b/gi, "сколько"],
  [/\bскока\b/gi, "сколько"],
  [/\bкошелке\b/gi, "кошельке"],
  [/\bкошелк\b/gi, "кошелек"],
  [/\bтокеновв\b/gi, "токенов"],
  [/\bюсдтт\b/gi, "юсдт"],
  [/\bтонн\b/gi, "тон"]
];

function normalizeAmount(raw?: string) {
  if (!raw) {
    return undefined;
  }

  return Number(raw.replace(",", "."));
}

function normalizeUserText(input: string) {
  return typoReplacements.reduce(
    (text, [pattern, replacement]) => text.replace(pattern, replacement),
    input.trim()
  );
}

function normalizeJettonAddress(address?: string) {
  return address?.trim().toUpperCase();
}

const tonDnsEndpoint =
  process.env.TON_API_V3_DNS_ENDPOINT ?? "https://toncenter.com/api/v3/dns/records";

function getJettonAliasOverrides() {
  const raw = process.env.JETTON_ALIASES_JSON;

  if (!raw) {
    return {} as Record<string, { symbol?: string; name?: string }>;
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, { symbol?: string; name?: string }>;
    return Object.fromEntries(
      Object.entries(parsed).map(([address, value]) => [
        normalizeJettonAddress(address) ?? address,
        value
      ])
    );
  } catch {
    return {} as Record<string, { symbol?: string; name?: string }>;
  }
}

function normalizeToken(raw?: string) {
  if (!raw) {
    return undefined;
  }

  const normalized = raw.trim().toLowerCase();
  return tokenAliases[normalized] ?? raw.toUpperCase();
}

function extractLooseUsername(text: string) {
  const cleaned = text
    .trim()
    .replace(/^а\s+/i, "")
    .replace(/^и\s+/i, "")
    .replace(/^ну\s+/i, "")
    .replace(/[?.!,]+$/g, "")
    .trim();

  const match = cleaned.match(/^@?([a-zA-Z0-9_]{4,32})$/);
  return match?.[1]?.toLowerCase();
}

function needsGeneratedComment(text: string) {
  const lower = text.toLowerCase();
  return (
    lower.includes("что-нибудь друж") ||
    lower.includes("что нибудь друж") ||
    lower.includes("что-то друж") ||
    lower.includes("поздрав") ||
    lower.includes("с днем рождения") ||
    lower.includes("с днём рождения") ||
    lower.includes("придумай комментар") ||
    lower.includes("напиши комментар") ||
    lower.includes("и напиши") ||
    lower.includes("и добавь") ||
    lower.includes("добавь комментар") ||
    lower.includes("напиши что-нибудь") ||
    lower.includes("напиши что нибудь")
  );
}

function stripCodeFences(value: string) {
  return value
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function createBaseIntent(action: AgentIntent["action"]): AgentIntent {
  switch (action) {
    case "username_price":
      return {
        action,
        needsWallet: false,
        needsConfirmation: false,
        summary: "",
        safetyNotes: [
          "Username price comes from an external source and may change.",
          "If the asset is not found on Fragment, the response should say so clearly."
        ]
      };
    case "fee_estimate":
      return {
        action,
        needsWallet: false,
        needsConfirmation: false,
        summary: "",
        safetyNotes: [
          "Fee estimates are informational and should not trigger execution.",
          "The final network fee is shown by the wallet before confirmation."
        ]
      };
    case "token_research":
      return {
        action,
        needsWallet: false,
        needsConfirmation: false,
        summary: "",
        safetyNotes: [
          "Token research should be framed as informational, not financial advice.",
          "If data is incomplete, the response should ask for token symbol or address."
        ]
      };
    case "address_check":
      return {
        action,
        needsWallet: false,
        needsConfirmation: false,
        summary: "",
        safetyNotes: [
          "Address checks should focus on risk signals and uncertainty, not certainty.",
          "If no address is provided, the response should ask for one."
        ]
      };
    case "contract_explain":
      return {
        action,
        needsWallet: false,
        needsConfirmation: false,
        summary: "",
        safetyNotes: [
          "Contract explanations should stay informational and plain-English.",
          "If no contract or address is provided, the response should ask for it."
        ]
      };
    case "balance":
      return {
        action,
        needsWallet: true,
        needsConfirmation: false,
        summary: "",
        safetyNotes: [
          "Viewing the balance does not require a wallet signature.",
          "If the wallet is not connected yet, the user should be asked to connect it first."
        ]
      };
    case "transactions":
      return {
        action,
        needsWallet: true,
        needsConfirmation: false,
        summary: "",
        safetyNotes: [
          "Viewing transaction history does not require a wallet signature.",
          "If the wallet is not connected yet, the user should be asked to connect it first."
        ]
      };
    case "nft":
      return {
        action,
        needsWallet: true,
        needsConfirmation: false,
        summary: "",
        safetyNotes: [
          "Viewing NFTs does not require a wallet signature.",
          "If the wallet is not connected yet, the user should be asked to connect it first."
        ]
      };
    case "swap":
      return {
        action,
        needsWallet: true,
        needsConfirmation: true,
        protocol: "swap.coffee",
        summary: "",
        safetyNotes: [
          "Before any on-chain execution, the app should show the quote, slippage, and minimum received.",
          "Transaction signing must happen only in the connected TON wallet."
        ]
      };
    case "sell":
      return {
        action,
        needsWallet: true,
        needsConfirmation: true,
        protocol: "swap.coffee",
        summary: "",
        safetyNotes: [
          "Selling requires a quote from swap.coffee and a clear expected result.",
          "The app must not execute a sell action without user confirmation."
        ]
      };
    case "buy":
      return {
        action,
        needsWallet: true,
        needsConfirmation: true,
        protocol: "swap.coffee",
        summary: "",
        safetyNotes: [
          "Buying must account for TON network conditions, slippage, and pool liquidity.",
          "Actual execution starts only after the user confirms it."
        ]
      };
    case "send":
      return {
        action,
        needsWallet: true,
        needsConfirmation: true,
        summary: "",
        safetyNotes: [
          "Before a transfer, the app should validate the TON address format and network.",
          "Recipient, amount, and comment should be shown to the user before confirmation."
        ]
      };
    default:
      return {
        action: "unknown",
        needsWallet: false,
        needsConfirmation: false,
        summary: "",
        safetyNotes: [
          "If the request touches assets, the app should separately parse the action and confirmation step."
        ]
      };
  }
}

function finalizeIntent(intent: AgentIntent) {
  intent.summary = summarizeIntent(intent);
  return intent;
}

function normalizeRecipient(raw?: string) {
  if (!raw) {
    return undefined;
  }

  return raw.trim();
}

function deriveConversationState(history: z.infer<typeof historyItemSchema>[] = []) {
  const state: z.infer<typeof conversationStateSchema> = {};

  for (let index = history.length - 1; index >= 0; index -= 1) {
    const item = history[index];
    const intent = item?.intent;
    if (!intent) {
      continue;
    }

    if (!state.lastAction && intent.action) {
      state.lastAction = intent.action;
    }

    if (!state.lastUsernameQuery && intent.query) {
      state.lastUsernameQuery = intent.query;
    }

    if (!state.lastRecipient && intent.recipient) {
      state.lastRecipient = intent.recipient;
    }

    if (!state.lastFromToken && intent.fromToken) {
      state.lastFromToken = intent.fromToken;
    }

    if (!state.lastToToken && intent.toToken) {
      state.lastToToken = intent.toToken;
    }

    if (!state.lastComment && intent.comment) {
      state.lastComment = intent.comment;
    }
  }

  return conversationStateSchema.parse(state);
}

function extractRecipient(text: string) {
  const explicitRecipient = text.match(
    /(?:to|на)\s+(?:address|addr|адрес)?\s*([a-zA-Z0-9:_-]{20,80}|[a-zA-Z0-9-]{1,126}\.ton)\b/i
  );

  if (explicitRecipient?.[1]) {
    return normalizeRecipient(explicitRecipient[1]);
  }

  const inlineRecipient = text.match(
    /(?:send|отправь|переведи)\s+\d+(?:[.,]\d+)?\s+[a-zA-Zа-яА-ЯёЁ$]{2,12}\s+(?:to\s+)?(?:address|addr|адрес)?\s*([a-zA-Z0-9:_-]{20,80}|[a-zA-Z0-9-]{1,126}\.ton)\b/i
  );

  return normalizeRecipient(inlineRecipient?.[1]);
}

function extractRecipientCandidate(text: string) {
  return extractRecipient(text) ?? normalizeRecipient(extractAddressLikeValue(text));
}

function detectUserLanguage(text: string) {
  const cyrillicChars = (text.match(/[а-яё]/gi) ?? []).length;
  const latinChars = (text.match(/[a-z]/gi) ?? []).length;
  const englishHints =
    /(?:\bshow\b|\bbalance\b|\bsend\b|\bswap\b|\bsell\b|\bbuy\b|\bwallet\b|\bassets\b|\bportfolio\b|\bto\b|\baddress\b)/i.test(
      text
    );

  if (englishHints || (latinChars > 0 && cyrillicChars === 0)) {
    return "en";
  }

  return "ru";
}

function summarizeIntentForLanguage(intent: AgentIntent, _language: "ru" | "en") {
  return summarizeIntent(intent);
}

function localizeExecutionSummary(summary: string | undefined, language: "ru" | "en") {
  if (!summary) {
    return summary;
  }

  return summary;
}

function buildIntentUnderstandingLine(intent: AgentIntent) {
  switch (intent.action) {
    case "send":
      return `I understood this as a transfer request for ${intent.amount ?? "?"} ${intent.fromToken ?? "TON"}${intent.recipient ? ` to ${intent.recipient}` : ""}.`;
    case "swap":
      return `I understood this as a swap request from ${intent.fromToken ?? "TON"} to ${intent.toToken ?? "USDT"} for ${intent.amount ?? "?"} ${intent.fromToken ?? "TON"}.`;
    case "sell":
      return `I understood this as a sell request for ${intent.amount ?? "?"} ${intent.fromToken ?? "TON"}.`;
    case "buy":
      return `I understood this as a buy request for ${intent.amount ?? "?"} ${intent.toToken ?? "TON"}.`;
    default:
      return null;
  }
}

function buildExecutionDetailsLine(
  intent: AgentIntent,
  execution?: {
    kind?: string;
    quote?: {
      inputAmount: number;
      outputAmount: number;
      inputSymbol: string;
      outputSymbol: string;
      recommendedGasTon?: number;
      priceImpactPct?: number;
    };
  }
) {
  if (!execution) {
    return null;
  }

  if (intent.action === "send") {
    const parts = [];

    if (intent.recipient) {
      parts.push(`Recipient: ${intent.recipient}.`);
    }

    if (intent.comment) {
      parts.push(`Comment: "${intent.comment}".`);
    }

    return parts.length ? parts.join(" ") : null;
  }

  if (
    execution.quote &&
    (intent.action === "swap" || intent.action === "sell" || intent.action === "buy")
  ) {
    const parts = [
      `Expected output: about ${execution.quote.outputAmount} ${execution.quote.outputSymbol}.`
    ];

    if (execution.quote.recommendedGasTon !== undefined) {
      parts.push(`Estimated gas: about ${execution.quote.recommendedGasTon} TON.`);
    }

    if (execution.quote.priceImpactPct !== undefined) {
      parts.push(`Price impact: about ${execution.quote.priceImpactPct}%.`);
    }

    return parts.join(" ");
  }

  return null;
}

function buildNextStepLine(
  intent: AgentIntent,
  execution?: { status: string; kind?: string }
) {
  if (!execution) {
    return "Next step: I can refine the request and prepare the action details.";
  }

  if (execution.status === "needs_wallet") {
    return "Next step: connect your TON wallet and I will prepare the transaction details.";
  }

  if (execution.status === "ready") {
    if (intent.action === "send") {
      return "Next step: review the recipient, amount, and comment, then confirm the transfer in your wallet.";
    }

    return "Next step: review the route and expected output, then confirm the transaction in your wallet.";
  }

  return "Next step: fix the missing details and I will try again.";
}

function buildRiskLine(intent: AgentIntent, execution?: { status: string }) {
  if (!execution || execution.status === "unsupported") {
    return null;
  }

  if (intent.action === "send") {
    return "Check the destination address carefully before signing.";
  }

  if (intent.action === "swap" || intent.action === "sell" || intent.action === "buy") {
    return "Check the token pair, expected output, and wallet confirmation details before signing.";
  }

  return null;
}

function buildAgenticExecutionText(
  intent: AgentIntent,
  execution: {
    summary?: string;
    status: string;
    kind?: string;
    quote?: {
      inputAmount: number;
      outputAmount: number;
      inputSymbol: string;
      outputSymbol: string;
      recommendedGasTon?: number;
      priceImpactPct?: number;
    };
  }
) {
  const parts = [
    buildIntentUnderstandingLine(intent),
    execution.summary,
    buildExecutionDetailsLine(intent, execution),
    buildNextStepLine(intent, execution),
    buildRiskLine(intent, execution)
  ].filter((part): part is string => Boolean(part));

  return parts.join("\n\n");
}

function summarizeIntent(intent: AgentIntent) {
  switch (intent.action) {
    case "username_price":
      return intent.query
        ? `I can check the Fragment price for @${intent.query}.`
        : "I can check a Telegram username price on Fragment.";
    case "fee_estimate":
      return "I can estimate the network fee and explain what affects it.";
    case "token_research":
      return `I can review the token${intent.query ? ` ${intent.query}` : ""} and summarize the main signals.`;
    case "address_check":
      return `I can review the address${intent.recipient ? ` ${intent.recipient}` : ""} and summarize visible risk signals.`;
    case "contract_explain":
      return "I can explain the contract in plain English.";
    case "balance":
      return "I can check the connected TON wallet balance.";
    case "transactions":
      return "I can show the most recent transactions for the connected TON wallet.";
    case "nft":
      return "I can show which NFTs are in the connected TON wallet.";
    case "swap":
      return `Swap request: ${intent.amount ?? "?"} ${intent.fromToken ?? "TON"} to ${intent.toToken ?? "USDT"}.`;
    case "sell":
      return `Sell request: ${intent.amount ?? "?"} ${intent.fromToken ?? "TON"}.`;
    case "buy":
      return `Buy request: ${intent.amount ?? "?"} ${intent.toToken ?? "TON"}.`;
    case "send":
      return `Transfer request: ${intent.amount ?? "?"} ${intent.fromToken ?? "TON"} to ${intent.recipient ?? "the recipient"}.`;
    default:
      return "I can help with wallet balance, NFTs, transfers, swaps, token checks, address checks, and username lookups.";
  }
}

function isGreetingMessage(input: string) {
  const lower = normalizeUserText(input).toLowerCase();
  return [
    "привет",
    "здравствуй",
    "здравствуйте",
    "хай",
    "hello",
    "hi",
    "hey"
  ].some((prefix) => lower === prefix || lower.startsWith(`${prefix} `));
}

function isCapabilitiesQuestion(input: string) {
  const lower = normalizeUserText(input).toLowerCase();
  return (
    lower.includes("что ты умеешь") ||
    lower.includes("что умеешь") ||
    lower.includes("чем поможешь") ||
    lower.includes("помоги") ||
    lower.includes("help") ||
    lower.includes("what can you do")
  );
}

function shouldUseAiIntentParsing(
  _input: string,
  _heuristicIntent: AgentIntent,
  _history: z.infer<typeof historyItemSchema>[]
) {
  return Boolean(process.env.OPENAI_API_KEY);
}

function shouldGenerateClarificationWithAi(
  input: string,
  intent: AgentIntent
) {
  if (!process.env.OPENAI_API_KEY) {
    return false;
  }

  if (intent.action !== "unknown") {
    return false;
  }

  const normalized = normalizeUserText(input);
  return normalized.length <= 160;
}

function shouldUseAiReply(intent: AgentIntent, message: string) {
  if (!process.env.OPENAI_API_KEY) {
    return false;
  }

  if (intent.action !== "unknown") {
    return false;
  }

  const lower = normalizeUserText(message).toLowerCase();

  return (
    lower.includes("объясни") ||
    lower.includes("помоги") ||
    lower.includes("что ты умеешь") ||
    lower.includes("что умеешь") ||
    lower.includes("help") ||
    lower.includes("what can you do") ||
    lower.includes("explain")
  );
}

function isActionLikeIntent(intent: AgentIntent) {
  return intent.action !== "unknown";
}

function shouldUseDirectBrainReply(
  message: string,
  history: z.infer<typeof historyItemSchema>[],
  heuristicIntent: AgentIntent
) {
  if (!process.env.OPENAI_API_KEY) {
    return false;
  }

  if (isActionLikeIntent(heuristicIntent)) {
    return false;
  }

  const normalized = normalizeUserText(message);

  if (isGreetingMessage(normalized) || isCapabilitiesQuestion(normalized)) {
    return false;
  }

  if (normalized.length <= 400) {
    return true;
  }

  return history.length > 0 && normalized.length <= 800;
}

function getSmallTalkReply(message: string, language: "ru" | "en") {
  const lower = normalizeUserText(message).toLowerCase();

  if (lower.includes("как дела")) {
    return "All good. Ready to help with TON wallet actions and regular questions.";
  }

  if (lower.includes("кто ты") || lower.includes("ты кто")) {
    return "I am TON AI, the assistant inside this mini app.";
  }

  if (lower.includes("спасибо") || lower.includes("thank")) {
    return "You're welcome.";
  }

  return null;
}

function getUtilityReply(message: string, language: "ru" | "en") {
  const lower = normalizeUserText(message).toLowerCase();
  const asksForFee =
    lower.includes("комис") ||
    lower.includes("fee") ||
    lower.includes("gas");
  const mentionsTransfer =
    lower.includes("отправ") ||
    lower.includes("перевед") ||
    lower.includes("send");

  if (asksForFee && mentionsTransfer) {
    return "For a regular TON transfer, the network fee is usually a small fraction of TON, not 3 TON. The exact amount depends on the wallet route and payload, and the final fee will be shown in the wallet before confirmation.";
  }

  return null;
}

function extractAddressLikeValue(text: string) {
  const match = text.match(
    /\b(UQ[A-Za-z0-9_-]{30,}|EQ[A-Za-z0-9_-]{30,}|0:[A-Fa-f0-9]{64}|[a-zA-Z0-9-]{1,126}\.ton)\b/
  );

  return match?.[1]?.trim();
}

function extractResearchSubject(text: string) {
  const address = extractAddressLikeValue(text);

  if (address) {
    return address;
  }

  const explicitTokenMatch = text.match(
    /\btoken\b[\s:]+([A-Z]{2,12}|[a-z]{2,12})\b/i
  );

  if (explicitTokenMatch?.[1]) {
    return explicitTokenMatch[1].toUpperCase();
  }

  const words = text.match(/\b([A-Z]{2,12}|[a-z]{2,12})\b/g) ?? [];
  const filtered = words.filter((word) => {
    const lower = word.toLowerCase();
    return ![
      "what",
      "is",
      "this",
      "token",
      "the",
      "a",
      "an",
      "price",
      "chart",
      "should",
      "buy",
      "compare"
    ].includes(lower);
  });

  return filtered.at(-1)?.toUpperCase();
}

export function parseIntentHeuristic(input: string): AgentIntent {
  const text = normalizeUserText(input);
  const lower = text.toLowerCase();
  const tokenMatch = text.match(amountTokenPattern);
  const amount = normalizeAmount(tokenMatch?.[1]);
  const primaryToken = normalizeToken(tokenMatch?.[2]);
  const asksForBalance =
    lower.includes("баланс") ||
    lower.includes("сколь") ||
    lower.includes("сколько у меня") ||
    lower.includes("сколько у меня токен") ||
    lower.includes("сколько у меня тон") ||
    lower.includes("сколько монет") ||
    lower.includes("мой кошелек") ||
    lower.includes("мой кошелёк") ||
    lower.includes("моем кошельке") ||
    lower.includes("моём кошельке") ||
    lower.includes("на кошельке") ||
    lower.includes("в кошельке") ||
    lower.includes("какие токены") ||
    lower.includes("все токены") ||
    lower.includes("все мои токены") ||
    lower.includes("мои токены") ||
    lower.includes("покажи токены") ||
    lower.includes("покажи все токены") ||
    lower.includes("какие монеты") ||
    lower.includes("какие активы") ||
    lower.includes("активы в кошельке") ||
    lower.includes("что лежит на моем кошельке") ||
    lower.includes("что лежит на моём кошельке") ||
    lower.includes("что лежит в кошельке") ||
    lower.includes("что у меня на кошельке") ||
    lower.includes("balance") ||
    lower.includes("wallet balance") ||
    lower.includes("show my balance") ||
    lower.includes("show all tokens in my wallet") ||
    lower.includes("show all tokens in the wallet") ||
    lower.includes("show tokens in my wallet") ||
    lower.includes("show tokens in the wallet") ||
    lower.includes("all tokens in my wallet") ||
    lower.includes("all tokens in the wallet") ||
    lower.includes("tokens in my wallet") ||
    lower.includes("tokens in the wallet") ||
    lower.includes("what tokens are in my wallet") ||
    lower.includes("what assets are in my wallet") ||
    lower.includes("what is in my wallet") ||
    lower.includes("how much ton is in my wallet") ||
    lower.includes("how much ton do i have") ||
    lower.includes("how much is in my wallet") ||
    lower.includes("how much ton is in the wallet") ||
    lower.includes("how much is in the wallet") ||
    lower.includes("how much ton is on my wallet") ||
    lower.includes("how much ton is on the wallet") ||
    lower.includes("my balance") ||
    lower.includes("how much do i have") ||
    lower.includes("how many tokens") ||
    lower.includes("show my tokens") ||
    lower.includes("show my assets") ||
    lower.includes("my assets") ||
    lower.includes("my tokens") ||
    lower.includes("portfolio") ||
    lower.includes("holdings");
  const asksForTransactions =
    lower.includes("recent transactions") ||
    lower.includes("latest transactions") ||
    lower.includes("show transactions") ||
    lower.includes("show my transactions") ||
    lower.includes("transaction history") ||
    lower.includes("wallet activity") ||
    lower.includes("recent activity") ||
    lower.includes("last transactions") ||
    lower.includes("transfers history") ||
    lower.includes("истори") && lower.includes("транзак") ||
    lower.includes("последние транзак") ||
    lower.includes("мои транзак") ||
    lower.includes("операции по кошельку") ||
    lower.includes("история кошелька");
  const asksForNfts =
    lower.includes(" nft") ||
    lower.startsWith("nft") ||
    lower.includes("nfts") ||
    lower.includes("нфт") ||
    lower.includes("collectible") ||
    lower.includes("collectibles") ||
    lower.includes("какие nft") ||
    lower.includes("какие нфт") ||
    lower.includes("мои nft") ||
    lower.includes("мои нфт") ||
    lower.includes("nft в кошельке") ||
    lower.includes("nft на кошельке") ||
    lower.includes("my nft") ||
    lower.includes("my nfts");
  const asksForFeeEstimate =
    (lower.includes("fee") || lower.includes("gas") || lower.includes("комис")) &&
    (lower.includes("send") ||
      lower.includes("sending") ||
      lower.includes("transfer") ||
      lower.includes("отправ") ||
      lower.includes("перевед"));
  const asksForTokenResearch =
    lower.includes("what is this token") ||
    lower.includes("check this token") ||
    lower.includes("check token") ||
    lower.includes("is this token a scam") ||
    lower.includes("locked liquidity") ||
    lower.includes("market cap") ||
    lower.includes("should i buy") ||
    lower.includes("token price") ||
    lower.includes("price chart") ||
    lower.includes("compare this token") ||
    lower.includes("what token is this") ||
    lower.includes("проверь этот токен") ||
    lower.includes("что это за токен") ||
    lower.includes("капитализа") ||
    lower.includes("ликвид") ||
    lower.includes("скам");
  const asksForAddressCheck =
    lower.includes("owner of this address") ||
    lower.includes("owner of the address") ||
    lower.includes("is this address") ||
    lower.includes("safe to send") ||
    lower.includes("safe to send money") ||
    lower.includes("address seen in scams") ||
    lower.includes("владелец этого адреса") ||
    lower.includes("безопасно ли отправлять") ||
    lower.includes("адрес замечен в скамах");
  const asksForContractExplain =
    lower.includes("explain this smart contract") ||
    lower.includes("what does this smart contract do") ||
    lower.includes("what does this contract do") ||
    lower.includes("explain this contract") ||
    lower.includes("объясни") && lower.includes("смарт-контракт");

  if (
    lower.includes("сколько стоит") ||
    lower.includes("how much does a telegram username cost") ||
    lower.includes("how much does username cost") ||
    lower.includes("how much does a username cost") ||
    lower.includes("how much does username") ||
    lower.includes("how much does a telegram username") ||
    lower.includes("telegram username cost") ||
    lower.includes("price of username") ||
    lower.includes("price of @") ||
    lower.includes("username price") ||
    lower.includes("цена username") ||
    lower.includes("цена юзернейма") ||
    lower.includes("сколько стоит username") ||
    lower.includes("сколько стоит юзернейм")
  ) {
    const usernameMatch =
      text.match(/@([a-zA-Z0-9_]{4,32})/) ??
      text.match(
        /\b(?:username|telegram username|юзернейм|ник)\b[\s:]+@?([a-zA-Z0-9_]{4,32})/i
      ) ??
      text.match(
        /\b(?:how much does|price of)\s+(?:username\s+|telegram username\s+)?@?([a-zA-Z0-9_]{4,32})\b/i
      );
    const usernameCandidate = usernameMatch?.[1]?.toLowerCase();
    const query =
      usernameCandidate &&
      !["cost", "price", "username", "telegram", "name"].includes(usernameCandidate)
        ? usernameCandidate
        : undefined;

    return finalizeIntent({
      ...createBaseIntent("username_price"),
      query
    });
  }

  if (asksForFeeEstimate) {
    const commentMatch =
      text.match(/(?:with\s+comment|comment)\s+(.+)$/i) ??
      text.match(/(?:с\s+комментарием|комментарием|комментарий)\s+(.+)$/i);
    return finalizeIntent({
      ...createBaseIntent("fee_estimate"),
      amount,
      fromToken: primaryToken ?? "TON",
      recipient: extractRecipientCandidate(text),
      comment: commentMatch?.[1]?.trim()
    });
  }

  if (asksForBalance) {
    return finalizeIntent(createBaseIntent("balance"));
  }

  if (asksForTransactions) {
    return finalizeIntent(createBaseIntent("transactions"));
  }

  if (asksForNfts) {
    return finalizeIntent(createBaseIntent("nft"));
  }

  if (asksForAddressCheck) {
    return finalizeIntent({
      ...createBaseIntent("address_check"),
      recipient: extractAddressLikeValue(text),
      query: extractAddressLikeValue(text)
    });
  }

  if (asksForContractExplain) {
    return finalizeIntent({
      ...createBaseIntent("contract_explain"),
      recipient: extractAddressLikeValue(text),
      query: extractAddressLikeValue(text)
    });
  }

  if (asksForTokenResearch) {
    return finalizeIntent({
      ...createBaseIntent("token_research"),
      query: extractResearchSubject(text)
    });
  }

  if (
    lower.includes("swap") ||
    lower.includes("convert") ||
    lower.includes("exchange") ||
    lower.includes("свап") ||
    lower.includes("обмен")
  ) {
    const pair = text.match(/(?:to|for|в|на)\s+([a-zA-Zа-яА-ЯёЁ$]{2,12})/i);
    const toToken = normalizeToken(pair?.[1]) ?? (primaryToken === "TON" ? "USDT" : "TON");
    return finalizeIntent({
      ...createBaseIntent("swap"),
      amount,
      fromToken: primaryToken ?? "TON",
      toToken
    });
  }

  if (lower.includes("sell") || lower.includes("продай") || lower.includes("продать")) {
    return finalizeIntent({
      ...createBaseIntent("sell"),
      amount,
      fromToken: primaryToken ?? "TON",
      toToken: "USDT"
    });
  }

  if (
    lower.includes("send") ||
    lower.includes("transfer") ||
    lower.includes("отправь") ||
    lower.includes("переведи")
  ) {
    const commentMatch =
      text.match(/(?:с\s+комментарием|комментарием|комментарий|comment)\s+(.+)$/i) ??
      text.match(/(?:и\s+напиши|и\s+добавь)\s+(.+)$/i);
    return finalizeIntent({
      ...createBaseIntent("send"),
      amount,
      fromToken: primaryToken ?? "TON",
      recipient: extractRecipient(text),
      comment: commentMatch?.[1]?.trim()
    });
  }

  if (lower.includes("buy") || lower.includes("купи") || lower.includes("купить")) {
    const target = text.match(
      /(?:buy|купи|купить)\s+(\d+(?:[.,]\d+)?)\s+([a-zA-Zа-яА-ЯёЁ$]{2,12})/i
    );
    return finalizeIntent({
      ...createBaseIntent("buy"),
      amount: normalizeAmount(target?.[1]) ?? amount,
      fromToken: "TON",
      toToken: normalizeToken(target?.[2]) ?? primaryToken ?? "TON"
    });
  }

  return finalizeIntent(createBaseIntent("unknown"));
}

async function parseIntentWithOpenAI(
  input: string,
  history: z.infer<typeof historyItemSchema>[] = [],
  conversationState = deriveConversationState(history)
) {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return null;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 2500);

  try {
    let response: Response;

    try {
      response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: process.env.OPENAI_FAST_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-5-mini",
          input: [
            {
              role: "system",
              content: [
                {
                  type: "input_text",
                  text:
                    "Извлеки намерение пользователя из диалога про TON на любом языке. Верни только JSON без markdown. " +
                    "Схема: {action, amount?, fromToken?, toToken?, recipient?, comment?}. " +
                    "action одно из swap, sell, buy, send, balance, transactions, nft, username_price, unknown. " +
                    "Сначала пойми, что пользователь реально хочет сделать, даже если он пишет криво, с ошибками, коротко, неформально или смешивает языки. " +
                    "Если смысл запроса близок к поддерживаемой возможности, выбери ближайший подходящий action, а не unknown. " +
                    "unknown используй только если запрос действительно не относится к поддерживаемым возможностям assistant. " +
                    "Понимай свободные формулировки и смешение языков: продай, обменяй, перекинь, отправь, закинь, купи, хочу поменять, нужно перевести, show my balance, send, swap, sell, buy. " +
                    "Для вопросов о балансе, количестве токенов в кошельке или 'сколько у меня' используй action=balance. " +
                    "Для запросов вроде 'show my balance', 'my assets', 'show my tokens', 'wallet balance', 'portfolio' тоже используй action=balance. " +
                    "Для запросов про NFT в кошельке, коллекции NFT, 'какие у меня NFT', 'show my nfts' используй action=nft. " +
                    "Для вопросов о цене telegram username на Fragment используй action=username_price и положи username в query. " +
                    "Если пользователь спрашивает не про исполнение, а про объяснение, комиссии, безопасность, риски, help, guidance или общую информацию, не превращай это в send/swap/buy/sell. Для таких вопросов используй action=unknown. " +
                    "Например вопрос вроде `What is the network fee for sending 3 TON?` это informational request, а не send. " +
                    "Если новое сообщение является продолжением предыдущего вопроса, опирайся на историю диалога. " +
                    "Например после вопроса о цене username фраза `А guitars?` тоже означает запрос цены username guitars. " +
                    "Используй conversationState как краткую память о предыдущих сущностях и действии. " +
                    "Если пользователь пишет коротко: `а другой?`, `а этот?`, `ему`, `ей`, `туда`, нужно достраивать смысл из conversationState и history. " +
                    "Если в сообщении есть основное действие перевода или swap, а внутри желаемого комментария встречаются слова вроде `купить`, `продать`, `обменять`, не путай comment с основным action. " +
                    "Главное намерение пользователя важнее слов, которые он просит вставить в комментарий к переводу. " +
                    "Исправляй опечатки, достраивай очевидный смысл и понимай короткие, неполные и разговорные фразы. " +
                    "Нормализуй токены в uppercase ticker: TON, USDT, USDC, BTC, ETH. Для неизвестных токенов тоже uppercase. " +
                    "recipient сохраняй как TON address или *.ton домен. " +
                    "query используй для username или других внешних lookup-запросов. " +
                    "comment извлекай из фраз вроде 'с комментарием', 'комментарий', 'comment'. " +
                    "Если пользователь просит придумать комментарий, поздравление или дружелюбный текст для перевода, сгенерируй короткий уместный comment на русском языке. " +
                    "Если данных не хватает, не выдумывай поля."
                }
              ]
            },
            {
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: JSON.stringify({
                    conversationState,
                    history,
                    message: input
                  })
                }
              ]
            }
          ]
        }),
        signal: controller.signal
      });
    } catch {
      return null;
    }

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as {
      output_text?: string;
    };

    if (!data.output_text) {
      return null;
    }

    try {
      const parsed = JSON.parse(stripCodeFences(data.output_text));
      return parsedIntentSchema.parse(parsed);
    } catch {
      return null;
    }
  } finally {
    clearTimeout(timeoutId);
  }
}

async function generateTransferComment(input: string) {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return null;
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL ?? "gpt-5-mini",
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text:
                "Пользователь готовит перевод в TON и просит придумать комментарий. " +
                "Верни только одну короткую дружелюбную фразу на русском языке без кавычек и без пояснений. " +
                "Максимум 90 символов."
            }
          ]
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: input
            }
          ]
        }
      ]
    })
  });

  if (!response.ok) {
    return null;
  }

  const data = (await response.json()) as {
    output_text?: string;
  };

  const text = data.output_text?.trim();
  return text ? stripCodeFences(text).slice(0, 90) : null;
}

async function generateClarificationQuestion({
  message,
  history,
  conversationState
}: {
  message: string;
  history: z.infer<typeof historyItemSchema>[];
  conversationState: z.infer<typeof conversationStateSchema>;
}) {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return null;
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL ?? "gpt-5-mini",
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text:
                "Ты анализируешь неоднозначный пользовательский запрос в TON assistant. " +
                "Если можно задать один короткий уточняющий вопрос на русском языке, верни только этот вопрос без пояснений. " +
                "Если уточнение не нужно или не поможет, верни строго NO_QUESTION."
            }
          ]
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: JSON.stringify({
                message,
                history,
                conversationState
              })
            }
          ]
        }
      ]
    })
  });

  if (!response.ok) {
    return null;
  }

  const data = (await response.json()) as {
    output_text?: string;
  };

  const text = data.output_text?.trim();

  if (!text || text === "NO_QUESTION") {
    return null;
  }

  return stripCodeFences(text);
}

function mergeIntents(primary: AgentIntent, secondary?: AgentIntent | null) {
  if (!secondary || secondary.action === "unknown") {
    return primary;
  }

  return finalizeIntent({
    ...secondary,
    amount: secondary.amount ?? primary.amount,
    fromToken: secondary.fromToken ?? primary.fromToken,
    toToken: secondary.toToken ?? primary.toToken,
    recipient: secondary.recipient ?? primary.recipient,
    query: secondary.query ?? primary.query,
    comment: secondary.comment ?? primary.comment
  });
}

function applyConversationContext(
  intent: AgentIntent,
  input: string,
  conversationState: z.infer<typeof conversationStateSchema>
) {
  const lower = input.toLowerCase();
  const hasSendVerb =
    lower.includes("переведи") ||
    lower.includes("отправь") ||
    lower.includes("send");

  if (
    intent.action === "unknown" &&
    conversationState.lastAction === "username_price"
  ) {
    const username = extractLooseUsername(input);
    if (username) {
      return finalizeIntent({
        ...createBaseIntent("username_price"),
        query: username
      });
    }
  }

  if (intent.action === "username_price" && !intent.query) {
    intent.query = conversationState.lastUsernameQuery;
  }

  if (
    intent.action === "send" &&
    !intent.recipient &&
    (lower.includes("ему") ||
      lower.includes("ей") ||
      lower.includes("туда") ||
      lower.includes("этому") ||
      lower.includes("получателю"))
  ) {
    intent.recipient = conversationState.lastRecipient;
  }

  if (
    intent.action === "unknown" &&
    conversationState.lastAction === "send"
  ) {
    const continuationRecipient = extractRecipientCandidate(input);
    const continuationAmountMatch = input.match(amountTokenPattern);
    const continuationAmount = normalizeAmount(continuationAmountMatch?.[1]);
    const continuationToken = normalizeToken(continuationAmountMatch?.[2]);

    if (continuationRecipient || continuationAmount) {
      return finalizeIntent({
        ...createBaseIntent("send"),
        amount: continuationAmount,
        fromToken: continuationToken ?? conversationState.lastFromToken ?? "TON",
        recipient: continuationRecipient ?? conversationState.lastRecipient,
        comment: conversationState.lastComment
      });
    }
  }

  if (intent.action === "buy" && hasSendVerb) {
    intent.action = "send";
    intent.needsWallet = true;
    intent.needsConfirmation = true;
    intent.protocol = undefined;
    if (!intent.recipient) {
      intent.recipient = extractRecipientCandidate(input) ?? conversationState.lastRecipient;
    }
  }

  if ((intent.action === "swap" || intent.action === "sell" || intent.action === "buy") && !intent.fromToken) {
    intent.fromToken = conversationState.lastFromToken;
  }

  if ((intent.action === "swap" || intent.action === "buy") && !intent.toToken) {
    intent.toToken = conversationState.lastToToken;
  }

  intent.summary = summarizeIntent(intent);
  return intent;
}

function toIntentFromParsed(parsed: z.infer<typeof parsedIntentSchema>): AgentIntent {
  const base = createBaseIntent(parsed.action);
  return finalizeIntent({
    ...base,
    amount: parsed.amount,
    fromToken: normalizeToken(parsed.fromToken),
    toToken: normalizeToken(parsed.toToken),
    recipient: normalizeRecipient(parsed.recipient),
    query: parsed.query?.trim(),
    comment: parsed.comment?.trim()
  });
}

function toUnderstandingFromParsed(
  parsed: z.infer<typeof parsedIntentSchema> | null,
  fallbackIntent: AgentIntent
): UnderstandingData | undefined {
  const normalizedRequest = parsed?.normalizedRequest?.trim() || fallbackIntent.summary.trim();

  if (!normalizedRequest) {
    return undefined;
  }

  return {
    normalizedRequest,
    confidence: parsed?.confidence
  };
}

function pickResolvedIntent({
  heuristicIntent,
  aiIntent,
  aiParsed
}: {
  heuristicIntent: AgentIntent;
  aiIntent: AgentIntent | null;
  aiParsed: z.infer<typeof parsedIntentSchema> | null;
}) {
  if (!aiIntent || !aiParsed) {
    return heuristicIntent;
  }

  if (aiParsed.confidence === "high" || aiParsed.confidence === "medium") {
    return aiIntent;
  }

  if (aiIntent.action !== "unknown") {
    return aiIntent;
  }

  return heuristicIntent;
}

export async function parseIntent(
  input: string,
  history: z.infer<typeof historyItemSchema>[] = []
): Promise<{ intent: AgentIntent; understanding?: UnderstandingData }> {
  const normalizedInput = normalizeUserText(input);
  const conversationState = deriveConversationState(history);
  const heuristicIntent = applyConversationContext(
    parseIntentHeuristic(normalizedInput),
    normalizedInput,
    conversationState
  );
  const aiParsed = shouldUseAiIntentParsing(normalizedInput, heuristicIntent, history)
    ? await parseIntentWithOpenAI(
        normalizedInput,
        history,
        conversationState
      )
    : null;
  const aiIntent = aiParsed ? toIntentFromParsed(aiParsed) : null;
  const contextualAiIntent = aiIntent
    ? applyConversationContext(aiIntent, normalizedInput, conversationState)
    : null;
  const resolvedIntent = pickResolvedIntent({
    heuristicIntent,
    aiIntent: contextualAiIntent,
    aiParsed
  });

  if (
    resolvedIntent.action === "send" &&
    !resolvedIntent.comment &&
    needsGeneratedComment(normalizedInput)
  ) {
    const generatedComment = await generateTransferComment(normalizedInput);
    if (generatedComment) {
      resolvedIntent.comment = generatedComment;
      resolvedIntent.summary = summarizeIntent(resolvedIntent);
    }
  }

  return {
    intent: resolvedIntent,
    understanding: toUnderstandingFromParsed(aiParsed, resolvedIntent)
  };
}

async function completeWithOpenAI({
  message,
  intent,
  executionSummary,
  walletAddress,
  walletConnected,
  history,
  language
}: {
  message: string;
  intent: AgentIntent;
  executionSummary?: string;
  walletAddress?: string;
  walletConnected?: boolean;
  history?: z.infer<typeof historyItemSchema>[];
  language: "ru" | "en";
}) {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return null;
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL ?? "gpt-5-mini",
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text:
                "You are TON AI assistant. Reply briefly in the same language as the user's last message. " +
                "If the user wrote in English, reply in English. If the user wrote in Russian, reply in Russian. " +
                "If the request is about swap/sell/buy/send, do not promise execution without confirmation. Use intent and wallet status."
            }
          ]
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: JSON.stringify({
                conversationState: deriveConversationState(history ?? []),
                history,
                message,
                intent,
                executionSummary,
                walletAddress,
                walletConnected
              })
            }
          ]
        }
      ]
    })
  });

  if (!response.ok) {
    return null;
  }

  const data = (await response.json()) as {
    output_text?: string;
  };

  return data.output_text ?? null;
}

async function directBrainReplyWithOpenAI({
  message,
  history,
  walletAddress,
  walletConnected,
  language
}: {
  message: string;
  history?: z.infer<typeof historyItemSchema>[];
  walletAddress?: string;
  walletConnected?: boolean;
  language: "ru" | "en";
}) {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return null;
  }

  const recentHistory = (history ?? []).slice(-4).map((item) => ({
    role: item.role,
    text: item.text
  }));

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 2500);

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: process.env.OPENAI_FAST_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-5-mini",
        input: [
          {
            role: "system",
            content: [
              {
                type: "input_text",
                text:
                  language === "en"
                    ? "You are TON AI. You are the main conversational brain of the app. Reply briefly and clearly. If the message is ordinary chat, answer directly. If the user is asking for a wallet action, say you can prepare balance, transfer, swap, buy, or sell flows after they specify details. Avoid long answers."
                    : "You are TON AI. You are the main conversational brain of the app. Reply briefly and clearly. If the message is ordinary chat, answer directly. If the user is asking for a wallet action, say you can prepare balance, transfer, swap, buy, or sell flows after they specify details. Avoid long answers."
              }
            ]
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: JSON.stringify({
                  walletAddress,
                  walletConnected,
                  history: recentHistory,
                  message
                })
              }
            ]
          }
        ]
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as {
      output_text?: string;
    };

    return data.output_text ? stripCodeFences(data.output_text).trim() : null;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function answerSpecialIntentWithOpenAI({
  message,
  intent,
  walletAddress,
  context
}: {
  message: string;
  intent: AgentIntent;
  walletAddress?: string;
  context?: unknown;
}) {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return null;
  }

  const systemPromptByAction: Record<
    "fee_estimate" | "token_research" | "address_check" | "contract_explain",
    string
  > = {
    fee_estimate:
      "You are TON AI. The user is asking for an informational fee estimate, not transaction execution. " +
      "Reply in concise English. Explain that the fee is usually small relative to the transfer amount, " +
      "mention the main factors that affect it, and say the final fee is shown in the wallet before confirmation. " +
      "If the user included an amount, mention it directly.",
    token_research:
      "You are TON AI. The user is asking for token research. Reply in concise English with a practical builder-style answer. " +
      "Use the supplied structured facts if they exist. If there is not enough token context, ask for the token symbol or address. " +
      "If the token is ambiguous, say what you need next. Do not present financial advice as certainty. Do not invent liquidity, market cap, or scam verdicts.",
    address_check:
      "You are TON AI. The user is asking for an address risk check. Reply in concise English. " +
      "Use the supplied structured facts if they exist. If no address is provided, ask for the wallet address or TON DNS name. " +
      "If there is not enough data to verify scam status on-chain, say that clearly and tell the user what evidence to inspect next. Do not claim certainty from weak signals.",
    contract_explain:
      "You are TON AI. The user wants a plain-English explanation of a smart contract. Reply in concise English. " +
      "If no contract address or code reference is provided, ask for it. " +
      "Keep the explanation simple and user-facing."
  };

  if (
    intent.action !== "fee_estimate" &&
    intent.action !== "token_research" &&
    intent.action !== "address_check" &&
    intent.action !== "contract_explain"
  ) {
    return null;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 3000);

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL ?? "gpt-5-mini",
        input: [
          {
            role: "system",
            content: [
              {
                type: "input_text",
                text: systemPromptByAction[intent.action]
              }
            ]
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: JSON.stringify({
                  message,
                  walletAddress,
                  intent,
                  context
                })
              }
            ]
          }
        ]
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as {
      output_text?: string;
    };

    return data.output_text ? stripCodeFences(data.output_text).trim() : null;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function getWalletBalance(walletAddress?: string) {
  if (!walletAddress) {
    return null;
  }

  const walletMcpPortfolio = await getWalletPortfolioViaMcp(walletAddress).catch(() => null);

  if (walletMcpPortfolio?.tonBalance) {
    return walletMcpPortfolio.tonBalance;
  }

  const endpoint =
    process.env.TON_API_ENDPOINT ?? "https://toncenter.com/api/v2/jsonRPC";
  const apiKey = process.env.TON_API_KEY;
  const nanotonsPerTon = 1_000_000_000;

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
        address: walletAddress
      }
    }),
    cache: "no-store"
  });

  if (!response.ok) {
    return null;
  }

  const payload = (await response.json()) as {
    result?: string;
  };

  if (!payload.result) {
    return null;
  }

  return (Number(payload.result) / nanotonsPerTon).toFixed(2);
}

async function getWalletJettons(walletAddress?: string) {
  if (!walletAddress) {
    return [];
  }

  const walletMcpPortfolio = await getWalletPortfolioViaMcp(walletAddress).catch(() => null);

  if (walletMcpPortfolio?.jettons.length) {
    return walletMcpPortfolio.jettons;
  }

  const endpoint =
    process.env.TON_API_V3_JETTON_WALLETS_ENDPOINT ??
    "https://toncenter.com/api/v3/jetton/wallets";
  const apiKey = process.env.TON_API_KEY;
  const url = new URL(endpoint);
  url.searchParams.set("owner_address", walletAddress);
  url.searchParams.set("exclude_zero_balance", "true");
  url.searchParams.set("limit", "10");

  const response = await fetch(url, {
    headers: apiKey ? { "X-API-Key": apiKey } : undefined,
    cache: "no-store"
  });

  if (!response.ok) {
    return [];
  }

  const payload = (await response.json()) as {
    jetton_wallets?: Array<{
      balance?: string;
      jetton?: string;
    }>;
    metadata?: Record<string, JettonMetadata>;
  };
  const payloadMetadata = payload.metadata ?? {};

  const missingMetadataAddresses = Array.from(
    new Set(
      (payload.jetton_wallets ?? [])
        .map((wallet) => wallet.jetton)
        .filter(
          (address): address is string => {
            if (!address) {
              return false;
            }

            return !payloadMetadata[address]?.symbol && !payloadMetadata[address]?.name;
          }
        )
    )
  );

  let masterMetadata: Record<string, JettonMetadata> = {};
  let swapCoffeeMetadata: Record<string, JettonMetadata> = {};

  if (missingMetadataAddresses.length) {
    const mastersEndpoint =
      process.env.TON_API_V3_JETTON_MASTERS_ENDPOINT ??
      "https://toncenter.com/api/v3/jetton/masters";
    const mastersUrl = new URL(mastersEndpoint);

    for (const address of missingMetadataAddresses.slice(0, 10)) {
      mastersUrl.searchParams.append("address", address);
    }

    const mastersResponse = await fetch(mastersUrl, {
      headers: apiKey ? { "X-API-Key": apiKey } : undefined,
      cache: "no-store"
    });

    if (mastersResponse.ok) {
      const mastersPayload = (await mastersResponse.json()) as {
        metadata?: Record<string, JettonMetadata>;
      };

      masterMetadata = mastersPayload.metadata ?? {};
    }

    const swapCoffeeResults = await Promise.all(
      missingMetadataAddresses.slice(0, 10).map(async (address) => {
        try {
          return [address, await getSwapCoffeeTokenMetadata(address)] as const;
        } catch {
          return null;
        }
      })
    );

    swapCoffeeMetadata = Object.fromEntries(
      swapCoffeeResults.filter(isDefined)
    );
  }

  const aliasOverrides = getJettonAliasOverrides();

  return (payload.jetton_wallets ?? [])
    .map((wallet) => {
      const normalizedAddress = normalizeJettonAddress(wallet.jetton);
      const metadata = wallet.jetton
        ? payloadMetadata[wallet.jetton] ??
          masterMetadata[wallet.jetton] ??
          swapCoffeeMetadata[wallet.jetton] ??
          (normalizedAddress ? aliasOverrides[normalizedAddress] : undefined)
        : undefined;
      const decimalsRaw = metadata?.decimals;
      const decimals =
        typeof decimalsRaw === "string"
          ? Number(decimalsRaw)
          : typeof decimalsRaw === "number"
            ? decimalsRaw
            : 9;
      const rawBalance = wallet.balance ? Number(wallet.balance) : NaN;

      if (!Number.isFinite(rawBalance) || rawBalance <= 0) {
        return null;
      }

      const divisor = 10 ** Math.min(decimals, 18);
      const balance = rawBalance / divisor;

      return {
        name: metadata?.name ?? metadata?.symbol ?? undefined,
        symbol:
          metadata?.symbol ??
          metadata?.name ??
          (wallet.jetton ? `JETTON ${wallet.jetton.slice(0, 6)}...` : "JETTON"),
        hasReadableMetadata: Boolean(metadata?.symbol || metadata?.name),
        balance: balance >= 1 ? balance.toFixed(4) : balance.toFixed(6),
        numericBalance: balance
      } satisfies WalletJetton;
    })
    .filter(isDefined)
    .sort((a, b) => {
      if (a.hasReadableMetadata !== b.hasReadableMetadata) {
        return a.hasReadableMetadata ? -1 : 1;
      }

      return Number(b.balance) - Number(a.balance);
    });
}

function shortenAddress(value?: string | null) {
  if (!value) {
    return undefined;
  }

  if (value.length <= 14) {
    return value;
  }

  return `${value.slice(0, 6)}...${value.slice(-6)}`;
}

function decodeCommentFromMessage(message: Record<string, unknown> | undefined) {
  if (!message) {
    return null;
  }

  const msgDataText = typeof message.msg_data === "object" && message.msg_data
    ? (message.msg_data as Record<string, unknown>).text
    : undefined;

  if (typeof msgDataText === "string" && msgDataText.trim()) {
    return msgDataText.trim();
  }

  const comment =
    typeof message.message === "string"
      ? message.message
      : typeof message.comment === "string"
        ? message.comment
        : null;

  return comment?.trim() || null;
}

async function getWalletTransactions(walletAddress?: string): Promise<WalletTransaction[]> {
  if (!walletAddress) {
    return [];
  }

  const endpoint =
    process.env.TON_API_ENDPOINT ?? "https://toncenter.com/api/v2/jsonRPC";
  const apiKey = process.env.TON_API_KEY;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { "X-API-Key": apiKey } : {})
    },
    body: JSON.stringify({
      id: 1,
      jsonrpc: "2.0",
      method: "getTransactions",
      params: {
        address: walletAddress,
        limit: 5,
        archival: true
      }
    }),
    cache: "no-store"
  });

  if (!response.ok) {
    return [];
  }

  const payload = (await response.json()) as {
    result?: Array<Record<string, unknown>>;
  };

  const normalizedWallet = walletAddress.toLowerCase();

  return (payload.result ?? []).map((item) => {
    const inMsg =
      item.in_msg && typeof item.in_msg === "object"
        ? item.in_msg as Record<string, unknown>
        : undefined;
    const outMsgs = Array.isArray(item.out_msgs)
      ? item.out_msgs.filter((msg): msg is Record<string, unknown> => Boolean(msg && typeof msg === "object"))
      : [];
    const inSource = typeof inMsg?.source === "string" ? inMsg.source : undefined;
    const inDestination = typeof inMsg?.destination === "string" ? inMsg.destination : undefined;
    const firstOut = outMsgs[0];
    const outDestination =
      typeof firstOut?.destination === "string" ? firstOut.destination : undefined;
    const rawValue =
      typeof inMsg?.value === "string"
        ? inMsg.value
        : typeof firstOut?.value === "string"
          ? firstOut.value
          : undefined;
    const amountTon =
      rawValue && Number.isFinite(Number(rawValue))
        ? (Number(rawValue) / 1_000_000_000).toFixed(3)
        : undefined;
    const hash =
      typeof item.transaction_id === "object" && item.transaction_id
        ? String((item.transaction_id as Record<string, unknown>).hash ?? "")
        : "";
    const timestamp =
      typeof item.utime === "number"
        ? item.utime
        : typeof item.utime === "string"
          ? Number(item.utime)
          : undefined;

    let direction: WalletTransaction["direction"] = "unknown";

    if (inDestination?.toLowerCase() === normalizedWallet) {
      direction = "in";
    } else if (inSource?.toLowerCase() === normalizedWallet || outMsgs.length > 0) {
      direction = "out";
    }

    return {
      hash,
      direction,
      amountTon,
      timestamp: Number.isFinite(timestamp) ? timestamp : undefined,
      from: shortenAddress(inSource),
      to: shortenAddress(outDestination ?? inDestination),
      comment: decodeCommentFromMessage(inMsg) ?? decodeCommentFromMessage(firstOut) ?? undefined
    };
  });
}

async function getWalletNfts(walletAddress?: string): Promise<WalletNft[]> {
  if (!walletAddress) {
    return [];
  }

  const endpoint =
    process.env.TON_API_V3_NFT_ITEMS_ENDPOINT ??
    "https://toncenter.com/api/v3/nft/items";
  const apiKey = process.env.TON_API_KEY;
  const url = new URL(endpoint);
  url.searchParams.set("owner_address", walletAddress);
  url.searchParams.set("limit", "12");

  const response = await fetch(url, {
    headers: apiKey ? { "X-API-Key": apiKey } : undefined,
    cache: "no-store"
  });

  if (!response.ok) {
    return [];
  }

  const payload = (await response.json()) as {
    nft_items?: Array<{
      address?: string;
      index?: string;
      collection_address?: string;
      content?: {
        uri?: string;
      };
      collection?: {
        address?: string;
        collection_content?: {
          uri?: string;
        };
      };
      on_sale?: boolean;
    }>;
    address_book?: Record<
      string,
      {
        user_friendly?: string;
        domain?: string | null;
      }
    >;
  };

  const addressBook = payload.address_book ?? {};
  const collectionNameCache = new Map<string, Promise<string | null>>();

  const normalizeContentUri = (uri?: string) => {
    if (!uri) {
      return null;
    }

    if (uri.startsWith("ipfs://")) {
      return `https://w3s.link/ipfs/${uri.slice("ipfs://".length)}`;
    }

    return uri;
  };

  const getImageUrlFromMetadata = (metadata: Record<string, unknown> | null) => {
    const imageCandidate =
      typeof metadata?.image === "string"
        ? metadata.image
        : typeof metadata?.image_url === "string"
          ? metadata.image_url
          : typeof metadata?.cover_image === "string"
            ? metadata.cover_image
            : null;

    return normalizeContentUri(imageCandidate ?? undefined) ?? undefined;
  };

  const fetchJsonMetadata = async (uri?: string) => {
    const normalizedUri = normalizeContentUri(uri);

    if (!normalizedUri) {
      return null;
    }

    try {
      const metadataResponse = await fetch(normalizedUri, {
        headers: {
          Accept: "application/json"
        },
        cache: "no-store"
      });

      if (!metadataResponse.ok) {
        return null;
      }

      return (await metadataResponse.json()) as Record<string, unknown>;
    } catch {
      return null;
    }
  };

  const getCollectionName = (
    collectionAddress?: string,
    collectionContentUri?: string
  ) => {
    if (!collectionAddress) {
      return Promise.resolve<string | null>(null);
    }

    const cached = collectionNameCache.get(collectionAddress);

    if (cached) {
      return cached;
    }

    const promise = (async () => {
      const fromMetadata = await fetchJsonMetadata(collectionContentUri);
      const metadataName =
        typeof fromMetadata?.name === "string" ? fromMetadata.name.trim() : "";

      if (metadataName) {
        return metadataName;
      }

      const collectionBook = addressBook[collectionAddress];
      return collectionBook?.domain ?? collectionBook?.user_friendly ?? collectionAddress;
    })();

    collectionNameCache.set(collectionAddress, promise);
    return promise;
  };

  const nftItems = await Promise.all(
    (payload.nft_items ?? []).map(async (item) => {
      if (!item.address) {
        return null;
      }

      const collectionAddress = item.collection_address ?? item.collection?.address;
      const nftMetadata = await fetchJsonMetadata(item.content?.uri);
      const nftName =
        typeof nftMetadata?.name === "string" ? nftMetadata.name.trim() : "";
      const collectionName = await getCollectionName(
        collectionAddress,
        item.collection?.collection_content?.uri
      );

      return {
        address: item.address,
        name: nftName || undefined,
        collection: collectionName ?? undefined,
        collectionAddress,
        index: item.index,
        imageUrl: getImageUrlFromMetadata(nftMetadata),
        contentUri: item.content?.uri,
        marketplaceUrl: `https://tonviewer.com/${item.address}`,
        onSale: Boolean(item.on_sale)
      } satisfies WalletNft;
    })
  );

  return nftItems.filter(isDefined);
}

function formatUsdValue(value: number) {
  if (value >= 1000) {
    return value.toFixed(2);
  }

  if (value >= 1) {
    return value.toFixed(3);
  }

  return value.toFixed(4);
}

function formatUnitPrice(value: number) {
  if (value >= 1000) {
    return value.toFixed(2);
  }

  if (value >= 1) {
    return value.toFixed(4);
  }

  if (value >= 0.01) {
    return value.toFixed(6);
  }

  return value.toFixed(8);
}

function estimateTransferFeeTon(intent: AgentIntent) {
  const recipient = intent.recipient?.trim().toLowerCase() ?? "";
  const commentLength = intent.comment?.trim().length ?? 0;
  const hasComment = commentLength > 0;
  const usesTonDns = recipient.endsWith(".ton");

  let estimate = 0.014;

  if (usesTonDns) {
    estimate += 0.002;
  }

  if (hasComment) {
    estimate += 0.003;

    if (commentLength > 40) {
      estimate += 0.002;
    }
  }

  return Number(estimate.toFixed(3));
}

async function getUsdtValueEstimate(
  symbol: string,
  amount: number,
  walletAddress?: string
) {
  if (!Number.isFinite(amount) || amount <= 0) {
    return null;
  }

  if (symbol === "USDT") {
    return amount;
  }

  try {
    const quote = await getSwapCoffeeQuote(symbol, "USDT", amount, walletAddress);
    return quote?.outputAmount ?? null;
  } catch {
    return null;
  }
}

async function getBalanceValuation({
  walletBalance,
  visibleJettons,
  walletAddress
}: {
  walletBalance: string | null;
  visibleJettons: Array<{
    name?: string;
    symbol: string;
    balance: string;
    numericBalance: number;
    hasReadableMetadata: boolean;
  }>;
  walletAddress?: string;
}) {
  const assets = [
    ...(walletBalance
      ? [
          {
            symbol: "TON",
            balance: walletBalance,
            numericBalance: Number(walletBalance)
          }
        ]
      : []),
    ...visibleJettons
      .filter((jetton) => jetton.hasReadableMetadata)
      .map((jetton) => ({
        symbol: jetton.symbol,
        balance: jetton.balance,
        numericBalance: jetton.numericBalance
      }))
  ];

  const valuations = await Promise.all(
    assets.map(async (asset) => ({
      symbol: asset.symbol,
      balance: asset.balance,
      numericBalance: asset.numericBalance,
      usdtValue: await getUsdtValueEstimate(
        asset.symbol,
        asset.numericBalance,
        walletAddress
      )
    }))
  );

  const tonAsset = valuations.find((asset) => asset.symbol === "TON");
  const tonValue = tonAsset?.usdtValue ?? null;
  const tonUnitPrice =
    tonAsset?.usdtValue && tonAsset.numericBalance > 0
      ? tonAsset.usdtValue / tonAsset.numericBalance
      : null;
  const tokenValues = valuations.filter((asset) => asset.symbol !== "TON");
  const totalUsdt = valuations.reduce(
    (sum, asset) => sum + (asset.usdtValue ?? 0),
    0
  );

  return {
    tonValue,
    tonUnitPrice,
    tokenValues,
    totalUsdt: totalUsdt > 0 ? totalUsdt : null
  };
}

function buildPortfolioData({
  walletBalance,
  visibleJettons,
  unknownJettons,
  valuation,
  hiddenJettonsCount
}: {
  walletBalance: string | null;
  visibleJettons: Array<{
    name?: string;
    symbol: string;
    balance: string;
    numericBalance: number;
    hasReadableMetadata: boolean;
  }>;
  unknownJettons: Array<{
    name?: string;
    symbol: string;
    balance: string;
    numericBalance: number;
    hasReadableMetadata: boolean;
  }>;
  valuation: Awaited<ReturnType<typeof getBalanceValuation>>;
  hiddenJettonsCount: number;
}): PortfolioData | undefined {
  if (!walletBalance) {
    return undefined;
  }

  return {
    ton: {
      symbol: "TON",
      amount: walletBalance,
      unitPriceUsdt:
        valuation.tonUnitPrice !== null
          ? formatUnitPrice(valuation.tonUnitPrice)
          : undefined,
      totalValueUsdt:
        valuation.tonValue !== null ? formatUsdValue(valuation.tonValue) : undefined,
      hasReadableMetadata: true
    },
    tokens: visibleJettons.map((jetton) => {
      const tokenValue = valuation.tokenValues.find(
        (item) => item.symbol === jetton.symbol
      )?.usdtValue;
      const unitPrice =
        tokenValue !== null && tokenValue !== undefined && jetton.numericBalance > 0
          ? tokenValue / jetton.numericBalance
          : null;

      return {
        symbol: jetton.symbol,
        name: jetton.name,
        amount: jetton.balance,
        unitPriceUsdt: unitPrice !== null ? formatUnitPrice(unitPrice) : undefined,
        totalValueUsdt:
          tokenValue !== null && tokenValue !== undefined
            ? formatUsdValue(tokenValue)
            : undefined,
        hasReadableMetadata: jetton.hasReadableMetadata
      };
    }),
    unknownTokens: unknownJettons.map((jetton) => ({
      symbol: jetton.symbol,
      name: jetton.name,
      amount: jetton.balance,
      hasReadableMetadata: false
    })),
    totalValueUsdt:
      valuation.totalUsdt !== null ? formatUsdValue(valuation.totalUsdt) : undefined,
    hiddenTokenCount: hiddenJettonsCount > 0 ? hiddenJettonsCount : undefined
  };
}

function buildNftGalleryData(
  nfts: WalletNft[],
  visibleCount: number
): NftGalleryData {
  const visibleItems = nfts.slice(0, visibleCount);
  const hiddenCount = Math.max(nfts.length - visibleItems.length, 0);

  return {
    items: visibleItems.map((nft) => ({
      address: nft.address,
      name: nft.name,
      collectionName: nft.collection,
      collectionAddress: nft.collectionAddress,
      index: nft.index,
      imageUrl: nft.imageUrl,
      contentUrl: nft.contentUri,
      marketplaceUrl: nft.marketplaceUrl,
      collectionUrl: nft.collectionAddress
        ? `https://tonviewer.com/${nft.collectionAddress}`
        : undefined,
      onSale: nft.onSale
    })),
    totalCount: nfts.length,
    hiddenCount: hiddenCount > 0 ? hiddenCount : undefined
  };
}

function normalizeUsernameQuery(raw?: string) {
  if (!raw) {
    return undefined;
  }

  return raw
    .trim()
    .replace(/^@/, "")
    .replace(/\.tme$/i, "")
    .replace(/\.ton$/i, "")
    .toLowerCase();
}

async function getFragmentUsernamePrice(rawUsername?: string) {
  const username = normalizeUsernameQuery(rawUsername);

  if (!username) {
    return null;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);

  let response: Response;

  try {
    response = await fetch(`https://fragment.com/username/${username}`, {
      cache: "no-store",
      headers: {
        "User-Agent": "Mozilla/5.0"
      },
      signal: controller.signal
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    return null;
  }

  const html = await response.text();
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const sellMatch = text.match(/Sell Price\s*\*?\s*([0-9][0-9.,\s]*)/i);
  const saleMatch = text.match(/Sale Price\s+Owner\s+([0-9][0-9.,\s]*)/i);
  const ownerMatch = text.match(/Owner\s+(UQ[A-Za-z0-9_-]{30,}|EQ[A-Za-z0-9_-]{30,}|0:[A-Fa-f0-9]{64})/i);
  const status = text.includes("For sale")
    ? "for_sale"
    : text.includes("Sold")
      ? "sold"
      : text.includes("On auction")
        ? "auction"
        : "unknown";

  return {
    username,
    status,
    sellPriceTon: sellMatch?.[1]?.trim() ?? null,
    lastSaleTon: saleMatch?.[1]?.trim() ?? null,
    ownerAddress: ownerMatch?.[1] ?? null
  };
}

async function resolveTonDnsAddress(domain: string) {
  const apiKey = process.env.TON_API_KEY;
  const url = new URL(tonDnsEndpoint);
  url.searchParams.set("domain", domain.toLowerCase());
  url.searchParams.set("limit", "1");

  const response = await fetch(url, {
    headers: apiKey ? { "X-API-Key": apiKey } : undefined,
    cache: "no-store"
  });

  if (!response.ok) {
    return null;
  }

  const payload = (await response.json()) as {
    records?: Array<{
      dns_wallet?: string | null;
    }>;
  };

  return payload.records?.[0]?.dns_wallet ?? null;
}

async function normalizeAddressCandidate(candidate?: string) {
  if (!candidate) {
    return null;
  }

  const trimmed = candidate.trim();

  try {
    if (trimmed.toLowerCase().endsWith(".ton")) {
      const resolved = await resolveTonDnsAddress(trimmed);

      if (!resolved) {
        return {
          input: trimmed,
          normalizedAddress: null,
          resolvedFromDns: null as string | null
        };
      }

      return {
        input: trimmed,
        normalizedAddress: Address.parse(resolved).toString({
          bounceable: true,
          urlSafe: true
        }),
        resolvedFromDns: resolved
      };
    }

    return {
      input: trimmed,
      normalizedAddress: Address.parse(trimmed).toString({
        bounceable: true,
        urlSafe: true
      }),
      resolvedFromDns: null as string | null
    };
  } catch {
    return {
      input: trimmed,
      normalizedAddress: null,
      resolvedFromDns: null as string | null
    };
  }
}

function formatShortAddress(address: string) {
  return address.length > 18 ? `${address.slice(0, 6)}...${address.slice(-6)}` : address;
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  fallback: T
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timeoutId = setTimeout(() => resolve(fallback), ms);
      })
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

async function getTokenResearchData(
  query?: string,
  walletAddress?: string
): Promise<TokenResearchData | null> {
  if (!query) {
    return null;
  }

  const subject = query.trim();
  const addressLike = extractAddressLikeValue(subject);

  if (addressLike && !addressLike.toLowerCase().endsWith(".ton")) {
    try {
      const metadata = await withTimeout(
        getSwapCoffeeTokenMetadata(addressLike),
        3000,
        {
          symbol: undefined,
          name: undefined,
          decimals: undefined
        }
      );
      const symbol = metadata.symbol?.toUpperCase();
      const estimatedPriceUsdt = symbol
        ? await withTimeout(getUsdtValueEstimate(symbol, 1, walletAddress), 3000, null)
        : null;

      return {
        subject,
        symbol,
        name: metadata.name,
        address: addressLike,
        listedOnSwapCoffee: Boolean(symbol || metadata.name),
        estimatedPriceUsdt,
        quoteSource: estimatedPriceUsdt !== null ? "swap.coffee" : undefined,
        notes: [
          "Token metadata was found through swap.coffee.",
          estimatedPriceUsdt !== null
            ? "A live 1-token quote to USDT was available."
            : "A live USDT quote was not available for this token."
        ]
      };
    } catch {
      return {
        subject,
        address: addressLike,
        listedOnSwapCoffee: false,
        estimatedPriceUsdt: null,
        notes: [
          "Could not resolve token metadata for this address through swap.coffee."
        ]
      };
    }
  }

  try {
    const token = await withTimeout(getListedTokenBySymbol(subject), 3000, null);

    if (!token) {
      return {
        subject,
        symbol: subject.toUpperCase(),
        listedOnSwapCoffee: false,
        estimatedPriceUsdt: null,
        notes: [
          "This symbol was not found in the current swap.coffee token list."
        ]
      };
    }

    const symbol = (token.metadata?.symbol ?? subject).toUpperCase();
    const estimatedPriceUsdt = await withTimeout(
      getUsdtValueEstimate(symbol, 1, walletAddress),
      3000,
      null
    );

    return {
      subject,
      symbol,
      name: token.metadata?.name ?? token.metadata?.symbol ?? undefined,
      address: token.address.address,
      listedOnSwapCoffee: Boolean(token.metadata?.listed),
      estimatedPriceUsdt,
      quoteSource: estimatedPriceUsdt !== null ? "swap.coffee" : undefined,
      notes: [
        token.metadata?.listed
          ? "The token is listed on swap.coffee."
          : "The token was found, but it is not marked as listed on swap.coffee.",
        estimatedPriceUsdt !== null
          ? "A live 1-token quote to USDT was available."
          : "A live USDT quote was not available for this symbol."
      ]
    };
  } catch {
    return {
      subject,
      symbol: subject.toUpperCase(),
      listedOnSwapCoffee: false,
      estimatedPriceUsdt: null,
      notes: ["The token lookup failed right now. Try again in a few seconds."]
    };
  }
}

async function getAddressCheckData(query?: string): Promise<AddressCheckData | null> {
  if (!query) {
    return null;
  }

  const normalized = await normalizeAddressCandidate(query);

  if (!normalized) {
    return null;
  }

  if (!normalized.normalizedAddress) {
    return {
      input: normalized.input,
      jettons: [],
      nfts: [],
      notes: [
        normalized.input.toLowerCase().endsWith(".ton")
          ? "This TON DNS name could not be resolved to a wallet address."
          : "This does not look like a valid TON wallet address."
      ]
    };
  }

  const [tonBalance, jettons, nfts] = await Promise.all([
    withTimeout(
      getWalletBalance(normalized.normalizedAddress).catch(() => null),
      3000,
      null
    ),
    withTimeout(
      getWalletJettons(normalized.normalizedAddress).catch(() => []),
      3000,
      []
    ),
    withTimeout(
      getWalletNfts(normalized.normalizedAddress).catch(() => []),
      3000,
      []
    )
  ]);

  const notes = [
    normalized.input.toLowerCase().endsWith(".ton")
      ? "The TON DNS name was resolved successfully."
      : "The address is syntactically valid.",
    tonBalance || jettons.length || nfts.length
      ? "This address currently shows on-chain assets."
      : "No TON, jettons, or NFTs were found right now.",
    "This is an on-chain snapshot only and not a definitive scam verdict."
  ];

  return {
    input: normalized.input,
    normalizedAddress: normalized.normalizedAddress,
    resolvedFromDns: normalized.resolvedFromDns ?? undefined,
    tonBalance,
    jettons,
    nfts,
    notes
  };
}

function buildTokenResearchReply(data: TokenResearchData | null) {
  if (!data) {
    return "I can research a token, but I need the token symbol or contract address first.";
  }

  const priceLine =
    data.estimatedPriceUsdt !== null && data.estimatedPriceUsdt !== undefined
      ? `Estimated price: about ${formatUnitPrice(data.estimatedPriceUsdt)} USDT per ${data.symbol ?? "token"} via ${data.quoteSource ?? "swap.coffee"}.`
      : "I could not get a reliable live USDT quote for this token right now.";

  const identityLine = data.address
    ? `${data.name ?? data.symbol ?? data.subject} (${data.symbol ?? "token"}) at ${formatShortAddress(data.address)}.`
    : `${data.name ?? data.symbol ?? data.subject}.`;

  const listingLine = data.listedOnSwapCoffee
    ? "It is available in the current swap.coffee token universe."
    : "I could not confirm that it is currently listed on swap.coffee.";

  return `${identityLine}\n${listingLine}\n${priceLine}\n\nWhat I can verify right now:\n• ${data.notes.join("\n• ")}`;
}

function buildAddressCheckReply(data: AddressCheckData | null) {
  if (!data) {
    return "I can check an address for risk signals, but I need the wallet address or TON DNS name first.";
  }

  if (!data.normalizedAddress) {
    return `${data.notes[0] ?? "I could not validate this address."}\n\nSend me a full TON wallet address or a valid .ton name.`;
  }

  const jettonPreview = data.jettons.length
    ? data.jettons
        .slice(0, 3)
        .map((jetton) => `${jetton.balance} ${jetton.symbol}`)
        .join(", ")
    : "No jettons found";
  const nftPreview = data.nfts.length
    ? `${data.nfts.length} NFT(s) found`
    : "No NFTs found";
  const resolvedLine =
    data.input.toLowerCase().endsWith(".ton") && data.resolvedFromDns
      ? `Resolved ${data.input} to ${formatShortAddress(data.normalizedAddress)}.`
      : `Address: ${formatShortAddress(data.normalizedAddress)}.`;

  return `${resolvedLine}
TON balance: ${data.tonBalance ?? "0.00"} TON.
Jettons: ${jettonPreview}.
NFTs: ${nftPreview}.

Risk view:
• ${data.notes.join("\n• ")}

I can tell you what is on-chain here, but this alone does not prove the address is safe. For a stronger check, compare the destination with the official project source and verify the transfer purpose before signing.`;
}

export async function generateAgentReply(rawInput: unknown) {
  const parsed = chatInputSchema.parse(rawInput);
  const normalizedMessage = normalizeUserText(parsed.message);
  const language = "en" as const;
  const walletLine =
    parsed.walletConnected ? "" : "Wallet is not connected yet.";

  const withWalletLine = (...parts: Array<string | null | undefined>) =>
    [walletLine, ...parts].filter((part) => Boolean(part && part.trim())).join("\n\n");

  if (isGreetingMessage(normalizedMessage)) {
    return {
      text:
        language === "en"
          ? withWalletLine(`Hi. ${getCapabilitiesText(language)}`)
          : withWalletLine(`Hi. ${getCapabilitiesText(language)}`),
      intent: createBaseIntent("unknown")
    };
  }

  if (isCapabilitiesQuestion(normalizedMessage)) {
    return {
      text:
        language === "en"
          ? withWalletLine(getCapabilitiesText(language))
          : withWalletLine(getCapabilitiesText(language)),
      intent: createBaseIntent("unknown")
    };
  }

  const history = parsed.history ?? [];
  const parsedIntentResult = await parseIntent(parsed.message, history);
  const intent = parsedIntentResult.intent;
  const conversationState = deriveConversationState(history);

  if (shouldUseDirectBrainReply(parsed.message, history, intent)) {
    const smallTalkReply = getSmallTalkReply(parsed.message, language);
    if (smallTalkReply) {
      return {
        text: withWalletLine(smallTalkReply),
        intent,
        understanding: {
          normalizedRequest: intent.summary || normalizedMessage
        }
      };
    }

    const utilityReply = getUtilityReply(parsed.message, language);
    if (utilityReply) {
      return {
        text: withWalletLine(utilityReply),
        intent,
        understanding: {
          normalizedRequest: intent.summary || normalizedMessage
        }
      };
    }

    const directReply = await directBrainReplyWithOpenAI({
      message: parsed.message,
      history,
      walletAddress: parsed.walletAddress,
      walletConnected: parsed.walletConnected,
      language
    }).catch(() => null);

    if (directReply) {
      return {
        text: directReply,
        intent,
        understanding: {
          normalizedRequest: intent.summary || normalizedMessage
        }
      };
    }
  }
  const execution =
    intent.action === "swap" ||
    intent.action === "sell" ||
    intent.action === "buy" ||
    intent.action === "send"
      ? await buildExecutionPlan(intent, parsed.walletAddress)
      : undefined;
  const walletBalance =
    intent.action === "balance"
      ? await getWalletBalance(parsed.walletAddress)
      : null;
  const walletJettons =
    intent.action === "balance"
      ? await getWalletJettons(parsed.walletAddress)
      : [];
  const walletTransactions =
    intent.action === "transactions"
      ? await getWalletTransactions(parsed.walletAddress)
      : [];
  const walletNfts =
    intent.action === "nft"
      ? await getWalletNfts(parsed.walletAddress)
      : [];
  const usernamePrice =
    intent.action === "username_price"
      ? await getFragmentUsernamePrice(intent.query)
      : null;
  const tokenResearchData =
    intent.action === "token_research"
      ? await getTokenResearchData(intent.query, parsed.walletAddress)
      : null;
  const addressCheckData =
    intent.action === "address_check"
      ? await getAddressCheckData(intent.recipient ?? intent.query)
      : null;
  const specialIntentReply =
    intent.action === "token_research" ||
    intent.action === "address_check" ||
    intent.action === "contract_explain"
      ? await answerSpecialIntentWithOpenAI({
          message: parsed.message,
          intent,
          walletAddress: parsed.walletAddress,
          context:
            intent.action === "token_research"
              ? tokenResearchData
              : intent.action === "address_check"
                ? addressCheckData
                : undefined
        }).catch(() => null)
      : null;
  const aiReply = shouldUseAiReply(intent, parsed.message)
    ? await completeWithOpenAI({
        message: parsed.message,
        intent,
        executionSummary: execution?.summary,
        walletAddress: parsed.walletAddress,
        walletConnected: parsed.walletConnected,
        history,
        language
      }).catch(() => null)
    : null;

  if (aiReply) {
    return {
      text: aiReply,
      intent,
      execution,
      understanding: parsedIntentResult.understanding
    };
  }

  if (specialIntentReply) {
    return {
      text: withWalletLine(specialIntentReply),
      intent,
      understanding: parsedIntentResult.understanding
    };
  }

  if (intent.action === "balance") {
    const preferredJettons = walletJettons.filter((jetton) => jetton.hasReadableMetadata);
    const unknownJettons = walletJettons.filter((jetton) => !jetton.hasReadableMetadata);
    const visibleJettons = preferredJettons;
    const hiddenJettonsCount = 0;
    const valuation = await getBalanceValuation({
      walletBalance,
      visibleJettons,
      walletAddress: parsed.walletAddress
    });
    const tonLine = walletBalance
      ? `Balance: ${walletBalance} TON${
          valuation.tonValue !== null
            ? ` (est. ${formatUsdValue(valuation.tonValue)} USDT${
                valuation.tonUnitPrice !== null
                  ? `, 1 TON = ${formatUnitPrice(valuation.tonUnitPrice)} USDT`
                  : ""
              })`
            : ""
        }.`
      : null;
    const jettonsLine = walletJettons.length
      ? `\nTokens:\n${visibleJettons
          .map((jetton) => {
            const tokenValue = valuation.tokenValues.find(
              (item) => item.symbol === jetton.symbol
            );
            const unitPrice =
              tokenValue?.usdtValue !== null &&
              tokenValue?.usdtValue !== undefined &&
              jetton.numericBalance > 0
                ? tokenValue.usdtValue / jetton.numericBalance
                : null;

            return `• ${jetton.balance} ${jetton.symbol}${
              tokenValue?.usdtValue !== null && tokenValue?.usdtValue !== undefined
                ? ` (est. ${formatUsdValue(tokenValue.usdtValue)} USDT${
                    unitPrice !== null
                      ? `, 1 ${jetton.symbol} = ${formatUnitPrice(unitPrice)} USDT`
                      : ""
                  })`
                : ""
            }`;
          })
          .join("\n")}${hiddenJettonsCount > 0 ? `\n• and ${hiddenJettonsCount} more token(s)` : ""}`
      : "";
    const totalLine =
      valuation.totalUsdt !== null
        ? `\n\nTotal visible asset estimate: ${formatUsdValue(valuation.totalUsdt)} USDT.`
        : "";
    const portfolio = buildPortfolioData({
      walletBalance,
      visibleJettons,
      unknownJettons,
      valuation,
      hiddenJettonsCount
    });

    return {
      text: parsed.walletConnected
        ? walletBalance
          ? withWalletLine(`${tonLine}${jettonsLine}${totalLine}`, "If you want, I can also prepare a transfer, swap, or sell flow next.")
          : withWalletLine("Could not load the wallet balance right now. Try again in a few seconds.")
        : "Wallet is not connected yet.\n\nConnect a TON wallet and I will show the balance.",
      intent,
      execution,
      portfolio,
      understanding: parsedIntentResult.understanding
    };
  }

  if (intent.action === "transactions") {
    if (!parsed.walletConnected || !parsed.walletAddress) {
      return {
        text: "Wallet is not connected yet.\n\nConnect a TON wallet and I will show the recent transactions.",
        intent,
        understanding: parsedIntentResult.understanding
      };
    }

    if (!walletTransactions.length) {
      return {
        text: withWalletLine("No recent transactions were found for this wallet right now."),
        intent,
        understanding: parsedIntentResult.understanding
      };
    }

    const transactionLines = walletTransactions.map((transaction, index) => {
      const directionLabel =
        transaction.direction === "in"
          ? "IN"
          : transaction.direction === "out"
            ? "OUT"
            : "TX";
      const amountLabel = transaction.amountTon ? `${transaction.amountTon} TON` : "amount unavailable";
      const counterparty =
        transaction.direction === "in"
          ? transaction.from
          : transaction.to;
      const when = transaction.timestamp
        ? new Date(transaction.timestamp * 1000).toLocaleString("en-US", {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit"
          })
        : "time unavailable";
      const comment = transaction.comment ? `, note: ${transaction.comment}` : "";

      return `• ${index + 1}. ${directionLabel} ${amountLabel}${counterparty ? ` ${transaction.direction === "in" ? "from" : "to"} ${counterparty}` : ""} on ${when}${comment}.`;
    }).join("\n");

    return {
      text: withWalletLine(
        `Recent wallet transactions:\n${transactionLines}`,
        "If you want, I can also check the balance, tokens, NFTs, or prepare the next transfer."
      ),
      intent,
      understanding: parsedIntentResult.understanding
    };
  }

  if (intent.action === "nft") {
    if (!parsed.walletConnected || !parsed.walletAddress) {
      return {
        text: "Wallet is not connected yet.\n\nConnect a TON wallet and I will show the NFTs.",
        intent,
        understanding: parsedIntentResult.understanding
      };
    }

    if (!walletNfts.length) {
      return {
        text: withWalletLine("No NFTs were found in this wallet right now."),
        intent,
        understanding: parsedIntentResult.understanding
      };
    }

    const visibleNfts = walletNfts.slice(0, 8);
    const hiddenCount = Math.max(walletNfts.length - visibleNfts.length, 0);
    const nftLines = visibleNfts
      .map((nft, index) => {
        const title = nft.name?.trim() || `NFT #${nft.index ?? index + 1}`;
        const parts = [`${index + 1}. ${title}`];

        if (nft.index && !nft.name) {
          parts.push(`#${nft.index}`);
        }

        if (nft.collection) {
          parts.push(`from collection ${nft.collection}`);
        }

        if (nft.onSale) {
          parts.push("(for sale)");
        }

        return `• ${parts.join(" ")}.`;
      })
      .join("\n");

    return {
      text: withWalletLine(
        (
          `Found ${walletNfts.length} NFT(s) in the wallet.\n${nftLines}`
        ) +
        (hiddenCount > 0 ? `\n• and ${hiddenCount} more NFT(s).` : "")
      ),
      intent,
      nftGallery: buildNftGalleryData(walletNfts, 8),
      understanding: parsedIntentResult.understanding
    };
  }

  if (intent.action === "username_price") {
    if (!intent.query) {
      return {
        text: withWalletLine("Specify the username to check on Fragment. Example: `How much does username payer cost?`"),
        intent,
        execution,
        understanding: parsedIntentResult.understanding
      };
    }

    if (!usernamePrice) {
      return {
        text: withWalletLine(`Could not load data for username ${intent.query} from Fragment right now.`),
        intent,
        execution,
        understanding: parsedIntentResult.understanding
      };
    }

    const priceLine =
      usernamePrice.sellPriceTon
        ? `${usernamePrice.username} is currently listed for about ${usernamePrice.sellPriceTon} TON on Fragment.`
        : usernamePrice.lastSaleTon
          ? `The latest found price for ${usernamePrice.username} on Fragment is ${usernamePrice.lastSaleTon} TON.`
          : `Found the ${usernamePrice.username} page on Fragment, but could not extract a clear price.`;

    const statusLine =
      usernamePrice.status === "for_sale"
        ? "Status: listed for sale."
        : usernamePrice.status === "sold"
          ? "Status: sold."
          : usernamePrice.status === "auction"
            ? "Status: auction."
            : "Status: could not determine confidently.";

    return {
      text: withWalletLine(`${priceLine}\n${statusLine}`, "Source: Fragment."),
      intent: {
        ...intent,
        recipient: usernamePrice.ownerAddress ?? intent.recipient
      },
      execution,
      understanding: parsedIntentResult.understanding
    };
  }

  if (intent.action === "fee_estimate") {
    const amountLabel = intent.amount ? `for sending ${intent.amount} ${intent.fromToken ?? "TON"}` : "for a regular TON transfer";
    const estimatedFeeTon = estimateTransferFeeTon(intent);
    const estimateContext =
      intent.comment?.trim()
        ? `This estimate includes a transfer comment.`
        : intent.recipient?.trim().toLowerCase().endsWith(".ton")
          ? `This estimate assumes delivery to a .ton recipient.`
          : "This estimate assumes a plain wallet-to-wallet transfer with no comment.";
    return {
      text: withWalletLine(
        `Estimated network fee ${amountLabel}: about ${estimatedFeeTon.toFixed(3)} TON.\n\n${estimateContext} A comment, extra payload, or a different wallet route can change the result slightly. The final exact fee is still shown in the wallet before confirmation.\n\nIf you give me the recipient and comment, I can tune the estimate more closely.`
      ),
      feeEstimate: {
        estimatedFeeTon: estimatedFeeTon.toFixed(3),
        basis: estimateContext,
        amount: intent.amount ? `${intent.amount} ${intent.fromToken ?? "TON"}` : undefined,
        recipient: intent.recipient,
        comment: intent.comment
      },
      intent,
      understanding: parsedIntentResult.understanding
    };
  }

  if (intent.action === "token_research") {
    return {
      text: withWalletLine(buildTokenResearchReply(tokenResearchData)),
      intent,
      understanding: parsedIntentResult.understanding
    };
  }

  if (intent.action === "address_check") {
    return {
      text: withWalletLine(buildAddressCheckReply(addressCheckData)),
      intent,
      understanding: parsedIntentResult.understanding
    };
  }

  if (intent.action === "contract_explain") {
    return {
      text: withWalletLine(
        intent.query || intent.recipient
          ? "I can explain this contract in plain English, but I need the contract address, source, or a code snippet to do it properly."
          : "I can explain a smart contract in plain English, but I need the contract address, source, or code snippet first."
      ),
      intent,
      understanding: parsedIntentResult.understanding
    };
  }

  if (intent.action === "unknown") {
    const clarificationQuestion = shouldGenerateClarificationWithAi(parsed.message, intent)
      ? await generateClarificationQuestion({
          message: parsed.message,
          history,
          conversationState
        })
      : null;

    if (clarificationQuestion) {
      return {
        text: withWalletLine(clarificationQuestion),
        intent,
        execution,
        understanding: parsedIntentResult.understanding
      };
    }
  }

  let actionLine = intent.summary;
  actionLine = summarizeIntentForLanguage(intent, language);
  if (intent.action !== "unknown") {
    actionLine = execution
      ? buildAgenticExecutionText(intent, execution)
      : `${actionLine}\n\nNext step: I can refine the request and prepare the action details.`;
  }

  return {
    text:
      intent.action === "unknown"
        ? withWalletLine(getCapabilitiesText(language))
        : withWalletLine(
            actionLine,
            !execution
              ? "If you want, I can refine the request or continue with the next step."
              : undefined
          ),
    intent,
    execution,
    understanding: parsedIntentResult.understanding
  };
}
