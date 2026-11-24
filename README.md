# nwc-guard

**A spending firewall between AI agents and your Lightning wallet.**

Agents are getting wallets: an MCP server with your Nostr Wallet Connect string, an OpenClaw skill, [l402-bridge](https://github.com/lamporun/l402-bridge) paying for inference. An agent can be tricked. A web page, an email or a tool result can tell it to "pay this invoice", and NWC budgets don't stop an attacker who stays under the limit, or who drains the wallet in many small payments.

nwc-guard sits in between. The agent gets an NWC connection that points to the guard. The guard checks every request against your rules, asks you on your phone when the rules say so, and only then calls your real wallet.

```
agent ──NWC──▶ nwc-guard ──NWC──▶ your wallet (Alby Hub, Minibits, Zeus, Coinos…)
                  │
                  └── "Pay 5,000 sats to an unknown node?"  ✅ / ❌  ──▶ your phone (Telegram)
```

> Early software, built with the same care as the money it guards. Start with small limits.

## What it checks

For every `pay_invoice`, in order:

1. **Paused?** `/stop` on Telegram, or a `STOP` file in the data directory, refuses every payment until you resume.
2. **The invoice itself.** It must be readable and unexpired, and it must carry an amount (amountless invoices are refused unless you allow them). An `amount` that differs from the invoice's is refused.
3. **No double payment.** An invoice already paid or attempted through the guard is refused, including one whose outcome is still unknown after a wallet timeout.
4. **Amount and budgets.** A per-payment cap, plus rolling hourly and daily budgets that count fees and payments still pending.
5. **Rate.** At most N payments a minute, which stops drains made of many small payments.
6. **Payee.** The payee is the node that signed the invoice, recovered from its signature. Choose one of three modes:
   - `ask`: new payees need your approval;
   - `allowlist`: unknown payees are refused;
   - `any`: payees are not checked.
7. **Approval.** Payments to a new payee (in `ask` mode), or above `approveAbove` sats, wait for your ✅ or ❌. You have two minutes, after which the answer is no. "✅ Always" also adds the payee to the allowlist.

Everything else an agent can call is narrowed too:
- `get_balance` returns what the agent may still spend today, capped by the real balance;
- `list_transactions` returns the agent's own payments only, never the wallet's history;
- `pay_keysend`, `sign_message` and the hold-invoice methods are blocked.

Every decision goes to an audit log, and invoices and preimages are never logged.

## Quick start

You need Node.js 22 or newer and a wallet NWC connection that can pay invoices.

```sh
# 1. Create a guarded connection for your agent and copy the string it prints
npx github:lamporun/nwc-guard init --name openclaw

# 2. Optionally trust payees in advance (a node key, or an invoice from that payee)
npx github:lamporun/nwc-guard allow openclaw 03abc... "my shop"

# 3. Run the guard in front of your real wallet
export NWC_UPSTREAM_URL="nostr+walletconnect://..."      # your wallet's own connection
export NWC_GUARD_TELEGRAM_TOKEN="123456:ABC..."          # optional: a bot only nwc-guard uses
export NWC_GUARD_TELEGRAM_CHAT="your chat id"
npx github:lamporun/nwc-guard start      # --approval-timeout 300 to wait longer than 2 minutes
```

Give the agent the string from step 1 instead of your wallet's. To get a Telegram bot, ask [@BotFather](https://t.me/BotFather) for one, send it a message, and read your chat id from `https://api.telegram.org/bot<token>/getUpdates`. Without Telegram, approvals are asked in the terminal the guard runs in; without a terminal, anything needing approval is refused.

## Rules

Each connection has its rules in `~/.nwc-guard/config.json`, with these defaults:

```json
{
  "maxSatsPerPayment": 1000,
  "budgets": { "hour": 3000, "day": 10000 },
  "maxPaymentsPerMinute": 5,
  "payees": { "mode": "ask", "allow": [], "names": {} },
  "approveAbove": null,
  "allowAmountless": false,
  "allowGetBalance": true,
  "allowMakeInvoice": true
}
```

Use one connection per agent, so each has its own limits and its own audit trail, and revoking one doesn't touch the others. Restart the guard after editing the file.

**A note on payees.** Most nodes sign every invoice with the same key, so trusting a payee works across its invoices. Some wallets sign each invoice with a fresh key for privacy, Wavelength's receive invoices among them. For those payees an allowlist entry matches only that one invoice. Rely on approval and the amount and budget limits instead. The approval message shows the node the payment is routed through, for example "Lightning Labs Loop (Wavelength receives)", to help you decide.

## Tested on mainnet

On 2026-11-24 the guard ran between [l402-bridge](https://github.com/lamporun/l402-bridge) and a [Minibits](https://www.minibits.cash/) wallet, buying inference from https://lampo.run with real sats:

| Step | Result |
|---|---|
| The bridge asks for a DeepSeek V4 Flash bundle (1,000 sats, new payee) | the guard asked on Telegram, the owner pressed ✅, Minibits paid, and the answer arrived in 23.6 s including the approval |
| A second request | the bundle was reused, nothing paid, 0.6 s |
| A Kimi K3 bundle (3,000 sats), allowed by the bridge's own limit | refused by the guard (`QUOTA_EXCEEDED`: above 1,000 per payment) without asking, nothing paid |

## With l402-bridge

[l402-bridge](https://github.com/lamporun/l402-bridge) lets any OpenAI-compatible tool pay for inference over L402. Point it at the guard to add an approval step and payee rules to its own limits:

```sh
NWC_URL="$(npx github:lamporun/nwc-guard url openclaw)" npx github:lamporun/l402-bridge
```

## Development

```sh
npm install
npm test               # rules, approvals (with a fake Telegram API), invoice parsing
npm run check          # type check
node dev/e2e-relay.js  # an agent and the guard over a real Nostr relay, with a fake wallet
```

## License

MIT. It is built on Alby's [`@getalby/sdk`](https://github.com/getAlby/js-sdk) for NWC, and the payee is recovered with [`@noble/curves`](https://github.com/paulmillr/noble-curves). Made by [Lampo](https://lampo.run).
