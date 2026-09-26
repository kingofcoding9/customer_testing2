import { authMe } from "../_shared/firebase-auth.js";
import { employeeProxy } from "../_shared/employee-proxy.js";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  });
}

function required(env, key) {
  const value = String(env[key] || "").trim();
  if (!value) throw new Error(`Missing required binding: ${key}`);
  return value;
}

function backendBase(env) {
  return required(env, "PICALILY_INVENTORY_URL").replace(/\/+$/, "");
}

function readHeaders(env, request) {
  const headers = new Headers();
  headers.set("authorization", "Bearer " + required(env, "PICALILY_INVENTORY_READ_KEY"));
  const etag = request?.headers?.get("if-none-match");
  if (etag) headers.set("if-none-match", etag);
  return headers;
}

function commerceHeaders(env) {
  return {
    "content-type": "application/json",
    "x-picalily-commerce-key": required(env, "PICALILY_INVENTORY_COMMERCE_KEY"),
  };
}

async function backendRead(env, path, request) {
  return fetch(backendBase(env) + path, {
    method: "GET",
    headers: readHeaders(env, request),
    redirect: "manual",
  });
}

async function backendCommerce(env, path, { method = "POST", body } = {}) {
  const response = await fetch(backendBase(env) + path, {
    method,
    headers: commerceHeaders(env),
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });

  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { error: text || `Inventory backend returned HTTP ${response.status}` };
  }

  if (!response.ok) {
    const error = new Error(payload?.error || `Inventory backend returned HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

function copyProxyHeaders(source, { image = false } = {}) {
  const headers = new Headers();
  for (const name of ["content-type", "etag", "cache-control", "last-modified"]) {
    const value = source.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (!headers.has("cache-control")) {
    headers.set("cache-control", image ? "public, max-age=300" : "no-cache");
  }
  return headers;
}

async function proxyInventory(context, path, { image = false } = {}) {
  if (context.env.COMMERCE_DB) {
    try {
      await reconcilePending(context.env, 4);
    } catch (error) {
      console.warn("Picalily reconcile before inventory read failed:", error);
    }
  }

  const upstream = await backendRead(context.env, path, context.request);
  return new Response(upstream.body, {
    status: upstream.status,
    headers: copyProxyHeaders(upstream, { image }),
  });
}

function normalizeCheckoutItems(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
    throw Object.assign(new Error("Checkout must contain between 1 and 100 items."), { status: 400 });
  }

  const combined = new Map();
  for (const raw of value) {
    const productId = Number(raw?.product_id ?? raw?.id ?? raw?.pos_item_id);
    const quantity = Number(raw?.quantity ?? 1);
    if (!Number.isSafeInteger(productId) || productId <= 0) {
      throw Object.assign(new Error("Every checkout item needs a valid product_id."), { status: 400 });
    }
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 99) {
      throw Object.assign(new Error("Item quantity must be between 1 and 99."), { status: 400 });
    }
    const next = (combined.get(productId) || 0) + quantity;
    if (next > 99) {
      throw Object.assign(new Error("Quantity per product cannot exceed 99."), { status: 400 });
    }
    combined.set(productId, next);
  }

  return [...combined.entries()].map(([product_id, quantity]) => ({ product_id, quantity }));
}

async function createStripeCheckout(env, origin, orderId, reservation) {
  const secret = required(env, "STRIPE_SECRET_KEY");
  const currency = String(env.STRIPE_CURRENCY || "usd").trim().toLowerCase() || "usd";
  const nowSeconds = Math.floor(Date.now() / 1000);
  const checkoutExpiresAt = nowSeconds + 35 * 60;

  const form = new URLSearchParams();
  form.set("mode", "payment");
  form.set("client_reference_id", orderId);
  form.set("metadata[order_id]", orderId);
  form.set("payment_intent_data[metadata][order_id]", orderId);
  form.set("success_url", `${origin}/?checkout=success&session_id={CHECKOUT_SESSION_ID}#/inventory`);
  form.set("cancel_url", `${origin}/?checkout=cancelled#/inventory`);
  form.set("expires_at", String(checkoutExpiresAt));

  if (String(env.STRIPE_ALLOW_PROMOTION_CODES || "").toLowerCase() === "true") {
    form.set("allow_promotion_codes", "true");
  }
  if (String(env.STRIPE_AUTOMATIC_TAX || "").toLowerCase() === "true") {
    form.set("automatic_tax[enabled]", "true");
  }

  reservation.items.forEach((item, index) => {
    form.set(`line_items[${index}][quantity]`, String(item.quantity));
    form.set(`line_items[${index}][price_data][currency]`, currency);
    form.set(`line_items[${index}][price_data][unit_amount]`, String(item.unit_amount));
    form.set(`line_items[${index}][price_data][product_data][name]`, String(item.name || "Picalily item"));
    form.set(
      `line_items[${index}][price_data][product_data][metadata][picalily_product_id]`,
      String(item.product_id),
    );
  });

  const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      authorization: "Bearer " + secret,
      "content-type": "application/x-www-form-urlencoded",
      "idempotency-key": "picalily-checkout-" + orderId,
    },
    body: form.toString(),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload?.id || !payload?.url) {
    throw new Error(payload?.error?.message || `Stripe returned HTTP ${response.status}`);
  }

  return {
    id: payload.id,
    url: payload.url,
    expires_at: payload.expires_at || checkoutExpiresAt,
  };
}

