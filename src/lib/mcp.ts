export type TonMcpProfile = {
  hackathonMode: boolean;
  docsMcpUrl: string;
  docsSearchEnabled: boolean;
  walletMcpHttpUrl?: string;
  walletMcpEnabled: boolean;
};

function isTruthy(value: string | undefined) {
  if (!value) {
    return false;
  }

  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export function getTonMcpProfile(): TonMcpProfile {
  const docsMcpUrl = process.env.TON_DOCS_MCP_URL?.trim() || "https://docs.ton.org/mcp";
  const configuredWalletMcpUrl = process.env.TON_MCP_HTTP_URL?.trim();
  const appBaseUrl = process.env.NEXT_PUBLIC_APP_URL?.trim();
  const walletMcpHttpUrl = configuredWalletMcpUrl
    ? configuredWalletMcpUrl
    : appBaseUrl
      ? `${appBaseUrl.replace(/\/$/, "")}/api/wallet-mcp`
      : undefined;

  return {
    hackathonMode: isTruthy(process.env.TON_HACKATHON_MODE) || Boolean(walletMcpHttpUrl),
    docsMcpUrl,
    docsSearchEnabled: Boolean(docsMcpUrl),
    walletMcpHttpUrl,
    walletMcpEnabled: Boolean(walletMcpHttpUrl)
  };
}

export function getMcpStatusLine(language: "ru" | "en", profile = getTonMcpProfile()) {
  return profile.walletMcpEnabled
    ? `TON Docs MCP is configured (${profile.docsMcpUrl}) and wallet MCP HTTP is enabled.`
    : `TON Docs MCP is configured (${profile.docsMcpUrl}). Wallet MCP HTTP is not configured yet.`;
}

export function getCapabilitiesText(language: "ru" | "en", profile = getTonMcpProfile()) {
  const lines = [
    "I can check wallet balances, show recent transactions, show tokens and NFTs, prepare TON transfers and swaps, review tokens and addresses, explain contracts, estimate fees, and look up Telegram username prices."
  ];

  if (profile.hackathonMode) {
    // Keep internal deployment mode out of user-facing copy.
  }

  return lines.join(" ");
}
