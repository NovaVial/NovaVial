let products = [];
let squareCard = null;
let squareConfig = null;

const cart = JSON.parse(localStorage.getItem("novavial-cart") || "[]");
const productGrid = document.querySelector("#productGrid");
const searchInput = document.querySelector("#searchInput");
const emptyState = document.querySelector("#emptyState");
const menuButton = document.querySelector("#menuButton");
const mobileNav = document.querySelector("#mobileNav");
const cartButton = document.querySelector("#cartButton");
const cartCount = document.querySelector("#cartCount");
const checkoutDrawer = document.querySelector("#checkoutDrawer");
const checkoutOverlay = document.querySelector("#checkoutOverlay");
const closeCheckout = document.querySelector("#closeCheckout");
const cartItems = document.querySelector("#cartItems");
const cartTotal = document.querySelector("#cartTotal");
const checkoutForm = document.querySelector("#checkoutForm");
const paymentStatus = document.querySelector("#paymentStatus");
const payButton = document.querySelector("#payButton");

function flaskIcon() {
  return `
    <svg class="flask-line" width="54" height="54" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M9 2h6M10 2v6.5L5.4 17A3.3 3.3 0 0 0 8.3 22h7.4a3.3 3.3 0 0 0 2.9-5L14 8.5V2" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"></path>
      <path d="M8.3 15h7.4" stroke="currentColor" stroke-width="1.45" stroke-linecap="round"></path>
    </svg>
  `;
}

function money(cents) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: squareConfig?.currency || "USD",
  }).format(cents / 100);
}

function renderProducts(items) {
  productGrid.innerHTML = items
    .map((product, index) => {
      return `
        <article class="product-card">
          <span class="sale-badge">Sale</span>
          <div class="product-art" aria-hidden="true">
            <div class="vial">
              ${flaskIcon()}
              <span class="lot">${product.sku}</span>
            </div>
          </div>
          <div class="product-body">
            <h3>${product.name}</h3>
            <div class="price-row">
              <span class="was">${money(product.wasCents)}</span>
              <span class="now">${money(product.priceCents)}</span>
            </div>
            <button class="product-button" type="button" data-product-id="${product.id}">Add to Cart</button>
          </div>
        </article>
      `;
    })
    .join("");

  emptyState.classList.toggle("visible", items.length === 0);
}

function saveCart() {
  localStorage.setItem("novavial-cart", JSON.stringify(cart));
}

function getProduct(id) {
  return products.find((product) => product.id === id);
}

function addToCart(id) {
  const line = cart.find((item) => item.id === id);
  if (line) {
    line.quantity += 1;
  } else {
    cart.push({ id, quantity: 1 });
  }
  saveCart();
  renderCart();
  openCheckout();
}

function updateQuantity(id, delta) {
  const line = cart.find((item) => item.id === id);
  if (!line) return;
  line.quantity += delta;
  if (line.quantity < 1) {
    cart.splice(cart.indexOf(line), 1);
  }
  saveCart();
  renderCart();
}

function cartSubtotal() {
  return cart.reduce((total, line) => {
    const product = getProduct(line.id);
    return product ? total + product.priceCents * line.quantity : total;
  }, 0);
}

function renderCart() {
  const validLines = cart.filter((line) => getProduct(line.id));
  cart.length = 0;
  cart.push(...validLines);

  const count = cart.reduce((total, line) => total + line.quantity, 0);
  cartCount.textContent = String(count);
  cartTotal.textContent = money(cartSubtotal());
  payButton.disabled = count === 0;

  cartItems.innerHTML =
    cart.length === 0
      ? '<p class="checkout-note">Your cart is empty.</p>'
      : cart
          .map((line) => {
            const product = getProduct(line.id);
            return `
              <div class="cart-line">
                <div>
                  <strong>${product.name}</strong>
                  <span>${product.sku} · ${money(product.priceCents)} each</span>
                </div>
                <div class="quantity-controls" aria-label="Quantity controls">
                  <button type="button" data-quantity="-1" data-product-id="${line.id}">-</button>
                  <strong>${line.quantity}</strong>
                  <button type="button" data-quantity="1" data-product-id="${line.id}">+</button>
                </div>
              </div>
            `;
          })
          .join("");
}

function filterProducts() {
  const query = searchInput.value.trim().toLowerCase();
  const filtered = products.filter((product) => product.name.toLowerCase().includes(query));
  renderProducts(filtered);
}

function openCheckout() {
  checkoutDrawer.classList.add("open");
  checkoutOverlay.classList.add("open");
  checkoutDrawer.setAttribute("aria-hidden", "false");
  initializeSquareCard();
}

function closeCheckoutDrawer() {
  checkoutDrawer.classList.remove("open");
  checkoutOverlay.classList.remove("open");
  checkoutDrawer.setAttribute("aria-hidden", "true");
}