async function expireStripeCheckout(env, sessionId) {
  if (!sessionId) return;
  const response = await fetch(
    "https://api.stripe.com/v1/checkout/sessions/" + encodeURIComponent(sessionId) + "/expire",
    {
      method: "POST",
      headers: {
        authorization: "Bearer " + required(env, "STRIPE_SECRET_KEY"),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "",
    },
  );
  if (!response.ok && response.status !== 400) {
    throw new Error(`Unable to expire Stripe Checkout session (HTTP ${response.status}).`);
  }
}

async function saveReservedOrder(env, reservation) {
  const db = env.COMMERCE_DB;
  if (!db) throw new Error("Missing required D1 binding: COMMERCE_DB");

  const now = new Date().toISOString();
  const statements = [
    db.prepare(
      `INSERT INTO commerce_orders(
        order_id,stripe_session_id,status,sync_status,total_amount,currency,created_at,updated_at,last_error
      ) VALUES(?1,'','reserved','reserved',?2,?3,?4,?4,'')
      ON CONFLICT(order_id) DO NOTHING`,
    ).bind(
      reservation.order_id,
      reservation.total_amount,
      String(env.STRIPE_CURRENCY || "usd").toLowerCase(),
      now,
    ),
  ];

  for (const item of reservation.items) {
    statements.push(
      db.prepare(
        `INSERT INTO commerce_order_items(
          order_id,product_id,name,quantity,unit_amount,shipping_json
        ) VALUES(?1,?2,?3,?4,?5,?6)
        ON CONFLICT(order_id,product_id) DO UPDATE SET
          name=excluded.name,
          quantity=excluded.quantity,
          unit_amount=excluded.unit_amount,
          shipping_json=excluded.shipping_json`,
      ).bind(
        reservation.order_id,
        item.product_id,
        item.name,
        item.quantity,
        item.unit_amount,
        JSON.stringify(item.shipping || {}),
      ),
    );
  }
  await db.batch(statements);
}

async function checkout(context) {
  const originHeader = context.request.headers.get("origin");
  const requestOrigin = new URL(context.request.url).origin;
  if (originHeader && originHeader !== requestOrigin) {
    return json({ error: "Cross-site checkout requests are not allowed." }, 403);
  }

  let body;
  try {
    body = await context.request.json();
  } catch {
    return json({ error: "Checkout body must be valid JSON." }, 400);
  }

  let items;
  try {
    items = normalizeCheckoutItems(body?.items);
  } catch (error) {
    return json({ error: error.message }, error.status || 400);
  }

  required(context.env, "STRIPE_SECRET_KEY");
  required(context.env, "PICALILY_INVENTORY_COMMERCE_KEY");
  if (!context.env.COMMERCE_DB) {
    return json({ error: "Checkout storage is not configured." }, 503);
  }

  const orderId = crypto.randomUUID();
  const provisionalExpiry = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  let reservation;

  try {
    reservation = await backendCommerce(context.env, "/commerce/reservations", {
      body: {
        order_id: orderId,
        expires_at: provisionalExpiry,
        items,
      },
    });
  } catch (error) {
    const status = Number(error.status) || 503;
    return json({ error: error.message || "Inventory could not be reserved." }, status);
  }

  try {
    await saveReservedOrder(context.env, reservation);
  } catch (error) {
    try {
      await backendCommerce(context.env, `/commerce/reservations/${encodeURIComponent(orderId)}/release`);
    } catch {}
    console.error("Failed to persist reserved order:", error);
    return json({ error: "Checkout storage is temporarily unavailable." }, 503);
  }

  let session;
  try {
    session = await createStripeCheckout(context.env, requestOrigin, orderId, reservation);
  } catch (error) {
    try {
      await backendCommerce(context.env, `/commerce/reservations/${encodeURIComponent(orderId)}/release`);
    } catch {}
    await context.env.COMMERCE_DB.prepare(
      "UPDATE commerce_orders SET status='checkout_failed',sync_status='released',last_error=?2,updated_at=?3 WHERE order_id=?1",
    ).bind(orderId, String(error.message || error), new Date().toISOString()).run();
    return json({ error: "Unable to start Stripe Checkout." }, 502);
  }

  const hardExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  try {
    await backendCommerce(
      context.env,
      `/commerce/reservations/${encodeURIComponent(orderId)}/attach`,
      {
        body: {
          stripe_session_id: session.id,
          expires_at: hardExpiry,
        },
      },
    );
  } catch (error) {
    try { await expireStripeCheckout(context.env, session.id); } catch {}
    try {
      await backendCommerce(context.env, `/commerce/reservations/${encodeURIComponent(orderId)}/release`);
    } catch {}
    await context.env.COMMERCE_DB.prepare(
      "UPDATE commerce_orders SET status='checkout_failed',sync_status='release_required',last_error=?2,updated_at=?3 WHERE order_id=?1",
    ).bind(orderId, String(error.message || error), new Date().toISOString()).run();
    return json({ error: "Inventory reservation could not be linked to checkout." }, 503);
  }

  await context.env.COMMERCE_DB.prepare(
    `UPDATE commerce_orders
     SET stripe_session_id=?2,status='checkout_open',sync_status='reserved',updated_at=?3,last_error=''
     WHERE order_id=?1`,
  ).bind(orderId, session.id, new Date().toISOString()).run();

  return json({
    ok: true,
    order_id: orderId,
    checkout_session_id: session.id,
    url: session.url,
    expires_at: session.expires_at,
  });
}

function parseStripeSignature(header) {
  const parsed = { timestamp: "", signatures: [] };
  for (const part of String(header || "").split(",")) {
    const [key, value] = part.split("=", 2);
    if (key === "t") parsed.timestamp = value || "";
    if (key === "v1" && value) parsed.signatures.push(value);
  }
  return parsed;
}

function constantTimeHexEqual(a, b) {
  const left = String(a || "").toLowerCase();
  const right = String(b || "").toLowerCase();
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) {
    diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return diff === 0;
}

async function hmacHex(secret, payload) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(payload)),
  );
  return [...signature].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function verifyStripeWebhook(env, rawBody, signatureHeader) {
  const secret = required(env, "STRIPE_WEBHOOK_SECRET");
  const { timestamp, signatures } = parseStripeSignature(signatureHeader);
  if (!timestamp || !signatures.length) throw new Error("Missing Stripe webhook signature.");

  const timestampNumber = Number(timestamp);
  if (!Number.isFinite(timestampNumber)) throw new Error("Invalid Stripe webhook timestamp.");
  const age = Math.abs(Math.floor(Date.now() / 1000) - timestampNumber);
  if (age > 300) throw new Error("Stripe webhook timestamp is outside the 5-minute tolerance.");

  const expected = await hmacHex(secret, timestamp + "." + rawBody);
  if (!signatures.some((candidate) => constantTimeHexEqual(candidate, expected))) {
    throw new Error("Stripe webhook signature verification failed.");
  }
}

