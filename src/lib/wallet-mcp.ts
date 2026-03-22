import { toNano } from "@ton/core";
import type { ExecutionPlan } from "@/lib/types";
import { getTonMcpProfile } from "@/lib/mcp";

type McpToolDefinition = {
  name?: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
};

type McpDescriptor = {
  capabilities?: {
    tools?: Record<string, McpToolDefinition>;
  };
};

type WalletMcpJetton = {
  symbol: string;
  name?: string;
  balance: string;
  numericBalance: number;
  hasReadableMetadata: boolean;
};

type WalletMcpPortfolio = {
  tonBalance: string | null;
  jettons: WalletMcpJetton[];
};

const descriptorCache = new Map<string, Promise<McpDescriptor | null>>();
const portfolioCache = new Map<string, Promise<WalletMcpPortfolio | null>>();

function getWalletMcpUrl() {
  return getTonMcpProfile().walletMcpHttpUrl;
}

function normalizeToolName(name: string) {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
}

async function fetchDescriptor(url: string) {
  const cached = descriptorCache.get(url);

  if (cached) {
    return cached;
  }

  const promise = (async () => {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json"
      },
      cache: "no-store"
    });

    if (!response.ok) {
      return null;
    }

    return (await response.json()) as McpDescriptor;
  })().catch(() => null);

  descriptorCache.set(url, promise);
  return promise;
}

async function getTools(url: string) {
  const descriptor = await fetchDescriptor(url);
  const toolEntries = Object.entries(descriptor?.capabilities?.tools ?? {});

  return toolEntries.map(([key, value]) => ({
    name: value.name ?? key,
    inputSchema: value.inputSchema
  }));
}

function pickToolName(
  tools: Array<{ name: string; inputSchema?: McpToolDefinition["inputSchema"] }>,
  aliases: string[]
) {
  const normalizedAliases = aliases.map(normalizeToolName);

  for (const alias of normalizedAliases) {
    const exact = tools.find((tool) => normalizeToolName(tool.name) === alias);

    if (exact) {
      return exact;
    }
  }

  for (const alias of normalizedAliases) {
    const partial = tools.find((tool) => normalizeToolName(tool.name).includes(alias));

    if (partial) {
      return partial;
    }
  }

  return null;
}

function getSchemaPropertyNames(inputSchema?: McpToolDefinition["inputSchema"]) {
  return Object.keys(inputSchema?.properties ?? {});
}

function getLastSseJsonChunk(raw: string) {
  const dataLines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((line) => line && line !== "[DONE]");

  for (let index = dataLines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(dataLines[index]) as unknown;
    } catch {
      continue;
    }
  }

  return null;
}

async function parseResponseBody(response: Response) {
  const raw = await response.text();

  if (!raw.trim()) {
    return null;
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return getLastSseJsonChunk(raw);
  }
}

async function callTool(url: string, name: string, args: Record<string, unknown>) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: {
        name,
        arguments: args
      }
    }),
    cache: "no-store"
  });

  if (!response.ok) {
    return null;
  }

  const payload = (await parseResponseBody(response)) as
    | {
        result?: unknown;
      }
    | null;

  return payload?.result ?? payload;
}

function extractTextItems(value: unknown): string[] {
  if (!value || typeof value !== "object") {
    return [];
  }

  const content = "content" in value ? (value as { content?: unknown }).content : undefined;

  if (!Array.isArray(content)) {
    return [];
  }

  return content
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }

      const typedItem = item as { type?: unknown; text?: unknown };
      return typedItem.type === "text" && typeof typedItem.text === "string"
        ? typedItem.text
        : null;
    })
    .filter((item): item is string => Boolean(item));
}

function extractStructuredPayload(value: unknown) {
  if (!value || typeof value !== "object") {
    return value;
  }

  const structured =
    "structuredContent" in value
      ? (value as { structuredContent?: unknown }).structuredContent
      : undefined;

  if (structured && typeof structured === "object") {
    return structured;
  }

  const textItems = extractTextItems(value);

  for (const text of textItems) {
    try {
      const parsed = JSON.parse(text) as unknown;

      if (parsed && typeof parsed === "object") {
        return parsed;
      }
    } catch {
      continue;
    }
  }

  return value;
}

function getStringValue(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];

    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