async function loadSquareScript(environment) {
  if (window.Square) return;

  const script = document.createElement("script");
  script.src =
    environment === "production"
      ? "https://web.squarecdn.com/v1/square.js"
      : "https://sandbox.web.squarecdn.com/v1/square.js";
  script.async = true;
  document.head.appendChild(script);

  await new Promise((resolve, reject) => {
    script.onload = resolve;
    script.onerror = () => reject(new Error("Square Web Payments SDK failed to load."));
  });
}

async function initializeSquareCard() {
  if (squareCard || !squareConfig?.applicationId || !squareConfig?.locationId) {
    if (!squareConfig?.applicationId || !squareConfig?.locationId) {
      setStatus("Square sandbox keys are not configured yet. Add them to .env and restart the server.", "error");
    }
    return;
  }

  try {
    await loadSquareScript(squareConfig.environment);
    const payments = window.Square.payments(squareConfig.applicationId, squareConfig.locationId);
    squareCard = await payments.card();
    await squareCard.attach("#cardContainer");
    setStatus("Enter sandbox card details to test checkout.");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

function setStatus(message, type = "") {
  paymentStatus.textContent = message || "";
  paymentStatus.className = `status-message ${type}`;
}

async function submitPayment(event) {
  event.preventDefault();

  if (cart.length === 0) {
    setStatus("Add at least one product before checkout.", "error");
    return;
  }

  if (!squareCard) {
    setStatus("Square payment form is not ready yet.", "error");
    await initializeSquareCard();
    return;
  }

  payButton.disabled = true;
  setStatus("Processing payment...");

  try {
    const formData = new FormData(checkoutForm);
    const nameParts = String(formData.get("name") || "").trim().split(/\s+/);
    const tokenResult = await squareCard.tokenize({
      amount: (cartSubtotal() / 100).toFixed(2),
      currencyCode: squareConfig.currency,
      intent: "CHARGE",
      customerInitiated: true,
      sellerKeyedIn: false,
      billingContact: {
        givenName: nameParts.slice(0, -1).join(" ") || nameParts[0] || "",
        familyName: nameParts.length > 1 ? nameParts[nameParts.length - 1] : "",
        email: String(formData.get("email") || ""),
        addressLines: [String(formData.get("address") || "")],
        city: String(formData.get("city") || ""),
        state: String(formData.get("state") || ""),
        postalCode: String(formData.get("postalCode") || ""),
        countryCode: "US",
      },
    });
    if (tokenResult.status !== "OK") {
      throw new Error(tokenResult.errors?.[0]?.message || "Unable to tokenize card.");
    }

    const response = await fetch("/api/payments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceId: tokenResult.token,
        cart,
        customer: Object.fromEntries(formData.entries()),
      }),
    });

    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error || "Payment failed.");
    }

    cart.length = 0;
    saveCart();
    renderCart();
    checkoutForm.reset();
    setStatus(
      result.receiptUrl ? `Payment approved. Receipt: ${result.receiptUrl}` : "Payment approved.",
      "success",
    );
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    payButton.disabled = cart.length === 0;
  }
}

menuButton.addEventListener("click", () => {
  const isOpen = mobileNav.classList.toggle("open");
  menuButton.setAttribute("aria-expanded", String(isOpen));
  menuButton.innerHTML = isOpen
    ? '<svg width="25" height="25" viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'
    : '<svg width="25" height="25" viewBox="0 0 24 24" fill="none"><path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
});

mobileNav.querySelectorAll("a").forEach((link) => {
  link.addEventListener("click", () => {
    mobileNav.classList.remove("open");
    menuButton.setAttribute("aria-expanded", "false");
    menuButton.innerHTML =
      '<svg width="25" height="25" viewBox="0 0 24 24" fill="none"><path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  });
});

searchInput.addEventListener("input", filterProducts);
productGrid.addEventListener("click", (event) => {
  const button = event.target.closest("[data-product-id]");
  if (button) {
    addToCart(button.dataset.productId);
  }
});
cartItems.addEventListener("click", (event) => {
  const button = event.target.closest("[data-quantity]");
  if (button) {
    updateQuantity(button.dataset.productId, Number(button.dataset.quantity));
  }
});
cartButton.addEventListener("click", openCheckout);
closeCheckout.addEventListener("click", closeCheckoutDrawer);
checkoutOverlay.addEventListener("click", closeCheckoutDrawer);
checkoutForm.addEventListener("submit", submitPayment);

async function bootStore() {
  try {
    const [configResponse, productsResponse] = await Promise.all([
      fetch("/api/config"),
      fetch("/api/products"),
    ]);
    squareConfig = await configResponse.json();
    products = await productsResponse.json();
    renderProducts(products);
    renderCart();
  } catch {
    setStatus("Start the backend with npm start, then open http://localhost:4242.", "error");
  }
}

bootStore();