async function applyInventoryAction(env, orderId, action) {
  const route = `/commerce/reservations/${encodeURIComponent(orderId)}/${action}`;
  return backendCommerce(env, route);
}

async function setPendingAction(env, orderId, action, orderStatus, error = "") {
  if (!env.COMMERCE_DB) return;
  await env.COMMERCE_DB.prepare(
    `UPDATE commerce_orders
     SET status=?2,sync_status=?3,last_error=?4,updated_at=?5
     WHERE order_id=?1`,
  ).bind(
    orderId,
    orderStatus,
    action === "commit" ? "pending_commit" : "pending_release",
    error,
    new Date().toISOString(),
  ).run();
}

async function syncOrderAction(env, orderId, action, orderStatus) {
  await setPendingAction(env, orderId, action, orderStatus);
  try {
    await applyInventoryAction(env, orderId, action);
    await env.COMMERCE_DB.prepare(
      "UPDATE commerce_orders SET sync_status='synced',last_error='',updated_at=?2 WHERE order_id=?1",
    ).bind(orderId, new Date().toISOString()).run();
  } catch (error) {
    await setPendingAction(env, orderId, action, orderStatus, String(error.message || error));
    throw error;
  }
}

async function reconcilePending(env, limit = 5) {
  if (!env.COMMERCE_DB) return;
  const result = await env.COMMERCE_DB.prepare(
    `SELECT order_id,sync_status,status
     FROM commerce_orders
     WHERE sync_status IN ('pending_commit','pending_release','release_required')
     ORDER BY updated_at ASC LIMIT ?1`,
  ).bind(limit).all();

  for (const row of result.results || []) {
    const action = row.sync_status === "pending_commit" ? "commit" : "release";
    try {
      await applyInventoryAction(env, row.order_id, action);
      await env.COMMERCE_DB.prepare(
        "UPDATE commerce_orders SET sync_status='synced',last_error='',updated_at=?2 WHERE order_id=?1",
      ).bind(row.order_id, new Date().toISOString()).run();
    } catch (error) {
      await env.COMMERCE_DB.prepare(
        "UPDATE commerce_orders SET last_error=?2,updated_at=?3 WHERE order_id=?1",
      ).bind(row.order_id, String(error.message || error), new Date().toISOString()).run();
    }
  }
}

