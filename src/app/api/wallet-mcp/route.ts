import { Address, comment, toNano } from "@ton/core";
import { NextRequest, NextResponse } from "next/server";

type JettonMetadata = {
  symbol?: string;
  name?: string;
  decimals?: number | string;
};

const tonApiEndpoint =
  process.env.TON_API_ENDPOINT ?? "https://toncenter.com/api/v2/jsonRPC";
const tonApiKey = process.env.TON_API_KEY;
const jettonWalletsEndpoint =
  process.env.TON_API_V3_JETTON_WALLETS_ENDPOINT ??
  "https://toncenter.com/api/v3/jetton/wallets";
const jettonMastersEndpoint =
  process.env.TON_API_V3_JETTON_MASTERS_ENDPOINT ??
  "https://toncenter.com/api/v3/jetton/masters";
const nanotonsPerTon = 1_000_000_000;

function jsonRpcResult(id: string | number | null, result: unknown) {
  return NextResponse.json({
    jsonrpc: "2.0",
    id,
    result
  });
}

function jsonRpcError(
  id: string | number | null,
  code: number,
  message: string,
  status = 400
) {
  return NextResponse.json(
    {
      jsonrpc: "2.0",
      id,
      error: {
        code,
        message
      }
    },
    { status }
  );
}

function getAliasOverrides() {
  const raw = process.env.JETTON_ALIASES_JSON;

  if (!raw) {
    return {} as Record<string, { symbol?: string; name?: string }>;
  }

  try {
    return JSON.parse(raw) as Record<string, { symbol?: string; name?: string }>;
  } catch {
    return {} as Record<string, { symbol?: string; name?: string }>;
  }
}

function normalizeJettonAddress(address?: string) {
  return address?.trim().toUpperCase();
}

function formatTokenBalance(rawBalance: number) {
  return rawBalance >= 1 ? rawBalance.toFixed(4) : rawBalance.toFixed(6);
}

async function getTonBalance(address: string) {
  const response = await fetch(tonApiEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(tonApiKey ? { "X-API-Key": tonApiKey } : {})
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

  return (Number(payload.result) / nanotonsPerTon).toFixed(2);
}

async function getWalletJettons(address: string) {
  const url = new URL(jettonWalletsEndpoint);
  url.searchParams.set("owner_address", address);
  url.searchParams.set("exclude_zero_balance", "true");
  url.searchParams.set("limit", "10");

  const response = await fetch(url, {
    headers: tonApiKey ? { "X-API-Key": tonApiKey } : undefined,
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
          (jettonAddress): jettonAddress is string =>
            Boolean(
              jettonAddress &&
                !payloadMetadata[jettonAddress]?.symbol &&
                !payloadMetadata[jettonAddress]?.name
            )
        )
    )
  );

  let masterMetadata: Record<string, JettonMetadata> = {};

  if (missingMetadataAddresses.length) {
    const mastersUrl = new URL(jettonMastersEndpoint);

    for (const jettonAddress of missingMetadataAddresses.slice(0, 10)) {
      mastersUrl.searchParams.append("address", jettonAddress);
    }

    const mastersResponse = await fetch(mastersUrl, {
      headers: tonApiKey ? { "X-API-Key": tonApiKey } : undefined,
      cache: "no-store"
    });

    if (mastersResponse.ok) {
      const mastersPayload = (await mastersResponse.json()) as {
        metadata?: Record<string, JettonMetadata>;
      };

      masterMetadata = mastersPayload.metadata ?? {};
    }
  }

  const aliasOverrides = getAliasOverrides();

  return (payload.jetton_wallets ?? [])
    .map((wallet) => {
      const normalizedAddress = normalizeJettonAddress(wallet.jetton);
      const metadata = wallet.jetton
        ? payloadMetadata[wallet.jetton] ??
          masterMetadata[wallet.jetton] ??
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
        symbol:
          metadata?.symbol ??
          metadata?.name ??
          (wallet.jetton ? `JETTON ${wallet.jetton.slice(0, 6)}...` : "JETTON"),
        name: metadata?.name ?? metadata?.symbol ?? undefined,
        balance: formatTokenBalance(balance),
        numericBalance: balance,
        hasReadableMetadata: Boolean(metadata?.symbol || metadata?.name)
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .sort((a, b) => {
      if (a.hasReadableMetadata !== b.hasReadableMetadata) {
        return a.hasReadableMetadata ? -1 : 1;
      }

      return b.numericBalance - a.numericBalance;
    });
}

function toUserFriendlyAddress(address: string) {
  return Address.parse(address).toString({
    bounceable: true,
    urlSafe: true
  });
}

function getStringArg(
  args: Record<string, unknown>,
  keys: string[],
  required = false
) {
  for (const key of keys) {
    const value = args[key];

    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  if (required) {
    throw new Error(`Missing required argument: ${keys[0]}`);
  }

  return undefined;
}

function getNumberArg(args: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = args[key];

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

  return undefined;
}

async function handleGetWalletAssets(id: string | number | null, args: Record<string, unknown>) {
  const address = getStringArg(
    args,
    ["walletAddress", "wallet_address", "owner_address", "account", "address"],
    true
  );

  if (!address) {
    throw new Error("Address is required");
  }

  const [tonBalance, jettons] = await Promise.all([
    getTonBalance(address),
    getWalletJettons(address)
  ]);

  return jsonRpcResult(id, {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          tonBalance,
          jettons
        })
      }
    ],
    structuredContent: {
      tonBalance,
      jettons
    }
  });
}

