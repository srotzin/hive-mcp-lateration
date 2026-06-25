#!/usr/bin/env node
/**
 * hive-mcp-lateration — Structural Lateration (SLS) metering MCP Server
 *
 * Structural Lateration is the primitive AFiR, MiR, RogueCompute, Stream, and
 * OCR are children of: instead of re-establishing structural work from scratch,
 * an agent laterates off prior attested shapes (n-body) and pays only for the
 * residual. The avoided cost is the value created — and the signed receipt that
 * proves the lateration IS the invoice for it. Dispute the bill and you destroy
 * the proof the lateration ever helped you.
 *
 * Five tools — price_lateration, mint_receipt, verify_receipt, settle_scouts,
 * get_pubkey. Every receipt is ML-DSA-65 (NIST FIPS 204) signed by the Hive
 * typed signer and verifiable offline with the returned envelope.
 *
 * Three metered streams:
 *   1. Nano receipt floor — a fixed micro-fee per lateration receipt.
 *   2. Savings clip       — a share of avoided_cost (counter-cyclical: the take
 *                           rate rises as solo cost falls).
 *   3. Scout settlement   — a spread plus a scout share on cross-tenant reuse,
 *                           with a privacy premium when laterating off another
 *                           tenant's attested shape.
 * Invariant: the customer's net always lands below what going solo would cost.
 *
 * Patent Pending. Hive Civilization. Settlement in USDC on Base.
 * Streamable-HTTP, JSON-RPC 2.0, MCP 2024-11-05. Inbound only.
 */
import express from 'express';
import { createHash } from 'node:crypto';

const SERVICE     = 'hive-mcp-lateration';
const VERSION     = '1.0.0';
const PORT        = process.env.PORT || 3000;
const ENABLE      = (process.env.ENABLE ?? 'true') !== 'false';
const BRAND_GOLD  = '#C08D23';
const SIGNER_BASE = process.env.HIVE_SIGNER_URL || 'https://hive-typed-signer.onrender.com';
const PUBKEY_URL  = `${SIGNER_BASE}/pubkey`;
const GCA_PATH    = '/sigr/gca';

// ─── Rate card (public, USDC on Base) ─────────────────────────────────────────
const RATE = {
  receipt_floor_usd:   0.0001,  // nano floor, always billed
  savings_clip:        0.20,    // share of avoided_cost
  scout_spread_bps:    30,      // 30 bps spread on cross-tenant settlement
  scout_share:         0.50,    // 50% of the spread to the scout
  privacy_premium:     1.5,     // x1.5 clip when laterating off another tenant's shape
};

// ─── Pricing engine (mirror of structural_lateration.price_lateration) ─────────
function priceLateration(ev) {
  const solo     = Number(ev.solo_cost_estimate);
  const residual = Number(ev.residual_cost);
  const avoided  = (ev.avoided_cost != null) ? Number(ev.avoided_cost) : (solo - residual);
  if (!(avoided >= 0)) throw new Error('avoided_cost must be >= 0 (solo_cost_estimate - residual_cost).');

  const cross = !!ev.cross_tenant;
  const clip_rate = RATE.savings_clip * (cross ? RATE.privacy_premium : 1);
  const savings_clip = avoided * clip_rate;
  const receipt_floor = RATE.receipt_floor_usd;

  // counter-cyclical effective take rate on avoided value
  const effective_take = avoided > 0 ? (savings_clip + receipt_floor) / avoided : null;

  const hive_revenue = receipt_floor + savings_clip;
  const customer_net = residual + hive_revenue; // what the customer actually pays
  const invariant_ok = customer_net < solo;     // always ahead of going solo

  return {
    currency: 'USDC',
    chain: 'Base',
    solo_cost_estimate: solo,
    residual_cost: residual,
    avoided_cost: avoided,
    cross_tenant: cross,
    streams: {
      receipt_floor_usd: round6(receipt_floor),
      savings_clip_usd:  round6(savings_clip),
      savings_clip_rate: round6(clip_rate),
    },
    effective_take_rate: effective_take == null ? null : round6(effective_take),
    hive_revenue_usd: round6(hive_revenue),
    customer_net_usd: round6(customer_net),
    customer_savings_vs_solo_usd: round6(solo - customer_net),
    invariant_customer_net_below_solo: invariant_ok,
  };
}

