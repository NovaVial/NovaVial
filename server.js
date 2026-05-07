import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, readFileSync, promises as fs } from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const dataDir = join(root, "data");
const ordersPath = join(dataDir, "orders.json");

loadEnv();

const port = Number(process.env.PORT || 4242);
const squareEnvironment = process.env.SQUARE_ENVIRONMENT === "production" ? "production" : "sandbox";
const squareApiBase =
  squareEnvironment === "production"
    ? "https://connect.squareup.com"
    : "https://connect.squareupsandbox.com";
const currency = (process.env.STORE_CURRENCY || "USD").toUpperCase();

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
};

const products = JSON.parse(await fs.readFile(join(dataDir, "products.json"), "utf8"));
const productById = new Map(products.map((product) => [product.id, product]));
validateProducts(products);

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/api/health") {
      return sendJson(res, {
        ok: true,
        environment: squareEnvironment,
        squareConfigured: hasSquareConfig(),
        productCount: products.length,
      });
    }

    if (req.method === "GET" && url.pathname === "/api/config") {
      return sendJson(res, {
        environment: squareEnvironment,
        applicationId: process.env.SQUARE_APPLICATION_ID || "",
        locationId: process.env.SQUARE_LOCATION_ID || "",
        currency,
      });
    }

    if (req.method === "GET" && url.pathname === "/api/products") {
      return sendJson(res, products);
    }

    if (req.method === "POST" && url.pathname === "/api/payments") {
      const body = await readJson(req);
      const result = await createPayment(body);
      return sendJson(res, result, 201);
    }

    if (req.method === "POST" && url.pathname === "/api/webhooks/square") {
      const rawBody = await readRaw(req);
      const notificationUrl = `${getPublicBaseUrl(req)}/api/webhooks/square`;

      if (!verifySquareWebhook(req, rawBody, notificationUrl)) {
        return sendJson(res, { error: "Invalid webhook signature" }, 401);
      }

      const event = JSON.parse(rawBody || "{}");
      await appendOrderEvent(event);
      return sendJson(res, { ok: true });
    }

    if (req.method === "GET") {
      return serveStatic(url.pathname, res);
    }

    sendJson(res, { error: "Not found" }, 404);
  } catch (error) {
    const status = error.statusCode || 500;
    sendJson(res, { error: error.message || "Server error" }, status);
  }
});

server.listen(port, () => {
  console.log(`NovaVial store running at http://localhost:${port}`);
});

async function createPayment(body) {
  const missingConfig = getMissingSquareConfig();

  if (missingConfig.length > 0) {
    throw httpError(
      500,
      `Square is not configured. Missing: ${missingConfig.join(", ")}. Copy .env.example to .env and add your Square sandbox credentials.`,
    );
  }

  const sourceId = String(body.sourceId || "");
  const cart = Array.isArray(body.cart) ? body.cart : [];
  const customer = sanitizeCustomer(body.customer || {});

  if (!sourceId) {
    throw httpError(400, "Missing Square payment source token.");
  }

  if (cart.length === 0) {
    throw httpError(400, "Your cart is empty.");
  }

  const lineItems = cart.map((item) => {
    const product = productById.get(String(item.id));
    const quantity = Number(item.quantity);

    if (!product || !Number.isInteger(quantity) || quantity < 1 || quantity > 25) {
      throw httpError(400, "Cart contains an invalid item.");
    }

    return {
      id: product.id,
      name: product.name,
      sku: product.sku,
      quantity,
      unitPriceCents: product.priceCents,
      lineTotalCents: product.priceCents * quantity,
    };
  });

  const amountCents = lineItems.reduce((total, item) => total + item.lineTotalCents, 0);
  const idempotencyKey = randomUUID();

  const squareResponse = await fetch(`${squareApiBase}/v2/payments`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
      "Square-Version": process.env.SQUARE_VERSION || "2026-01-22",
    },
    body: JSON.stringify({
      source_id: sourceId,
      idempotency_key: idempotencyKey,
      location_id: process.env.SQUARE_LOCATION_ID,
      amount_money: {
        amount: amountCents,
        currency,
      },
      buyer_email_address: customer.email || undefined,
      shipping_address: {
        address_line_1: customer.address || undefined,
        locality: customer.city || undefined,
        administrative_district_level_1: customer.state || undefined,
        postal_code: customer.postalCode || undefined,
        country: "US",
      },
      note: `NovaVial order: ${lineItems.map((item) => `${item.sku} x${item.quantity}`).join(", ")}`,
    }),
  });

  const squareBody = await squareResponse.json();

  if (!squareResponse.ok) {
    const detail = squareBody.errors?.map((error) => error.detail).join(" ") || "Square payment failed.";
    throw httpError(squareResponse.status, detail);
  }

  const order = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    status: squareBody.payment?.status || "UNKNOWN",
    paymentId: squareBody.payment?.id,
    receiptUrl: squareBody.payment?.receipt_url,
    amountCents,
    currency,
    customer,
    lineItems,
  };

  await appendOrder(order);

  return {
    orderId: order.id,
    status: order.status,
    receiptUrl: order.receiptUrl,
  };
}

