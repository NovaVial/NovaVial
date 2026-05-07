import { spawn } from "node:child_process";
import { once } from "node:events";
import { strict as assert } from "node:assert";

const port = 5055;
const baseUrl = `http://127.0.0.1:${port}`;
const child = spawn("node", ["server.js"], {
  env: { ...process.env, PORT: String(port), NODE_ENV: "test" },
  stdio: ["ignore", "pipe", "pipe"],
});

let output = "";
child.stdout.on("data", (chunk) => {
  output += chunk.toString();
});
child.stderr.on("data", (chunk) => {
  output += chunk.toString();
});

try {
  await waitForServer();

  const health = await getJson("/api/health");
  assert.equal(health.ok, true);
  assert.equal(health.productCount, 12);

  const config = await getJson("/api/config");
  assert.equal(config.environment, "sandbox");
  assert.equal(config.currency, "USD");

  const products = await getJson("/api/products");
  assert.equal(products.length, 12);
  assert.equal(products[0].id, "adipotide");

  const home = await fetch(`${baseUrl}/`);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /NovaVial Research/);

  const storeScript = await fetch(`${baseUrl}/scripts/store.js`);
  assert.equal(storeScript.status, 200);
  assert.match(await storeScript.text(), /bootStore/);

  const policy = await fetch(`${baseUrl}/shipping.html`);
  assert.equal(policy.status, 200);
  assert.match(await policy.text(), /Shipping Policy/);

  const missingSquare = await fetch(`${baseUrl}/api/payments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sourceId: "cnon:test",
      cart: [{ id: "bac-water", quantity: 1 }],
      customer: { email: "test@example.com" },
    }),
  });
  assert.equal(missingSquare.status, 500);
  assert.match((await missingSquare.json()).error, /Square is not configured/);

  console.log("smoke tests passed");
} finally {
  if (!child.killed) {
    child.kill("SIGTERM");
  }
  await Promise.race([
    once(child, "exit").catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 1000)),
  ]);
}

async function getJson(path) {
  const response = await fetch(`${baseUrl}${path}`);
  assert.equal(response.status, 200);
  return response.json();
}

async function waitForServer() {
  const deadline = Date.now() + 5000;

  while (Date.now() < deadline) {
    if (output.includes("NovaVial store running")) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Server did not start. Output:\n${output}`);
}