function settleScouts(args) {
  const settlement_notional = Number(args.settlement_notional_usd);
  if (!(settlement_notional >= 0)) throw new Error('settlement_notional_usd must be >= 0.');
  const spread = settlement_notional * (RATE.scout_spread_bps / 10_000);
  const scout_payout = spread * RATE.scout_share;
  const hive_keep = spread - scout_payout;
  return {
    currency: 'USDC',
    chain: 'Base',
    settlement_notional_usd: round6(settlement_notional),
    spread_bps: RATE.scout_spread_bps,
    spread_usd: round6(spread),
    scout_share: RATE.scout_share,
    scout_payout_usd: round6(scout_payout),
    hive_keep_usd: round6(hive_keep),
  };
}

function round6(x) { return Math.round(Number(x) * 1e6) / 1e6; }

// canonical commit over the event — avoided_cost is part of the committed
// payload, so the bill and the proof are the SAME object. Tamper any field
// (esp. avoided_cost) -> commit changes -> signed root no longer matches.
// Mirrors structural_lateration.commit_event (sorted keys, compact separators).
function commitEvent(ev) {
  const avoided = (ev.avoided_cost != null) ? ev.avoided_cost
                  : (Number(ev.solo_cost_estimate) - Number(ev.residual_cost));
  const refs = (ev.reference_call_ids || []).slice().sort();
  const payload = {
    event_id: ev.event_id,
    subject_call_id: ev.subject_call_id,
    reference_call_ids: refs,
    sls_subject: ev.sls_subject,
    similarity_to_field: Number(ev.similarity_to_field).toFixed(6),
    solo_cost_estimate: String(ev.solo_cost_estimate),
    residual_cost: String(ev.residual_cost),
    avoided_cost: String(avoided),
    tenant_id: ev.tenant_id,
    cross_tenant: ev.cross_tenant ? '1' : '0',
    timestamp: ev.timestamp,
    asserts: 'structural_reference_only',
  };
  return canonicalJson(payload);
}