function sanitizeCustomer(customer) {
  return {
    email: String(customer.email || "").trim().slice(0, 254),
    name: String(customer.name || "").trim().slice(0, 120),
    company: String(customer.company || "").trim().slice(0, 120),
    address: String(customer.address || "").trim().slice(0, 240),
    city: String(customer.city || "").trim().slice(0, 100),
    state: String(customer.state || "").trim().slice(0, 60),
    postalCode: String(customer.postalCode || "").trim().slice(0, 20),
  };
}

function hasSquareConfig() {
  return getMissingSquareConfig().length === 0;
}

function getMissingSquareConfig() {
  return [
    "SQUARE_ACCESS_TOKEN",
    "SQUARE_APPLICATION_ID",
    "SQUARE_LOCATION_ID",
  ].filter((key) => !process.env[key]);
}

function validateProducts(productList) {
  const seenIds = new Set();

  for (const product of productList) {
    if (!product.id || seenIds.has(product.id)) {
      throw new Error(`Invalid or duplicate product id: ${product.id}`);
    }

    if (!product.name || !Number.isInteger(product.priceCents) || product.priceCents < 1) {
      throw new Error(`Invalid product pricing for ${product.id}`);
    }

    seenIds.add(product.id);
  }
}

async function appendOrder(order) {
  await fs.mkdir(dataDir, { recursive: true });
  const existing = existsSync(ordersPath) ? JSON.parse(await fs.readFile(ordersPath, "utf8")) : [];
  existing.push(order);
  await fs.writeFile(ordersPath, `${JSON.stringify(existing, null, 2)}\n`);
}

async function appendOrderEvent(event) {
  await fs.mkdir(dataDir, { recursive: true });
  const eventsPath = join(dataDir, "square-events.json");
  const existing = existsSync(eventsPath) ? JSON.parse(await fs.readFile(eventsPath, "utf8")) : [];
  existing.push({ receivedAt: new Date().toISOString(), event });
  await fs.writeFile(eventsPath, `${JSON.stringify(existing, null, 2)}\n`);
}

function verifySquareWebhook(req, rawBody, notificationUrl) {
  const signatureKey = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;
  const signature = req.headers["x-square-hmacsha256-signature"];

  if (!signatureKey) {
    return true;
  }

  if (!signature) {
    return false;
  }

  const expected = createHmac("sha256", signatureKey)
    .update(notificationUrl + rawBody)
    .digest("base64");

  const expectedBuffer = Buffer.from(expected);
  const signatureBuffer = Buffer.from(String(signature));

  return (
    expectedBuffer.length === signatureBuffer.length &&
    timingSafeEqual(expectedBuffer, signatureBuffer)
  );
}

function getPublicBaseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}

function serveStatic(pathname, res) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = resolve(root, `.${decodeURIComponent(safePath)}`);

  if (!filePath.startsWith(root) || !existsSync(filePath)) {
    return sendJson(res, { error: "Not found" }, 404);
  }

  res.writeHead(200, {
    ...securityHeaders(),
    "Cache-Control": cacheControlFor(filePath),
    "Content-Type": contentTypes[extname(filePath)] || "application/octet-stream",
  });
  createReadStream(filePath).pipe(res);
}

async function readJson(req) {
  const raw = await readRaw(req);
  try {
    return JSON.parse(raw || "{}");
  } catch {
    throw httpError(400, "Invalid JSON request body.");
  }
}

function readRaw(req) {
  return new Promise((resolveRaw, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(httpError(413, "Request body is too large."));
      }
    });
    req.on("end", () => resolveRaw(raw));
    req.on("error", reject);
  });
}

function sendJson(res, data, status = 200) {
  res.writeHead(status, {
    ...securityHeaders(),
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  res.end(JSON.stringify(data));
}

function securityHeaders() {
  return {
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self' https://web.squarecdn.com https://sandbox.web.squarecdn.com; frame-src https://web.squarecdn.com https://sandbox.web.squarecdn.com; connect-src 'self' https://connect.squareup.com https://connect.squareupsandbox.com; img-src 'self' data:; style-src 'self' 'unsafe-inline'; base-uri 'self'; form-action 'self'",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
}

function cacheControlFor(filePath) {
  return extname(filePath) === ".png" ? "public, max-age=604800, immutable" : "no-cache";
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function loadEnv() {
  const envPath = join(root, ".env");

  if (!existsSync(envPath)) {
    return;
  }

  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
      continue;
    }

    const [key, ...valueParts] = trimmed.split("=");
    if (!process.env[key]) {
      process.env[key] = valueParts.join("=").replace(/^["']|["']$/g, "");
    }
  }
}
