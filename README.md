# hive-mcp-lateration: Structural Lateration (SLS)

A remote [MCP](https://modelcontextprotocol.io) server for **Structural Lateration**, the metered primitive that AFiR, MiR, RogueCompute, Stream, and OCR are children of.

Instead of re-establishing structural work from scratch, an agent **laterates** off prior attested shapes, triangulating its position from several already-signed references (n-body) and paying only for the **residual**. The gap between what going solo would have cost and what the lateration actually cost is the **avoided cost**, the value created. The signed receipt that proves the lateration **is the invoice** for that value. Dispute the bill by tampering the avoided cost and the receipt no longer verifies: you lose the proof the lateration ever helped you.

Every receipt is signed with **ML-DSA-65 (NIST FIPS 204)** by the upstream Hive typed signer. **`verify_receipt` in this server is not an offline verifier**: it re-derives the claims root by calling the same live upstream `/sigr/gca` route that `mint_receipt` uses, and compares roots. It requires network access to the signer every time it runs, unlike a true local/offline check against a self-contained envelope.

**Patent Pending. Hive Civilization.**

- Remote endpoint: `https://hive-mcp-lateration.onrender.com/mcp`
- Transport: Streamable-HTTP, JSON-RPC 2.0, MCP `2024-11-05`
- Upstream signer: `https://hive-typed-signer.onrender.com`
- Signature scheme: ML-DSA-65 (NIST FIPS 204)
- Settlement: **USDC on Base.** Verify is always free.

---

## How the metering works

Three streams, one signed object:

| Stream | What it charges | Note |
|---|---|---|
| **Nano receipt floor** | A fixed micro-fee per lateration receipt | Always billed |
| **Savings clip** | A share of `avoided_cost` | x1.5 cross-tenant privacy premium |
| **Scout settlement** | A 30 bps spread on cross-tenant reuse | 50% to the scout who supplied the shape |

The effective take rate is **counter-cyclical**: as the solo cost falls, the clip's share of the avoided value rises, so revenue is stable-to-rising even in a downturn. And the controlling invariant always holds: **the customer's net lands below what going solo would have cost.**

---

## Tools

| Tool | What it does | Required input |
|---|---|---|
| `price_lateration` | Price a lateration before minting (free): full stream breakdown, effective take rate, customer-net invariant | `event` |
| `mint_receipt` | Mint the signed receipt that **is the invoice**; binds `avoided_cost` into an ML-DSA-65 GCA envelope | `event` |
| `verify_receipt` | Verify (always free, but **not offline**; makes a live call to the upstream signer): re-derives the root from the asserted event incl. `avoided_cost` | `event`, `claims_root` |
| `settle_scouts` | Compute the cross-tenant scout settlement (spread + scout share) | `settlement_notional_usd` |
| `get_pubkey` | Return the ML-DSA-65 (NIST FIPS 204) public key + issuer metadata | (none) |

A lateration `event` looks like:

```json
{
  "event_id": "evt-1",
  "subject_call_id": "call-sub-1",
  "reference_call_ids": ["call-ref-1", "call-ref-2", "call-ref-3"],
  "sls_subject": "0x...",
  "similarity_to_field": 0.81,
  "solo_cost_estimate": "1.00",
  "residual_cost": "0.28",
  "tenant_id": "acme",
  "cross_tenant": false,
  "timestamp": "2026-06-25T05:00:00Z"
}
```

---

## Connect

### Claude Desktop / MCP client (remote)

```json
{
  "mcpServers": {
    "hive-lateration": {
      "type": "streamable-http",
      "url": "https://hive-mcp-lateration.onrender.com/mcp"
    }
  }
}
```

### List tools

```bash
curl -s -X POST https://hive-mcp-lateration.onrender.com/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

### Price a lateration (free)

```bash
curl -s -X POST https://hive-mcp-lateration.onrender.com/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"price_lateration","arguments":{"event":{"event_id":"evt-1","subject_call_id":"call-sub-1","reference_call_ids":["r1","r2","r3"],"sls_subject":"0xabc","similarity_to_field":0.81,"solo_cost_estimate":"1.00","residual_cost":"0.28","tenant_id":"acme","cross_tenant":false,"timestamp":"2026-06-25T05:00:00Z"}}}}}'
```

### Mint the receipt (the invoice)

```bash
curl -s -X POST https://hive-mcp-lateration.onrender.com/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"mint_receipt","arguments":{"event":{ /* same event */ }}}}'
```

### Verify it (free)

```bash
curl -s -X POST https://hive-mcp-lateration.onrender.com/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"verify_receipt","arguments":{"event":{ /* same event */ },"claims_root":"<from mint_receipt>"}}}'
```

---

## Run it yourself

```bash
npm install
node server.js
# -> [hive-mcp-lateration] v1.0.0 listening on :3000 -> https://hive-typed-signer.onrender.com
```

Environment:

| Var | Default | Notes |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `ENABLE` | `true` | Set `false` to run health-only |
| `HIVE_SIGNER_URL` | `https://hive-typed-signer.onrender.com` | Upstream signer base |

---

## Verification limitation

`verify_receipt` calls the live upstream signer (`POST /sigr/gca` on `HIVE_SIGNER_URL`) to re-derive the claims root and compare it to the one you provide. It is **not** an offline/local verifier: it needs network access to the signer to run, and its answer is only as trustworthy as that live call. This is different from a self-contained, purely offline envelope check. If the upstream signer is unreachable, `verify_receipt` fails rather than silently reporting a false pass.

## Policy

Inbound only. Never takes custody of keys or funds. Metering and signing only: your event is priced, signed, and returned; we do not store it.

Settlement for paid tiers is USDC on Base. Verify is always free.

---

MIT © 2026 Steve Rotzin / Hive Civilization · [thehiveryiq.com](https://www.thehiveryiq.com)
