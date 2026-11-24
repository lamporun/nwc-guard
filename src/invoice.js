// @ts-check
// What the guard needs to know about an invoice before it lets a payment
// through: who gets paid (the payee node key, recovered from the invoice's
// signature), how much, the payment hash, and whether it has expired.

import { createRequire } from "node:module";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { decode } from "light-bolt11-decoder";

const require = createRequire(import.meta.url);
const { bech32 } = /** @type {{ bech32: { decode(s: string, limit?: number): { prefix: string, words: number[] }, fromWords(w: number[]): number[] } }} */ (
	require("@scure/base")
);

// SIGNATURE_WORDS is the length of a BOLT11 signature in 5-bit words:
// 64 bytes of signature and one recovery byte.
const SIGNATURE_WORDS = 104;

/**
 * wordsToBytes packs 5-bit words into bytes, padding the last byte with
 * zero bits, as BOLT11 does for the signed data.
 *
 * @param {number[]} words
 */
function wordsToBytes(words) {
	const out = [];
	let acc = 0;
	let bits = 0;
	for (const word of words) {
		acc = ((acc << 5) | word) & 0xffffff;
		bits += 5;
		while (bits >= 8) {
			bits -= 8;
			out.push((acc >> bits) & 0xff);
		}
	}
	if (bits > 0) {
		out.push((acc << (8 - bits)) & 0xff);
	}
	return Uint8Array.from(out);
}

/**
 * payeeOf recovers the compressed public key of the node that signed the
 * invoice, which is the node that gets paid.
 *
 * @param {string} invoice
 * @returns {string} 33-byte compressed key, hex
 */
export function payeeOf(invoice) {
	const { prefix, words } = bech32.decode(invoice.toLowerCase(), 4096);
	if (words.length <= SIGNATURE_WORDS) {
		throw new Error("invoice too short");
	}
	const signature = Uint8Array.from(bech32.fromWords(words.slice(-SIGNATURE_WORDS)));
	const data = wordsToBytes(words.slice(0, -SIGNATURE_WORDS));
	const message = new Uint8Array(prefix.length + data.length);
	message.set(new TextEncoder().encode(prefix), 0);
	message.set(data, prefix.length);
	const recovered = new Uint8Array(65);
	recovered[0] = signature[64];
	recovered.set(signature.subarray(0, 64), 1);
	const point = secp256k1.Signature.fromBytes(recovered, "recovered").recoverPublicKey(sha256(message));
	return Buffer.from(point.toBytes(true)).toString("hex");
}

/**
 * @typedef {{
 *   paymentHash: string,
 *   amountSat: number | null,
 *   payee: string,
 *   description: string,
 *   expiresAt: number,
 *   via: string[],
 * }} Invoice
 */

// KNOWN_NODES names a few nodes that often appear as an invoice's last hop.
export const KNOWN_NODES = {
	"021c97a90a411ff2b10dc2a8e32de2f29d2fa49d41bfbb52bd416e460db0747d0d": "Lightning Labs Loop (Wavelength receives)",
	"03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f": "ACINQ",
};

/**
 * parseInvoice decodes the fields the rules look at.
 *
 * @param {string} invoice
 * @returns {Invoice}
 */
export function parseInvoice(invoice) {
	if (typeof invoice !== "string" || !/^ln[a-z0-9]+$/i.test(invoice)) {
		throw new Error("not a BOLT11 invoice");
	}
	const { sections, expiry } = /** @type {{ sections: Array<{ name: string, value?: any }>, expiry?: number }} */ (
		decode(invoice)
	);
	/** @param {string} name */
	const field = (name) => sections.find((s) => s.name === name)?.value;
	const hash = field("payment_hash");
	if (typeof hash !== "string" || !/^[0-9a-f]{64}$/i.test(hash)) {
		throw new Error("invoice has no payment hash");
	}
	const amount = field("amount");
	const timestamp = Number(field("timestamp"));
	const expirySeconds = Number(field("expiry") ?? expiry ?? 3600);
	const description = field("description");
	// Route hints name the node(s) a private payee sits behind. Some wallets
	// sign every invoice with a fresh key, so the hint is the only stable
	// clue about where the money goes.
	const via = [];
	for (const s of sections) {
		if (s.name === "route_hint" && Array.isArray(s.value)) {
			for (const hop of s.value) {
				if (hop && typeof hop.pubkey === "string" && via.length < 3) {
					via.push(hop.pubkey.toLowerCase());
				}
			}
		}
	}
	return {
		paymentHash: hash.toLowerCase(),
		amountSat: typeof amount === "string" && /^\d+$/.test(amount) ? Number((BigInt(amount) + 999n) / 1000n) : null,
		payee: payeeOf(invoice),
		description: typeof description === "string" ? description.slice(0, 200) : "",
		expiresAt: (timestamp + (Number.isFinite(expirySeconds) ? expirySeconds : 3600)) * 1000,
		via,
	};
}