function getNumberValue(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];

    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === "string") {
      const parsed = Number(value);

      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return null;
}

function formatTokenBalance(rawBalance: number) {
  return rawBalance >= 1 ? rawBalance.toFixed(4) : rawBalance.toFixed(6);
}

function parsePortfolioFromPayload(value: unknown): WalletMcpPortfolio | null {
  const payload = extractStructuredPayload(value);

  if (!payload || typeof payload !== "object") {
    return null;
  }

  const record = payload as Record<string, unknown>;
  const tonCandidates = [
    record.ton,
    record.balance,
    record.tonBalance,
    record.ton_balance,
    record.wallet
  ];

  let tonBalance: string | null = null;

  for (const candidate of tonCandidates) {
    if (!candidate) {
      continue;
    }

    if (typeof candidate === "string") {
      tonBalance = candidate;
      break;
    }

    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      tonBalance = candidate.toFixed(2);
      break;
    }

    if (typeof candidate === "object") {
      const nested = candidate as Record<string, unknown>;
      const symbol = getStringValue(nested, ["symbol", "asset", "token"]);

      if (!symbol || symbol.toUpperCase() === "TON") {
        const nestedBalance = getNumberValue(nested, ["balance", "amount", "value"]);

        if (nestedBalance !== null) {
          tonBalance = nestedBalance.toFixed(2);
          break;
        }
      }
    }
  }

  const assetLists = [
    record.assets,
    record.tokens,
    record.jettons,
    record.portfolio
  ].filter(Array.isArray) as Array<Array<Record<string, unknown>>>;

  const jettons: WalletMcpJetton[] = [];

  for (const list of assetLists) {
    for (const asset of list) {
      const symbol =
        getStringValue(asset, ["symbol", "ticker", "asset", "token"]) ?? "JETTON";
      const upperSymbol = symbol.toUpperCase();
      const balanceValue = getNumberValue(asset, ["balance", "amount", "value"]);

      if (balanceValue === null || balanceValue <= 0) {
        continue;
      }

      if (upperSymbol === "TON") {
        if (!tonBalance) {
          tonBalance = balanceValue.toFixed(2);
        }

        continue;
      }

      const name = getStringValue(asset, ["name", "title"]);

      jettons.push({
        symbol: upperSymbol,
        name: name ?? undefined,
        balance: formatTokenBalance(balanceValue),
        numericBalance: balanceValue,
        hasReadableMetadata: upperSymbol !== "JETTON" || Boolean(name)
      });
    }
  }

  if (!tonBalance && !jettons.length) {
    return null;
  }

  jettons.sort((a, b) => {
    if (a.hasReadableMetadata !== b.hasReadableMetadata) {
      return a.hasReadableMetadata ? -1 : 1;
    }

    return b.numericBalance - a.numericBalance;
  });

  return {
    tonBalance,
    jettons
  };
}

function pickAddressArgName(propertyNames: string[]) {
  return (
    propertyNames.find((name) =>
      ["walletAddress", "wallet_address", "owner_address", "account", "address"].includes(name)
    ) ?? null
  );
}

function buildArgsFromSchema(
  propertyNames: string[],
  candidates: Record<string, unknown>
) {
  const args: Record<string, unknown> = {};

  for (const propertyName of propertyNames) {
    if (propertyName in candidates && candidates[propertyName] !== undefined) {
      args[propertyName] = candidates[propertyName];
    }
  }

  return args;
}

export async function getWalletPortfolioViaMcp(walletAddress?: string) {
  const url = getWalletMcpUrl();

  if (!url || !walletAddress) {
    return null;
  }

  const cacheKey = `${url}:${walletAddress}`;
  const cached = portfolioCache.get(cacheKey);

  if (cached) {
    return cached;
  }

  const promise = (async () => {
    const tools = await getTools(url);
    const tool = pickToolName(tools, [
      "get_wallet_assets",
      "wallet_assets",
      "get_portfolio",
      "portfolio",
      "get_balance",
      "wallet_balance",
      "balance"
    ]);

    if (!tool) {
      return null;
    }

    const propertyNames = getSchemaPropertyNames(tool.inputSchema);
    const schemaArgs = buildArgsFromSchema(propertyNames, {
      walletAddress,
      wallet_address: walletAddress,
      owner_address: walletAddress,
      account: walletAddress,
      address: walletAddress
    });
    const args =
      Object.keys(schemaArgs).length > 0
        ? schemaArgs
        : { [pickAddressArgName(propertyNames) ?? "address"]: walletAddress };
    const result = await callTool(url, tool.name, args).catch(() => null);

    return parsePortfolioFromPayload(result);
  })();

  portfolioCache.set(cacheKey, promise);
  return promise;
}

