// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { NwcError } from "../src/guard.js";
import { EVIL_KEY, fakeUpstream, invoiceFor, makeGuard, pubkeyOf, SHOP_KEY } from "./helpers.js";

const SHOP = pubkeyOf(SHOP_KEY);

/**
 * refused asserts that a promise is rejected with a NIP-47 code.
 *
 * @param {Promise<unknown>} promise
 * @param {string} code
 * @param {RegExp} [message]
 */
async function refused(promise, code, message) {
	await assert.rejects(promise, (err) => {
		assert.ok(err instanceof NwcError, `NwcError, got ${err}`);
		assert.equal(err.code, code);
		if (message) {
			assert.match(err.message, message);
		}
		return true;
	});
}

test("an allowlisted payee is paid without asking", async () => {
	const { guard, upstream, asked } = makeGuard({ rules: { payees: { mode: "ask", allow: [SHOP] } } });
	const { invoice } = invoiceFor();
	const result = await guard.handle("agent", "pay_invoice", { invoice });
	assert.ok(result.preimage);
	assert.equal(upstream.paid.length, 1);
	assert.equal(asked.length, 0);
});

test("a new payee needs approval, and a denial pays nothing", async () => {
	const { guard, upstream, asked } = makeGuard({ answers: ["deny"] });
	await refused(guard.handle("agent", "pay_invoice", { invoice: invoiceFor({ key: EVIL_KEY }).invoice }), "RESTRICTED", /did not approve/);
	assert.equal(asked.length, 1);
	assert.equal(asked[0].payee, pubkeyOf(EVIL_KEY));
	assert.equal(asked[0].reason, "new payee");
	assert.equal(upstream.paid.length, 0);
});

test("approve pays once; approve-always remembers the payee", async () => {
	const { guard, upstream, asked, rules } = makeGuard({ answers: ["approve", "approve-always"] });
	await guard.handle("agent", "pay_invoice", { invoice: invoiceFor({ sats: 500 }).invoice });
	assert.equal(rules().payees.allow.length, 0);
	await guard.handle("agent", "pay_invoice", { invoice: invoiceFor({ sats: 500 }).invoice });
	assert.deepEqual(rules().payees.allow, [SHOP]);
	await guard.handle("agent", "pay_invoice", { invoice: invoiceFor({ sats: 500 }).invoice });
	assert.equal(asked.length, 2, "the third payment to a remembered payee is not asked about");
	assert.equal(upstream.paid.length, 3);
});