// JSON.stringify with sorted keys + compact separators (Python json.dumps
// sort_keys=True, separators=(',',':') equivalent).
function canonicalJson(obj) {
  if (Array.isArray(obj)) return '[' + obj.map(canonicalJson).join(',') + ']';
  if (obj && typeof obj === 'object') {
    return '{' + Object.keys(obj).sort().map(k => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
  }
  return JSON.stringify(obj);
}

// the signer's GCA claim shape: {claim, support, support_strength_bp}. The
// 'claim' string is the canonical commit (the invoice); 'support' carries the
// cost-decomposition evidence.
function laterationClaim(ev) {
  const avoided = (ev.avoided_cost != null) ? ev.avoided_cost
                  : (Number(ev.solo_cost_estimate) - Number(ev.residual_cost));
  const support = `solo=${ev.solo_cost_estimate} residual=${ev.residual_cost} ` +
                  `avoided=${avoided} refs=${(ev.reference_call_ids||[]).length} ` +
                  `cross_tenant=${ev.cross_tenant ? '1' : '0'}`;
  const strength_bp = Math.trunc(Math.max(0, Math.min(Number(ev.similarity_to_field), 0.9999)) * 10000);
  return { claim: commitEvent(ev), support, support_strength_bp: strength_bp };
}

// Method hash commits the rate-card in force + a session nonce, so receipts are
// bound to the exact pricing they were issued under.
function sessionMethodHash() {
  const rcCanonical = canonicalJson(Object.fromEntries(Object.entries(RATE).map(([k, v]) => [k, String(v)])));
  return '0x' + createHash('sha256').update(rcCanonical + SERVICE + VERSION).digest('hex');
}

function groundingBody(ev) {
  return { grounding_claims: { method_hash: sessionMethodHash(), claims: [laterationClaim(ev)] } };
}

async function callSigner(path, body) {
  const r = await fetch(`${SIGNER_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Origin': 'https://thehiveryiq.com' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!r.ok) throw new Error(`signer ${path} -> ${r.status}: ${typeof data === 'object' ? JSON.stringify(data) : text}`);
  return data;
}

// ─── Tools ──────────────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'price_lateration',
    description: 'Price a structural lateration before minting (free, no signature). Given a lateration event {event_id, subject_call_id, reference_call_ids[], sls_subject, similarity_to_field, solo_cost_estimate, residual_cost, tenant_id, cross_tenant, timestamp}, returns the full metered breakdown: nano receipt floor, savings clip (a share of avoided_cost, x1.5 cross-tenant privacy premium), the counter-cyclical effective take rate, Hive revenue, customer net, and the customer-always-ahead invariant. Currency USDC on Base.',
    inputSchema: {
      type: 'object',
      properties: { event: { type: 'object', description: 'The lateration event to price.' } },
      required: ['event'],
    },
  },
  {
    name: 'mint_receipt',
    description: 'Mint the signed lateration receipt — the receipt IS the invoice. Binds avoided_cost into an ML-DSA-65 (NIST FIPS 204) signed GCA envelope so the dollar amount is cryptographically bound to the work. Dispute the bill by tampering avoided_cost and the receipt no longer verifies — you lose the proof the lateration ever helped you. Pass the same "event" object as price_lateration. Returns {claims_root, envelope, pricing}. Settlement USDC on Base.',
    inputSchema: {
      type: 'object',
      properties: { event: { type: 'object', description: 'The lateration event to seal and bill.' } },
      required: ['event'],
    },
  },
  {
    name: 'verify_receipt',
    description: 'Verify a lateration receipt offline (always free). Re-derives the claims_root from the asserted event (including avoided_cost) and checks it against the signed receipt root. True iff the lateration AND its billed avoided_cost are authentic. No secret required. Pass the "event" and the "claims_root" returned by mint_receipt.',
    inputSchema: {
      type: 'object',
      properties: {
        event:       { type: 'object', description: 'The asserted lateration event from the receipt.' },
        claims_root: { type: 'string', description: 'The signed claims_root from mint_receipt.' },
      },
      required: ['event', 'claims_root'],
    },
  },
  {
    name: 'settle_scouts',
    description: 'Settle a cross-tenant scout reuse (free preview of the settlement math). A scout supplied the attested shape another tenant laterated off. Given settlement_notional_usd, returns the 30 bps spread, the 50% scout payout, and the Hive keep. Currency USDC on Base.',
    inputSchema: {
      type: 'object',
      properties: {
        settlement_notional_usd: { type: 'number', description: 'The cross-tenant settlement notional in USDC.' },
      },
      required: ['settlement_notional_usd'],
    },
  },
  {
    name: 'get_pubkey',
    description: 'Get the Hive typed-signer public key and algorithm metadata for offline verification (free). Returns the ML-DSA-65 (NIST FIPS 204) public key, issuer DID, and spec.',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function executeTool(name, args) {
  if (name === 'price_lateration') {
    if (!args.event || typeof args.event !== 'object') throw new Error('Provide an "event" object.');
    return { type: 'text', text: JSON.stringify(priceLateration(args.event), null, 2) };
  }
  if (name === 'mint_receipt') {
    if (!args.event || typeof args.event !== 'object') throw new Error('Provide an "event" object.');
    const ev = args.event;
    const pricing = priceLateration(ev);
    const resp = await callSigner(GCA_PATH, groundingBody(ev));
    const out = {
      ok: true,
      product: 'structural_lateration',
      patent_pending: true,
      claims_root: resp?.envelope?.claims_root,
      envelope: resp?.envelope ?? resp,
      pricing,
    };
    return { type: 'text', text: JSON.stringify(out, null, 2) };
  }
  if (name === 'verify_receipt') {
    if (!args.event || typeof args.event !== 'object') throw new Error('Provide the "event" object.');
    if (!args.claims_root) throw new Error('Provide the "claims_root".');
    const resp = await callSigner(GCA_PATH, groundingBody(args.event));
    const rederived = resp?.envelope?.claims_root;
    const valid = !!rederived && rederived === args.claims_root;
    return { type: 'text', text: JSON.stringify({
      valid,
      reasons: valid ? ['claims_root matches — lateration and billed avoided_cost are authentic']
                     : ['claims_root mismatch — event tampered or wrong receipt; bill is disputed and proof is void'],
      rederived_root: rederived,
      provided_root: args.claims_root,
    }, null, 2) };
  }
  if (name === 'settle_scouts') {
    return { type: 'text', text: JSON.stringify(settleScouts(args), null, 2) };
  }
  if (name === 'get_pubkey') {
    const r = await fetch(PUBKEY_URL, { signal: AbortSignal.timeout(15_000) });
    const data = await r.json();
    return { type: 'text', text: JSON.stringify(data, null, 2) };
  }
  throw new Error(`Unknown tool: ${name}`);
}

// ─── HTTP / MCP ───────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '8mb' }));

app.get('/health', (_req, res) => res.json({ status: 'ok', service: SERVICE, version: VERSION, enabled: ENABLE }));

app.get('/', (_req, res) => res.json({
  service: SERVICE,
  version: VERSION,
  description: 'Structural Lateration (SLS) metering MCP server. The primitive AFiR/MiR/RogueCompute/Stream/OCR are children of. The signed receipt is the invoice. Patent Pending. Hive Civilization.',
  endpoints: { mcp: '/mcp', well_known: '/.well-known/mcp.json', health: '/health' },
  upstream: SIGNER_BASE,
  rate_card: RATE,
  settlement: { currency: 'USDC', chain: 'Base' },
  brand_color: BRAND_GOLD,
}));

app.post('/mcp', async (req, res) => {
  const { jsonrpc, id, method, params } = req.body || {};
  if (jsonrpc !== '2.0') {
    return res.status(400).json({ jsonrpc: '2.0', id: id ?? null, error: { code: -32600, message: 'Invalid Request' } });
  }
  try {
    switch (method) {
      case 'initialize':
        return res.json({
          jsonrpc: '2.0', id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: SERVICE, version: VERSION, description: 'Structural Lateration (SLS) metering. The receipt is the invoice. ML-DSA-65 signed, verifiable offline. Patent Pending. Hive Civilization.' },
          },
        });
      case 'tools/list':
        return res.json({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      case 'tools/call': {
        const { name, arguments: args } = params || {};
        if (!ENABLE) return res.json({ jsonrpc: '2.0', id, error: { code: 503, message: 'service_disabled' } });
        try {
          const out = await executeTool(name, args || {});
          return res.json({ jsonrpc: '2.0', id, result: { content: [out] } });
        } catch (err) {
          return res.json({ jsonrpc: '2.0', id, error: { code: -32000, message: err.message } });
        }
      }
      case 'ping':
        return res.json({ jsonrpc: '2.0', id, result: {} });
      default:
        return res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  } catch (err) {
    return res.json({ jsonrpc: '2.0', id: id ?? null, error: { code: -32000, message: err.message } });
  }
});

app.get('/.well-known/mcp.json', (_req, res) => res.json({
  name: SERVICE,
  version: VERSION,
  protocol: '2024-11-05',
  transport: 'streamable-http',
  endpoint: '/mcp',
  description: 'Structural Lateration (SLS) metering. Price a lateration, mint the signed receipt that is the invoice, verify it offline, settle scouts. ML-DSA-65 (FIPS 204). Patent Pending. Hive Civilization.',
  tools: TOOLS.map(t => ({ name: t.name, description: t.description })),
  brand_color: BRAND_GOLD,
}));

app.get('/.well-known/agent.json', (_req, res) => res.json({
  name: SERVICE,
  description: 'Structural Lateration metering surface for the Hive agent economy. The signed receipt is the invoice; every receipt ML-DSA-65 signed (FIPS 204) and verifiable offline.',
  url: `https://${SERVICE}.onrender.com`,
  provider: { organization: 'Hive Civilization', url: 'https://www.thehiveryiq.com', contact: 'steve@thehiveryiq.com' },
  capabilities: ['structural-lateration', 'metered-receipts', 'avoided-cost-billing', 'scout-settlement', 'provenance'],
  tools: TOOLS.map(t => t.name),
  brand_color: BRAND_GOLD,
}));

if (!ENABLE) console.log(`[${SERVICE}] ENABLE=false — dormant (health only)`);
app.listen(PORT, () => console.log(`[${SERVICE}] v${VERSION} listening on :${PORT} -> ${SIGNER_BASE}`));
