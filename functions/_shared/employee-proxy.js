import { authorizeEmployee } from "./firebase-auth.js";

function required(env, name) {
  const value = String(env[name] || "").trim();
  if (!value) throw Object.assign(new Error("Missing required binding: " + name), { status: 503 });
  return value;
}

function backendBase(env) {
  return required(env, "PICALILY_INVENTORY_URL").replace(/\/+$/, "");
}

function responseHeaders(source) {
  const headers = new Headers();
  const contentType = source.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  headers.set("cache-control", "no-store");
  return headers;
}

export async function employeeProxy(context, employeePath) {
  const user = await authorizeEmployee(context.request, context.env);
  const adminKey = required(context.env, "PICALILY_INVENTORY_ADMIN_KEY");
  const sourceUrl = new URL(context.request.url);
  const target = backendBase(context.env) + "/admin/" + employeePath + sourceUrl.search;

  const headers = new Headers();
  headers.set("x-picalily-admin-key", adminKey);
  const contentType = context.request.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  const fileName = context.request.headers.get("x-file-name");
  if (fileName) headers.set("x-file-name", fileName);
  headers.set("x-picalily-employee", user.email);

  const method = context.request.method.toUpperCase();
  const hasBody = !["GET", "HEAD"].includes(method);
  const upstream = await fetch(target, {
    method,
    headers,
    body: hasBody ? await context.request.arrayBuffer() : undefined,
    redirect: "manual",
  });

  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders(upstream),
  });
}