test("in allowlist mode an unknown payee is refused outright", async () => {
	const { guard, upstream, asked } = makeGuard({ rules: { payees: { mode: "allowlist", allow: [SHOP] } } });
	await refused(guard.handle("agent", "pay_invoice", { invoice: invoiceFor({ key: EVIL_KEY }).invoice }), "RESTRICTED", /not on this connection's allowlist/);
	assert.equal(asked.length, 0);
	assert.equal(upstream.paid.length, 0);
});

test("large payments to a trusted payee still ask when approveAbove is set", async () => {
	const { guard, asked } = makeGuard({ rules: { payees: { mode: "any", allow: [] }, approveAbove: 500 }, answers: ["approve"] });
	await guard.handle("agent", "pay_invoice", { invoice: invoiceFor({ sats: 400 }).invoice });
	await guard.handle("agent", "pay_invoice", { invoice: invoiceFor({ sats: 900 }).invoice });
	assert.equal(asked.length, 1);
	assert.equal(asked[0].reason, "above 500 sats");
});

test("the per-payment cap, the budgets and the rate limit hold", async () => {
	const any = { payees: { mode: /** @type {const} */ ("any"), allow: [] } };
	const cap = makeGuard({ rules: { ...any, maxSatsPerPayment: 1_000 } });
	await refused(cap.guard.handle("agent", "pay_invoice", { invoice: invoiceFor({ sats: 1_001 }).invoice }), "QUOTA_EXCEEDED", /above the limit/);

	const hourly = makeGuard({ rules: { ...any, budgets: { hour: 2_500, day: 10_000 } } });
	await hourly.guard.handle("agent", "pay_invoice", { invoice: invoiceFor().invoice });
	await hourly.guard.handle("agent", "pay_invoice", { invoice: invoiceFor().invoice });
	// 2 × (1,000 + 2 sats fee) used: a third 1,000 would pass 2,500.
	await refused(hourly.guard.handle("agent", "pay_invoice", { invoice: invoiceFor().invoice }), "QUOTA_EXCEEDED", /hourly budget of 2500 sats/);

	const rate = makeGuard({ rules: { ...any, maxSatsPerPayment: 100, budgets: { hour: 100_000, day: 100_000 }, maxPaymentsPerMinute: 3 } });
	for (let i = 0; i < 3; i++) {
		await rate.guard.handle("agent", "pay_invoice", { invoice: invoiceFor({ sats: 10 }).invoice });
	}
	await refused(rate.guard.handle("agent", "pay_invoice", { invoice: invoiceFor({ sats: 10 }).invoice }), "RATE_LIMITED");
	assert.equal(rate.upstream.paid.length, 3, "a drain in many small payments stops at the rate limit");
});

test("budgets roll: an hour later the hourly budget is free again", async () => {
	let now = Date.now();
	const { guard } = makeGuard({ rules: { payees: { mode: "any", allow: [] }, budgets: { hour: 1_500, day: 10_000 } }, now: () => now });
	await guard.handle("agent", "pay_invoice", { invoice: invoiceFor().invoice });
	await refused(guard.handle("agent", "pay_invoice", { invoice: invoiceFor().invoice }), "QUOTA_EXCEEDED");
	now += 61 * 60 * 1000;
	await guard.handle("agent", "pay_invoice", { invoice: invoiceFor({ expireSeconds: 7_200 }).invoice });
});

test("the same invoice is never paid twice, even after a timeout", async () => {
	const ok = makeGuard({ rules: { payees: { mode: "any", allow: [] } } });
	const { invoice } = invoiceFor();
	await ok.guard.handle("agent", "pay_invoice", { invoice });
	await refused(ok.guard.handle("agent", "pay_invoice", { invoice }), "RESTRICTED", /already paid or attempted/);

	const slow = makeGuard({ rules: { payees: { mode: "any", allow: [] } }, upstream: fakeUpstream({ mode: "timeout" }) });
	const second = invoiceFor().invoice;
	await refused(slow.guard.handle("agent", "pay_invoice", { invoice: second }), "INTERNAL", /did not confirm/);
	await refused(slow.guard.handle("agent", "pay_invoice", { invoice: second }), "RESTRICTED", /already paid or attempted/);
	assert.equal(slow.upstream.paid.length, 1);
	// The unknown payment keeps counting against the budget.
	assert.equal(slow.guard.committedSince("agent", 0), 1_000);
});

test("a definite wallet failure frees the budget and passes the code on", async () => {
	const { guard } = makeGuard({ rules: { payees: { mode: "any", allow: [] } }, upstream: fakeUpstream({ mode: "insufficient" }) });
	await refused(guard.handle("agent", "pay_invoice", { invoice: invoiceFor().invoice }), "INSUFFICIENT_BALANCE");
	assert.equal(guard.committedSince("agent", 0), 0);
});

test("expired, amountless and mismatched invoices are refused", async () => {
	const { guard, upstream } = makeGuard({ rules: { payees: { mode: "any", allow: [] } } });
	await refused(guard.handle("agent", "pay_invoice", { invoice: invoiceFor({ ageSeconds: 700, expireSeconds: 600 }).invoice }), "OTHER", /expired/);
	await refused(guard.handle("agent", "pay_invoice", { invoice: invoiceFor({ sats: null }).invoice, amount: 5_000 }), "RESTRICTED", /without an amount/);
	await refused(guard.handle("agent", "pay_invoice", { invoice: invoiceFor({ sats: 100 }).invoice, amount: 900_000 }), "RESTRICTED", /differs/);
	await refused(guard.handle("agent", "pay_invoice", { invoice: "lnbc1garbage" }), "OTHER", /could not be read/);
	assert.equal(upstream.paid.length, 0);
});

test("the owner's pause stops every payment", async () => {
	const { guard, upstream } = makeGuard({ rules: { payees: { mode: "any", allow: [] } }, paused: true });
	await refused(guard.handle("agent", "pay_invoice", { invoice: invoiceFor().invoice }), "RESTRICTED", /paused/);
	assert.equal(upstream.paid.length, 0);
});

test("parallel requests cannot slip past the budget while one waits for approval", async () => {
	/** @type {(a: "approve") => void} */
	let release = () => {};
	const { guard, upstream } = makeGuard({ rules: { budgets: { hour: 1_500, day: 10_000 } } });
	guard.approver = { ask: () => new Promise((r) => (release = r)) };
	const first = guard.handle("agent", "pay_invoice", { invoice: invoiceFor().invoice });
	await new Promise((r) => setImmediate(r));
	await refused(guard.handle("agent", "pay_invoice", { invoice: invoiceFor().invoice }), "QUOTA_EXCEEDED");
	release("approve");
	await first;
	assert.equal(upstream.paid.length, 1);
});

test("the agent sees its own payments and what it may still spend, nothing else", async () => {
	const { guard } = makeGuard({ rules: { payees: { mode: "any", allow: [] }, budgets: { hour: 3_000, day: 2_500 } } });
	await guard.handle("agent", "pay_invoice", { invoice: invoiceFor().invoice });
	const { balance } = await guard.handle("agent", "get_balance");
	assert.equal(balance, (2_500 - 1_002) * 1000, "the balance shown is today's remaining budget");
	const { transactions } = await guard.handle("agent", "list_transactions", {});
	assert.equal(transactions.length, 1);
	assert.equal(transactions[0].state, "settled");
	assert.deepEqual((await guard.handle("other", "list_transactions", {})).transactions, []);
	const info = await guard.handle("agent", "get_info");
	assert.match(info.alias, /^nwc-guard \(Fake wallet\)$/);
	assert.ok(info.methods.includes("pay_invoice"));
	await refused(guard.handle("agent", "pay_keysend", {}), "NOT_IMPLEMENTED");
	await refused(guard.handle("agent", "sign_message", {}), "NOT_IMPLEMENTED");
});

test("every decision is written to the audit log, without the invoice itself", async () => {
	const { guard, entries } = makeGuard({ rules: { payees: { mode: "allowlist", allow: [SHOP] } } });
	const { invoice } = invoiceFor();
	await guard.handle("agent", "pay_invoice", { invoice });
	await guard.handle("agent", "pay_invoice", { invoice: invoiceFor({ key: EVIL_KEY }).invoice }).catch(() => {});
	assert.deepEqual(
		entries.map((e) => e.decision),
		["paid", "denied"],
	);
	assert.ok(!JSON.stringify(entries).includes(invoice));
});