async function handlePrepareTransfer(id: string | number | null, args: Record<string, unknown>) {
  const recipient = getStringArg(
    args,
    ["recipient", "recipient_address", "to", "destination", "address"],
    true
  );
  const amountTon =
    getNumberArg(args, ["amount", "amountTon", "amount_ton"]) ??
    (() => {
      const amountNano = getStringArg(args, ["amountNano", "amount_nano", "value"]);

      if (!amountNano) {
        return undefined;
      }

      return Number(amountNano) / nanotonsPerTon;
    })();

  if (!recipient) {
    throw new Error("Recipient is required");
  }

  if (!amountTon || amountTon <= 0) {
    throw new Error("Amount must be greater than zero");
  }

  const commentText = getStringArg(args, ["comment", "memo", "text"]);
  const normalizedRecipient = toUserFriendlyAddress(recipient);
  const summary = `Prepared a transfer of ${amountTon} TON to ${normalizedRecipient}${commentText ? ` with comment "${commentText}"` : ""}. You can now open the wallet for confirmation.`;

  return jsonRpcResult(id, {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          summary,
          transaction: {
            validUntil: Math.floor(Date.now() / 1000) + 600,
            messages: [
              {
                address: normalizedRecipient,
                amount: toNano(amountTon).toString(),
                ...(commentText
                  ? {
                      payload: comment(commentText).toBoc().toString("base64")
                    }
                  : {})
              }
            ]
          }
        })
      }
    ],
    structuredContent: {
      summary,
      transaction: {
        validUntil: Math.floor(Date.now() / 1000) + 600,
        messages: [
          {
            address: normalizedRecipient,
            amount: toNano(amountTon).toString(),
            ...(commentText
              ? {
                  payload: comment(commentText).toBoc().toString("base64")
                }
              : {})
          }
        ]
      }
    }
  });
}

export async function GET(request: NextRequest) {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL?.trim() || new URL(request.url).origin;

  return NextResponse.json({
    server: {
      name: "TON Wallet MCP",
      version: "0.1.0",
      transport: "http"
    },
    capabilities: {
      tools: {
        get_wallet_assets: {
          name: "get_wallet_assets",
          description: "Get TON balance and jettons for a wallet address.",
          inputSchema: {
            type: "object",
            properties: {
              address: {
                type: "string",
                description: "TON wallet address."
              }
            },
            required: ["address"]
          },
          operationId: "wallet_get_assets"
        },
        prepare_transfer: {
          name: "prepare_transfer",
          description: "Prepare a TON transfer payload for wallet confirmation.",
          inputSchema: {
            type: "object",
            properties: {
              recipient: {
                type: "string",
                description: "Recipient TON wallet address."
              },
              amount: {
                type: "number",
                description: "Amount in TON."
              },
              comment: {
                type: "string",
                description: "Optional transfer comment."
              }
            },
            required: ["recipient", "amount"]
          },
          operationId: "wallet_prepare_transfer"
        }
      }
    },
    resources: [],
    prompts: [],
    _meta: {
      endpoint: `${baseUrl}/api/wallet-mcp`
    }
  });
}

export async function POST(request: NextRequest) {
  let payload:
    | {
        id?: string | number | null;
        method?: string;
        params?: {
          name?: string;
          arguments?: Record<string, unknown>;
        };
      }
    | undefined;

  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return jsonRpcError(null, -32700, "Invalid JSON", 400);
  }

  const id = payload?.id ?? null;

  if (payload?.method !== "tools/call") {
    return jsonRpcError(id, -32601, "Method not found", 404);
  }

  const toolName = payload.params?.name;
  const args = payload.params?.arguments ?? {};

  try {
    switch (toolName) {
      case "get_wallet_assets":
        return await handleGetWalletAssets(id, args);
      case "prepare_transfer":
        return await handlePrepareTransfer(id, args);
      default:
        return jsonRpcError(id, -32601, `Unknown tool: ${toolName ?? "undefined"}`, 404);
    }
  } catch (error) {
    return jsonRpcError(
      id,
      -32000,
      error instanceof Error ? error.message : "Internal wallet MCP error",
      400
    );
  }
}
