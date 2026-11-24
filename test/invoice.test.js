// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import bolt11 from "bolt11";
import { parseInvoice, payeeOf } from "../src/invoice.js";
import { EVIL_KEY, invoiceFor, pubkeyOf, SHOP_KEY } from "./helpers.js";

test("the payee is recovered from the invoice signature", () => {
	const { invoice } = invoiceFor();
	assert.equal(payeeOf(invoice), pubkeyOf(SHOP_KEY));
	assert.equal(payeeOf(invoice), bolt11.decode(invoice).payeeNodeKey);
	assert.equal(payeeOf(invoiceFor({ key: EVIL_KEY }).invoice), pubkeyOf(EVIL_KEY));
	assert.notEqual(pubkeyOf(SHOP_KEY), pubkeyOf(EVIL_KEY));
});

test("parseInvoice reads amount, hash, expiry and description", () => {
	const { invoice, hash } = invoiceFor({ sats: 1_500, description: "bundle", expireSeconds: 300 });
	const parsed = parseInvoice(invoice);
	assert.equal(parsed.paymentHash, hash);
	assert.equal(parsed.amountSat, 1_500);
	assert.equal(parsed.description, "bundle");
	assert.ok(parsed.expiresAt > Date.now() && parsed.expiresAt <= Date.now() + 300_000);
	assert.equal(parseInvoice(invoiceFor({ sats: null }).invoice).amountSat, null);
	assert.throws(() => parseInvoice("not an invoice"));
	assert.throws(() => parseInvoice(`${invoice.slice(0, -3)}qqq`));
});