function parseExecutionPlanFromPayload(
  value: unknown,
  fallbackSummary: string
): ExecutionPlan | null {
  const payload = extractStructuredPayload(value);

  if (!payload || typeof payload !== "object") {
    return null;
  }

  const record = payload as Record<string, unknown>;
  const transaction =
    (record.transaction as Record<string, unknown> | undefined) ??
    (record.tx as Record<string, unknown> | undefined) ??
    record;
  const messagesValue =
    (transaction.messages as Array<Record<string, unknown>> | undefined) ??
    (record.messages as Array<Record<string, unknown>> | undefined);

  if (!Array.isArray(messagesValue) || !messagesValue.length) {
    return null;
  }

  const messages = messagesValue
    .map((message) => {
      const address = getStringValue(message, ["address", "to", "recipient"]);
      const amount = getStringValue(message, ["amount", "value"]);

      if (!address || !amount) {
        return null;
      }

      return {
        address,
        amount,
        ...(getStringValue(message, ["payload", "body"])
          ? { payload: getStringValue(message, ["payload", "body"]) ?? undefined }
          : {}),
        ...(getStringValue(message, ["stateInit", "state_init"])
          ? {
              stateInit: getStringValue(message, ["stateInit", "state_init"]) ?? undefined
            }
          : {})
      };
    })
    .filter(
      (
        message
      ): message is {
        address: string;
        amount: string;
        payload?: string;
        stateInit?: string;
      } => Boolean(message)
    );

  if (!messages.length) {
    return null;
  }

  const validUntil =
    getNumberValue(transaction, ["validUntil", "valid_until"]) ??
    getNumberValue(record, ["validUntil", "valid_until"]) ??
    Math.floor(Date.now() / 1000) + 600;
  const summary =
    getStringValue(record, ["summary", "description", "message"]) ?? fallbackSummary;

  return {
    kind: "transfer",
    status: "ready",
    protocol: "ton-transfer",
    summary,
    validUntil: Math.floor(validUntil),
    messages
  };
}

export async function prepareTransferViaWalletMcp(input: {
  walletAddress: string;
  recipient: string;
  amount: number;
  comment?: string;
}) {
  const url = getWalletMcpUrl();

  if (!url) {
    return null;
  }

  const tools = await getTools(url);
  const tool = pickToolName(tools, [
    "prepare_transfer",
    "wallet_transfer",
    "send_ton",
    "send",
    "transfer"
  ]);

  if (!tool) {
    return null;
  }

  const amountNano = toNano(input.amount).toString();
  const propertyNames = getSchemaPropertyNames(tool.inputSchema);
  const schemaArgs = buildArgsFromSchema(propertyNames, {
    walletAddress: input.walletAddress,
    wallet_address: input.walletAddress,
    sender_address: input.walletAddress,
    recipient: input.recipient,
    recipient_address: input.recipient,
    to: input.recipient,
    destination: input.recipient,
    amount: input.amount,
    amountTon: input.amount,
    amount_ton: input.amount,
    amountNano,
    amount_nano: amountNano,
    value: amountNano,
    comment: input.comment,
    memo: input.comment,
    text: input.comment
  });

  const attempts =
    Object.keys(schemaArgs).length > 0
      ? [schemaArgs]
      : [
          {
            wallet_address: input.walletAddress,
            to: input.recipient,
            amount: input.amount,
            comment: input.comment
          },
          {
            sender_address: input.walletAddress,
            recipient: input.recipient,
            amount_nano: amountNano,
            memo: input.comment
          }
        ];

  for (const args of attempts) {
    const result = await callTool(url, tool.name, args).catch(() => null);
    const plan = parseExecutionPlanFromPayload(
      result,
      `Prepared a transfer of ${input.amount} TON to ${input.recipient}${input.comment ? ` with comment "${input.comment}"` : ""}. You can now open the wallet for confirmation.`
    );

    if (plan) {
      return plan;
    }
  }

  return null;
}
