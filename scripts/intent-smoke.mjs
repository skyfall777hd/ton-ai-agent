const appUrl = process.env.APP_URL ?? "http://127.0.0.1:3459";

const cases = [
  ["Send 1 TON to this address", "send"],
  ["Transfer 2 TON to EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c", "send"],
  ["Send 1 TON with comment happy birthday", "send"],
  ["What NFTs do I have?", "nft"],
  ["Show my NFT collection", "nft"],
  ["How much TON is in my wallet right now?", "balance"],
  ["What is my TON balance?", "balance"],
  ["Show all tokens in my wallet", "balance"],
  ["Convert 4 TON to USDT", "swap"],
  ["Swap 3 TON to USDT", "swap"],
  ["Sell 5 TON", "sell"],
  ["I want to buy 25 USDT", "buy"],
  ["What is the network fee for sending 3 TON?", "fee_estimate"],
  ["How much is the fee to send 1 TON?", "fee_estimate"],
  ["Check this token USDT", "token_research"],
  ["Is this token a scam USDT?", "token_research"],
  ["Is this address safe EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c?", "address_check"],
  ["Can you explain this smart contract?", "contract_explain"],
  ["What does this contract do EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c?", "contract_explain"],
  ["How much does a Telegram username cost?", "username_price"],
  ["How much does username durov cost?", "username_price"],
  ["Price of @durov", "username_price"]
];

let failed = 0;

for (const [prompt, expected] of cases) {
  const response = await fetch(`${appUrl}/api/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      message: prompt,
      walletConnected: false
    })
  });

  const raw = await response.text();
  let payload;

  try {
    payload = JSON.parse(raw);
  } catch {
    payload = { raw };
  }

  const actual = payload.intent?.action ?? null;
  const ok = response.ok && actual === expected;

  if (!ok) {
    failed += 1;
  }

  console.log(
    `${ok ? "PASS" : "FAIL"} | expected=${expected} actual=${actual} | ${prompt}`
  );
}

if (failed > 0) {
  process.exitCode = 1;
}
