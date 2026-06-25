# v1.0.0 — Hive Structural Lateration (SLS) MCP Server

First public release of `hive-mcp-lateration`, the remote MCP surface for **Structural Lateration** — the metered primitive that AFiR, MiR, RogueCompute, Stream, and OCR are children of.

## What's in it

Five tools, Streamable-HTTP, JSON-RPC 2.0, MCP `2024-11-05`:

- **`price_lateration`** — price a lateration before minting (free). Returns the nano receipt floor, the savings clip (x1.5 cross-tenant), the counter-cyclical effective take rate, Hive revenue, customer net, and the customer-always-ahead invariant.
- **`mint_receipt`** — mint the signed receipt that **is the invoice**. Binds `avoided_cost` into an ML-DSA-65 (NIST FIPS 204) GCA envelope.
- **`verify_receipt`** — verify any lateration receipt offline. Always free.
- **`settle_scouts`** — compute the cross-tenant scout settlement (30 bps spread, 50% scout share).
- **`get_pubkey`** — return the ML-DSA-65 (NIST FIPS 204) public key.

## How it works

An agent laterates off prior attested shapes instead of re-establishing structural work, and pays only for the residual. The avoided cost — what going solo would have cost minus what the lateration actually cost — is the value created. The signed receipt that proves the lateration is the invoice for that value. Tamper the avoided cost to dispute the bill and the receipt stops verifying: the dispute destroys the proof the lateration helped.

## Economics

Three metered streams. The effective take rate is counter-cyclical — it rises as solo cost falls, so revenue is stable-to-rising in a downturn. The controlling invariant always holds: the customer's net lands below going solo.

## Pricing

Verify always free. Settlement in USDC on Base.

Patent Pending. Hive Civilization.