async function stripeWebhook(context) {
  if (!context.env.COMMERCE_DB) {
    return json({ error: "Checkout storage is not configured." }, 503);
  }

  const rawBody = await context.request.text();
  try {
    await verifyStripeWebhook(
      context.env,
      rawBody,
      context.request.headers.get("stripe-signature"),
    );
  } catch (error) {
    return json({ error: error.message }, 400);
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return json({ error: "Stripe webhook body is not valid JSON." }, 400);
  }

  const eventId = String(event?.id || "");
  const eventType = String(event?.type || "");
  if (!eventId || !eventType) return json({ error: "Invalid Stripe event." }, 400);

  const existing = await context.env.COMMERCE_DB.prepare(
    "SELECT status FROM stripe_events WHERE event_id=?1",
  ).bind(eventId).first();

  if (existing?.status === "processed") {
    return json({ received: true, duplicate: true });
  }

  await context.env.COMMERCE_DB.prepare(
    `INSERT INTO stripe_events(event_id,event_type,status,created_at,updated_at,last_error)
     VALUES(?1,?2,'processing',?3,?3,'')
     ON CONFLICT(event_id) DO UPDATE SET status='processing',updated_at=excluded.updated_at`,
  ).bind(eventId, eventType, new Date().toISOString()).run();

  const session = event?.data?.object || {};
  const orderId = String(session?.client_reference_id || session?.metadata?.order_id || "").trim();

  try {
    if (
      eventType === "checkout.session.completed" &&
      String(session?.payment_status || "") === "paid"
    ) {
      if (!orderId) throw new Error("Paid Checkout Session is missing the Picalily order id.");
      await syncOrderAction(context.env, orderId, "commit", "paid");
    } else if (eventType === "checkout.session.async_payment_succeeded") {
      if (!orderId) throw new Error("Paid Checkout Session is missing the Picalily order id.");
      await syncOrderAction(context.env, orderId, "commit", "paid");
    } else if (
      eventType === "checkout.session.expired" ||
      eventType === "checkout.session.async_payment_failed"
    ) {
      if (!orderId) throw new Error("Expired Checkout Session is missing the Picalily order id.");
      await syncOrderAction(
        context.env,
        orderId,
        "release",
        eventType.endsWith("expired") ? "expired" : "payment_failed",
      );
    } else if (
      eventType === "checkout.session.completed" &&
      String(session?.payment_status || "") !== "paid" &&
      orderId
    ) {
      await context.env.COMMERCE_DB.prepare(
        "UPDATE commerce_orders SET status='payment_pending',updated_at=?2 WHERE order_id=?1",
      ).bind(orderId, new Date().toISOString()).run();
    }

    await context.env.COMMERCE_DB.prepare(
      "UPDATE stripe_events SET status='processed',last_error='',updated_at=?2 WHERE event_id=?1",
    ).bind(eventId, new Date().toISOString()).run();
    return json({ received: true });
  } catch (error) {
    await context.env.COMMERCE_DB.prepare(
      "UPDATE stripe_events SET status='pending',last_error=?2,updated_at=?3 WHERE event_id=?1",
    ).bind(eventId, String(error.message || error), new Date().toISOString()).run();

    return json({ error: "Order synchronization is temporarily unavailable." }, 503);
  }
}

