import { Address, comment, toNano } from "@ton/core";
import {
  Configuration,
  EntityApi,
  RoutingApi,
  type ApiSwapTransaction,
  type ApiToken
} from "@swap-coffee/sdk";
import type { AgentIntent, ExecutionPlan } from "@/lib/types";
import { prepareTransferViaWalletMcp } from "@/lib/wallet-mcp";

const config = new Configuration();
const entityApi = new EntityApi(config);
const routingApi = new RoutingApi(config);
const tonApiKey = process.env.TON_API_KEY;
const dnsEndpoint =
  process.env.TON_API_V3_DNS_ENDPOINT ?? "https://toncenter.com/api/v3/dns/records";

function toUserFriendlyAddress(address: string) {
  return Address.parse(address).toString({
    bounceable: true,
    urlSafe: true
  });
}

async function resolveDnsRecipient(domain: string) {
  const url = new URL(dnsEndpoint);
  url.searchParams.set("domain", domain.toLowerCase());
  url.searchParams.set("limit", "1");

  const response = await fetch(url, {
    headers: tonApiKey ? { "X-API-Key": tonApiKey } : undefined,
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`TON DNS API returned ${response.status}`);
  }

  const payload = (await response.json()) as {
    records?: Array<{
      dns_wallet?: string | null;
    }>;
  };

  return payload.records?.[0]?.dns_wallet ?? null;
}

export async function getListedTokenBySymbol(symbol: string): Promise<ApiToken | null> {
  const result = await entityApi.getTokensBySymbol("ton", symbol.toUpperCase());
  const listed = result.data.find((token: ApiToken) => token.metadata.listed);
  return listed ?? result.data[0] ?? null;
}

export async function getSwapCoffeeTokenMetadata(address: string) {
  const token = (await entityApi.getToken("ton", address)).data;

  return {
    symbol: token.symbol ?? undefined,
    name: token.metadata?.name ?? token.symbol ?? undefined,
    decimals: token.decimals ?? token.metadata?.decimals ?? undefined
  };
}

export async function getSwapCoffeeQuote(
  fromSymbol: string,
  toSymbol: string,
  amount: number,
  walletAddress?: string
) {
  if (!Number.isFinite(amount) || amount <= 0) {
    return null;
  }

  const normalizedFrom = fromSymbol.toUpperCase();
  const normalizedTo = toSymbol.toUpperCase();

  const [inputToken, outputToken] = await Promise.all([
    getListedTokenBySymbol(normalizedFrom),
    getListedTokenBySymbol(normalizedTo)
  ]);

  if (!inputToken || !outputToken) {
    return null;
  }

  const route = (
    await routingApi.buildRoute({
      input_token: inputToken.address,
      output_token: outputToken.address,
      input_amount: amount,
      max_splits: 4,
      max_length: 3,
      mev_protection: false,
      additional_data: walletAddress
        ? {
            sender_address: walletAddress
          }
        : undefined
    })
  ).data;

  return {
    inputAmount: route.input_amount,
    outputAmount: roundValue(route.output_amount) ?? route.output_amount,
    inputSymbol: normalizedFrom,
    outputSymbol: normalizedTo,
    recommendedGasTon: getDisplayRecommendedGas(route.recommended_gas, route.input_amount),
    priceImpactPct: roundValue(route.price_impact, 4),
    paths: route.paths
  };
}

function roundValue(value: number | undefined, fractionDigits = 6) {
  if (value === undefined || Number.isNaN(value)) {
    return undefined;
  }

  return Number(value.toFixed(fractionDigits));
}

function getDisplayRecommendedGas(
  recommendedGas: number | undefined,
  inputAmount: number | undefined
) {
  if (
    recommendedGas === undefined ||
    Number.isNaN(recommendedGas) ||
    recommendedGas <= 0
  ) {
    return undefined;
  }

  if (inputAmount !== undefined && recommendedGas >= inputAmount * 0.5) {
    return undefined;
  }

  return roundValue(recommendedGas, 4);
}

function isHttpStatusError(error: unknown, status: number) {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.message.includes(`status code ${status}`) ||
    error.message.includes(`returned ${status}`) ||
    error.message.includes(`status ${status}`)
  );
}

function getExecutionErrorSummary(intent: AgentIntent, error: unknown) {
  if (intent.action === "send") {
    if (isHttpStatusError(error, 404)) {
      return "Could not prepare the transfer: the external service could not find the required route or resource.";
    }

    return "Could not prepare the transfer right now. Try again in a few seconds.";
  }

  if (isHttpStatusError(error, 404)) {
    return "Could not prepare the swap: the external quote or route endpoint returned 404. Try another token pair or try again later.";
  }

  return "Could not prepare the swap right now. Try again in a few seconds.";
}

