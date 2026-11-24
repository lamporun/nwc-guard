// @ts-check
// End to end over a real relay: an agent (NWCClient) talks to the guard's
// connection through wss://relay.getalby.com/v1; the guard decides and pays
// with a fake wallet. No real sats move. Run: node dev/e2e-relay.js
import { NWCClient } from "@getalby/sdk/nwc";
import { Guard, withDefaults } from "../src/guard.js";
import { connectionUrl, newConnection, serve } from "../src/service.js";
import { AuditLog, PaymentState } from "../src/store.js";
import { EVIL_KEY, fakeUpstream, invoiceFor, pubkeyOf, SHOP_KEY } from "../test/helpers.js";

const relays = [process.env.RELAY ?? "wss://relay.getalby.com/v1"];
const connection = { ...newConnection("agent"), rules: withDefaults({ payees: { mode: "allowlist", allow: [pubkeyOf(SHOP_KEY)] }, maxPaymentsPerMinute: 3 }) };
const upstream = fakeUpstream();
const guard = new Guard({ upstream, state: new PaymentState(null), audit: new AuditLog(null), approver: { ask: async () => "deny" }, rulesFor: () => withDefaults(connection.rules) });
const stop = await serve({ connections: [connection], relays, guard });
const agent = new NWCClient({ nostrWalletConnectUrl: connectionUrl(connection, relays) });

let ok = true;
const check = (/** @type {string} */ what, /** @type {boolean} */ cond) => {
	console.log(`${cond ? "✓" : "✗"} ${what}`);
	ok &&= cond;
};
try {
	const info = await agent.getInfo();
	check(`get_info answers as "${info.alias}" with ${info.methods.length} methods`, info.methods.includes("pay_invoice"));
	const paid = await agent.payInvoice({ invoice: invoiceFor().invoice });
	check("a payment to the allowlisted shop goes through", typeof paid.preimage === "string" && upstream.paid.length === 1);
	const attack = await agent.payInvoice({ invoice: invoiceFor({ key: EVIL_KEY }).invoice }).then(() => "paid", (e) => `${e.code}: ${e.message}`);
	check(`a payment to an unknown payee is refused (${attack.slice(0, 70)}…)`, attack.startsWith("RESTRICTED") && upstream.paid.length === 1);
	const big = await agent.payInvoice({ invoice: invoiceFor({ sats: 5_000 }).invoice }).then(() => "paid", (e) => e.code);
	check(`a payment above the cap is refused (${big})`, big === "QUOTA_EXCEEDED");
	const keysend = await agent.payKeysend({ amount: 1000, pubkey: pubkeyOf(EVIL_KEY) }).then(() => "paid", (e) => e.code);
	check(`keysend is blocked (${keysend})`, keysend === "NOT_IMPLEMENTED");
	const { balance } = await agent.getBalance();
	check(`the agent sees today's remaining budget as its balance (${balance / 1000} sats)`, balance === (10_000 - 1_002) * 1000);
} catch (err) {
	ok = false;
	console.error(err);
} finally {
	agent.close();
	stop();
}
console.log(ok ? "E2E OK" : "E2E FAILED");
process.exit(ok ? 0 : 1);
