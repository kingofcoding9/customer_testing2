let cachedJwks = null;
let cachedJwksExpiresAt = 0;

function base64UrlToBytes(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function decodeJsonPart(value) {
  const bytes = base64UrlToBytes(value);
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function getFirebaseJwks() {
  const now = Date.now();
  if (cachedJwks && now < cachedJwksExpiresAt) return cachedJwks;

  const response = await fetch(
    "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com",
    { cf: { cacheTtl: 3600, cacheEverything: true } },
  );
  if (!response.ok) {
    throw new Error("Unable to load Firebase signing keys.");
  }
  const jwks = await response.json();
  const maxAge = Number(
    /max-age=(\d+)/i.exec(response.headers.get("cache-control") || "")?.[1] || 3600,
  );
  cachedJwks = jwks;
  cachedJwksExpiresAt = now + Math.max(300, maxAge - 60) * 1000;
  return jwks;
}

function employeeEmails(env) {
  const raw = String(env.PICALILY_EMPLOYEE_EMAILS || "").trim();
  if (!raw) return new Set();
  let values;
  try {
    values = JSON.parse(raw);
  } catch {
    values = raw.split(",");
  }
  if (!Array.isArray(values)) {
    throw new Error("PICALILY_EMPLOYEE_EMAILS must be a JSON array or comma-separated list.");
  }
  return new Set(
    values
      .map((value) => String(value || "").trim().toLowerCase())
      .filter(Boolean),
  );
}

export async function verifyFirebaseUser(request, env) {
  const auth = String(request.headers.get("authorization") || "");
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) throw Object.assign(new Error("Firebase sign-in is required."), { status: 401 });

  const parts = token.split(".");
  if (parts.length !== 3) {
    throw Object.assign(new Error("Invalid Firebase token."), { status: 401 });
  }

  let header;
  let payload;
  try {
    header = decodeJsonPart(parts[0]);
    payload = decodeJsonPart(parts[1]);
  } catch {
    throw Object.assign(new Error("Invalid Firebase token."), { status: 401 });
  }

  if (header.alg !== "RS256" || !header.kid) {
    throw Object.assign(new Error("Unsupported Firebase token."), { status: 401 });
  }

  const projectId = String(env.FIREBASE_PROJECT_ID || "").trim();
  if (!projectId) {
    throw Object.assign(new Error("Firebase server verification is not configured."), { status: 503 });
  }

  const now = Math.floor(Date.now() / 1000);
  const issuer = "https://securetoken.google.com/" + projectId;
  if (
    payload.iss !== issuer ||
    payload.aud !== projectId ||
    !payload.sub ||
    typeof payload.sub !== "string" ||
    payload.sub.length > 128 ||
    Number(payload.exp || 0) <= now ||
    Number(payload.iat || 0) > now + 60 ||
    Number(payload.auth_time || 0) <= 0 ||
    Number(payload.auth_time || 0) > now + 60
  ) {
    throw Object.assign(new Error("Firebase token claims are invalid or expired."), { status: 401 });
  }

  const jwks = await getFirebaseJwks();
  const jwk = Array.isArray(jwks?.keys)
    ? jwks.keys.find((key) => key.kid === header.kid)
    : null;
  if (!jwk) {
    cachedJwks = null;
    cachedJwksExpiresAt = 0;
    throw Object.assign(new Error("Firebase signing key was not recognized. Retry sign-in."), { status: 401 });
  }

  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signed = new TextEncoder().encode(parts[0] + "." + parts[1]);
  const signature = base64UrlToBytes(parts[2]);
  const valid = await crypto.subtle.verify(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    signature,
    signed,
  );
  if (!valid) {
    throw Object.assign(new Error("Firebase token signature is invalid."), { status: 401 });
  }

  return {
    uid: payload.sub,
    email: String(payload.email || "").trim().toLowerCase(),
    emailVerified: payload.email_verified === true,
    name: String(payload.name || "").trim(),
    picture: String(payload.picture || "").trim(),
    provider: payload.firebase?.sign_in_provider || "",
  };
}

export async function authorizeEmployee(request, env) {
  const user = await verifyFirebaseUser(request, env);
  if (!user.email || !user.emailVerified) {
    throw Object.assign(new Error("A verified email address is required for employee access."), { status: 403 });
  }
  const allowed = employeeEmails(env);
  if (!allowed.has(user.email)) {
    throw Object.assign(new Error("This account is not authorized for employee inventory access."), { status: 403 });
  }
  return user;
}

export async function authMe(request, env) {
  const user = await verifyFirebaseUser(request, env);
  let employee = false;
  if (user.email && user.emailVerified) {
    employee = employeeEmails(env).has(user.email);
  }
  return { ...user, employee };
}