export async function buildExecutionPlan(
  intent: AgentIntent,
  walletAddress?: string
): Promise<ExecutionPlan | undefined> {
  if (intent.action === "unknown") {
    return undefined;
  }

  if (intent.action === "send" && (!intent.recipient || !intent.amount || intent.amount <= 0)) {
    return {
      kind: "transfer",
      status: "unsupported",
      protocol: "ton-transfer",
      summary: "A transfer requires a valid recipient address and an amount greater than zero."
    };
  }

  if (
    (intent.action === "swap" || intent.action === "sell" || intent.action === "buy") &&
    (!intent.amount || intent.amount <= 0)
  ) {
    return {
      kind: "swap",
      status: "unsupported",
      protocol: "swap.coffee",
      summary: "A swap requires an amount greater than zero."
    };
  }

  if (!walletAddress) {
    return {
      kind: intent.action === "send" ? "transfer" : "swap",
      status: "needs_wallet",
      protocol: intent.action === "send" ? "ton-transfer" : "swap.coffee",
      summary: "Connect a TON wallet first. After that, the agent can prepare and send a signature request."
    };
  }

  if (intent.action === "send") {
    const recipientInput = intent.recipient!;
    const amount = intent.amount!;
    let resolvedRecipient: string | null;

    try {
      resolvedRecipient = recipientInput.toLowerCase().endsWith(".ton")
        ? await resolveDnsRecipient(recipientInput)
        : recipientInput;
    } catch (error) {
      return {
        kind: "transfer",
        status: "unsupported",
        protocol: "ton-transfer",
        summary: getExecutionErrorSummary(intent, error)
      };
    }

    if (!resolvedRecipient) {
      return {
        kind: "transfer",
        status: "unsupported",
        protocol: "ton-transfer",
        summary: `Could not resolve TON DNS name ${intent.recipient} to a wallet address.`
      };
    }

    const recipient = toUserFriendlyAddress(resolvedRecipient);
    const mcpExecution = await prepareTransferViaWalletMcp({
      walletAddress,
      recipient,
      amount,
      comment: intent.comment
    }).catch(() => null);

    if (mcpExecution) {
      return {
        ...mcpExecution,
        summary:
          mcpExecution.summary ||
          `Prepared a transfer of ${amount} ${intent.fromToken ?? "TON"} to ${recipientInput}${intent.comment ? ` with comment "${intent.comment}"` : ""}. You can now open the wallet for confirmation.`
      };
    }

    const transferMessage = {
      address: recipient,
      amount: toNano(amount).toString(),
      payload: intent.comment
        ? comment(intent.comment).toBoc().toString("base64")
        : undefined
    };

    return {
      kind: "transfer",
      status: "ready",
      protocol: "ton-transfer",
      summary: `Prepared a transfer of ${amount} ${intent.fromToken ?? "TON"} to ${recipientInput}${intent.comment ? ` with comment "${intent.comment}"` : ""}. You can now open the wallet for confirmation.`,
      validUntil: Math.floor(Date.now() / 1000) + 600,
      messages: [transferMessage],
      quote: {
        inputAmount: amount,
        outputAmount: amount,
        inputSymbol: intent.fromToken ?? "TON",
        outputSymbol: intent.fromToken ?? "TON"
      }
    };
  }

  if (intent.action === "buy") {
    return {
      kind: "swap",
      status: "unsupported",
      protocol: "swap.coffee",
      summary: "Live execution is currently enabled for swap and sell commands based on the input amount. For buy commands, it is better to phrase the request like `swap 5 TON to USDT`."
    };
  }

  const fromSymbol = (intent.fromToken ?? "TON").toUpperCase();
  const toSymbol = (intent.toToken ?? (intent.action === "sell" ? "USDT" : "TON")).toUpperCase();
  const amount = intent.amount!;

  let quote;

  try {
    quote = await getSwapCoffeeQuote(fromSymbol, toSymbol, amount, walletAddress);
  } catch (error) {
    return {
      kind: "swap",
      status: "unsupported",
      protocol: "swap.coffee",
      summary: getExecutionErrorSummary(intent, error)
    };
  }

  if (!quote) {
    return {
      kind: "swap",
      status: "unsupported",
      protocol: "swap.coffee",
      summary: `Could not find tokens ${fromSymbol}/${toSymbol} in swap.coffee.`
    };
  }

  let transactions;

  try {
    transactions = (
      await routingApi.buildTransactionsV2({
        sender_address: walletAddress,
        slippage: 1,
        paths: quote.paths
      })
    ).data;
  } catch (error) {
    return {
      kind: "swap",
      status: "unsupported",
      protocol: "swap.coffee",
      summary: getExecutionErrorSummary(intent, error)
    };
  }

  return {
    kind: "swap",
    status: "ready",
    protocol: "swap.coffee",
    summary: `Prepared a swap via swap.coffee: ${quote.inputAmount} ${fromSymbol} -> ${quote.outputAmount} ${toSymbol}. You can now open the wallet for confirmation.`,
    validUntil: Math.floor(Date.now() / 1000) + 600,
    routeId: transactions.route_id,
    quote,
    messages: transactions.transactions.map((transaction: ApiSwapTransaction) => ({
      address: toUserFriendlyAddress(transaction.address),
      amount: transaction.value,
      payload: transaction.cell,
      stateInit: transaction.stateInit
    }))
  };
}
