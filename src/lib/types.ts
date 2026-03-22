export type Role = "user" | "assistant";

export type AgentIntent = {
  action:
    | "swap"
    | "sell"
    | "buy"
    | "send"
    | "balance"
    | "nft"
    | "username_price"
    | "fee_estimate"
    | "token_research"
    | "address_check"
    | "contract_explain"
    | "unknown";
  amount?: number;
  fromToken?: string;
  toToken?: string;
  recipient?: string;
  query?: string;
  comment?: string;
  needsWallet: boolean;
  needsConfirmation: boolean;
  protocol?: "swap.coffee";
  summary: string;
  safetyNotes: string[];
};

export type WalletMessage = {
  address: string;
  amount: string;
  payload?: string;
  stateInit?: string;
};

export type ExecutionPlan = {
  kind: "swap" | "transfer";
  status: "ready" | "needs_wallet" | "unsupported";
  protocol?: "swap.coffee" | "ton-transfer";
  summary: string;
  validUntil?: number;
  routeId?: number;
  quote?: {
    inputAmount: number;
    outputAmount: number;
    inputSymbol: string;
    outputSymbol: string;
    recommendedGasTon?: number;
    priceImpactPct?: number;
  };
  messages?: WalletMessage[];
};

export type PortfolioAsset = {
  symbol: string;
  name?: string;
  amount: string;
  unitPriceUsdt?: string;
  totalValueUsdt?: string;
  hasReadableMetadata?: boolean;
};

export type PortfolioData = {
  ton: PortfolioAsset;
  tokens: PortfolioAsset[];
  unknownTokens?: PortfolioAsset[];
  totalValueUsdt?: string;
  hiddenTokenCount?: number;
};

export type NftAsset = {
  address: string;
  name?: string;
  collectionName?: string;
  collectionAddress?: string;
  index?: string;
  imageUrl?: string;
  contentUrl?: string;
  marketplaceUrl?: string;
  collectionUrl?: string;
  onSale?: boolean;
};

export type NftGalleryData = {
  items: NftAsset[];
  totalCount: number;
  hiddenCount?: number;
};

export type UnderstandingData = {
  normalizedRequest: string;
  confidence?: "low" | "medium" | "high";
};

export type FeeEstimateData = {
  estimatedFeeTon: string;
  basis: string;
  amount?: string;
  recipient?: string;
  comment?: string;
};

export type ChatMessage = {
  id: string;
  role: Role;
  text: string;
  createdAt: string;
  intent?: AgentIntent;
  execution?: ExecutionPlan;
  portfolio?: PortfolioData;
  nftGallery?: NftGalleryData;
  feeEstimate?: FeeEstimateData;
  understanding?: UnderstandingData;
};