async function checkoutStatus(context) {
  if (!context.env.COMMERCE_DB) return json({ error: "Checkout storage is not configured." }, 503);
  const url = new URL(context.request.url);
  const sessionId = String(url.searchParams.get("session_id") || "").trim();
  if (!sessionId) return json({ error: "session_id is required." }, 400);

  const order = await context.env.COMMERCE_DB.prepare(
    `SELECT order_id,stripe_session_id,status,sync_status,total_amount,currency,created_at,updated_at
     FROM commerce_orders WHERE stripe_session_id=?1`,
  ).bind(sessionId).first();
  if (!order) return json({ error: "Order not found." }, 404);

  return json({ ok: true, order });
}

async function health(context) {
  let inventory = null;
  try {
    const response = await fetch(backendBase(context.env) + "/health", {
      headers: readHeaders(context.env),
    });
    inventory = response.ok ? await response.json() : { ok: false, status: response.status };
  } catch (error) {
    inventory = { ok: false, error: String(error.message || error) };
  }

  return json({
    ok: true,
    edge: "cloudflare-pages-functions",
    inventory,
    checkout_configured: Boolean(
      context.env.STRIPE_SECRET_KEY &&
      context.env.STRIPE_WEBHOOK_SECRET &&
      context.env.PICALILY_INVENTORY_COMMERCE_KEY &&
      context.env.COMMERCE_DB
    ),
    firebase_auth_configured: Boolean(
      context.env.FIREBASE_PROJECT_ID &&
      context.env.PICALILY_EMPLOYEE_EMAILS
    ),
    employee_admin_configured: Boolean(
      context.env.FIREBASE_PROJECT_ID &&
      context.env.PICALILY_EMPLOYEE_EMAILS &&
      context.env.PICALILY_INVENTORY_ADMIN_KEY
    ),
  });
}

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const path = url.pathname.replace(/^\/api\/?/, "");
  const method = context.request.method.toUpperCase();

  try {
    if (method === "GET" && path === "health") return health(context);
    if (method === "GET" && path === "inventory") return proxyInventory(context, "/inventory");
    if (method === "GET" && /^inventory\/\d+$/.test(path)) {
      return proxyInventory(context, "/" + path);
    }
    if (method === "GET" && /^images\/\d+$/.test(path)) {
      return proxyInventory(context, "/" + path, { image: true });
    }
    if (method === "POST" && path === "checkout") return checkout(context);
    if (method === "GET" && path === "checkout/status") return checkoutStatus(context);
    if (method === "POST" && path === "stripe/webhook") return stripeWebhook(context);
    if (method === "GET" && path === "auth/me") {
      return json({ ok: true, user: await authMe(context.request, context.env) });
    }
    if (path.startsWith("employee/") && ["GET", "POST", "PUT", "DELETE"].includes(method)) {
      return await employeeProxy(context, path.slice("employee/".length));
    }
    return json({ error: "API route not found." }, 404);
  } catch (error) {
    console.error("Picalily API error:", error);
    const status = Number(error?.status) || 503;
    const message = status < 500
      ? String(error?.message || "Request failed.")
      : "Service temporarily unavailable.";
    return json({ error: message }, status);
  }
}
