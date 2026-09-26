const config = window.PICALILY_FIREBASE_CONFIG || {};
const firebaseConfigured = Boolean(
  config.enabled &&
  config.apiKey &&
  config.authDomain &&
  config.projectId &&
  config.appId
);

const qs = (selector) => document.querySelector(selector);
const qsa = (selector) => [...document.querySelectorAll(selector)];

let authModule = null;
let auth = null;
let currentUser = null;
let currentProduct = null;
let selectedImageFile = null;
let categories = [];
let currentPage = 1;
let currentPageSize = 40;
let currentTotal = 0;
let deferredInstallPrompt = null;
let searchTimer = null;

const screens = {
  boot: qs("#boot-screen"),
  setup: qs("#setup-screen"),
  login: qs("#login-screen"),
  denied: qs("#denied-screen"),
  app: qs("#employee-app"),
};

function showOnly(name) {
  Object.entries(screens).forEach(([key, el]) => {
    el.hidden = key !== name;
  });
}

function showGlobal(message, timeout = 2600) {
  const el = qs("#global-status");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(showGlobal.timer);
  showGlobal.timer = setTimeout(() => { el.hidden = true; }, timeout);
}

function setLoginStatus(message = "", good = false) {
  const el = qs("#login-status");
  if (!message) {
    el.hidden = true;
    el.textContent = "";
    el.className = "status-message";
    return;
  }
  el.hidden = false;
  el.textContent = message;
  el.className = "status-message" + (good ? " good" : "");
}

async function employeeFetch(path, options = {}, retry = true) {
  if (!currentUser) throw new Error("Sign in is required.");
  const token = await currentUser.getIdToken(false);
  const headers = new Headers(options.headers || {});
  headers.set("Authorization", "Bearer " + token);

  const response = await fetch("/api/employee/" + path.replace(/^\/+/, ""), {
    ...options,
    headers,
    cache: "no-store",
  });

  if (response.status === 401 && retry) {
    await currentUser.getIdToken(true);
    return employeeFetch(path, options, false);
  }

  if (!response.ok) {
    let message = "Request failed.";
    try {
      const payload = await response.json();
      message = payload?.error || message;
    } catch {
      try { message = await response.text() || message; } catch {}
    }
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }

  if (response.status === 204) return null;
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) return response.json();
  return response;
}

async function authMe() {
  if (!currentUser) throw new Error("Sign in is required.");
  const token = await currentUser.getIdToken();
  const response = await fetch("/api/auth/me", {
    headers: { Authorization: "Bearer " + token },
    cache: "no-store",
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.error || "Unable to verify employee access.");
    error.status = response.status;
    throw error;
  }
  return payload.user;
}

function switchView(view) {
  qsa(".view").forEach((el) => el.classList.toggle("active", el.id === "view-" + view));
  qsa("[data-view]").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === view);
  });

  const titles = {
    dashboard: "Inventory Dashboard",
    products: "Products",
    settings: "Settings",
  };
  qs("#page-title").textContent = titles[view] || "Inventory";

  if (view === "dashboard") void loadDashboard();
  if (view === "products") void loadProducts();
  if (view === "settings") void loadSettingsStatus();
}

async function loadDashboard() {
  try {
    const [stats, health] = await Promise.all([
      employeeFetch("dashboard"),
      fetch("/api/health", { cache: "no-store" }).then((r) => r.json()).catch(() => null),
    ]);
    qs("#stat-total").textContent = Number(stats.total_products || 0).toLocaleString();
    qs("#stat-published").textContent = Number(stats.published_products || 0).toLocaleString();
    qs("#stat-categories").textContent = Number(stats.categories || 0).toLocaleString();
    qs("#stat-low").textContent = Number(stats.low_stock || 0).toLocaleString();
    qs("#stat-out").textContent = Number(stats.out_of_stock || 0).toLocaleString();
    qs("#stat-images").textContent = Number(stats.products_with_images || 0).toLocaleString();
    qs("#backend-state").textContent = health?.inventory?.ok === false ? "Backend unavailable" : "Connected";
    qs("#dashboard-email").textContent = currentUser?.email || "—";
  } catch (error) {
    qs("#backend-state").textContent = "Unavailable";
    showGlobal(error.message || "Unable to load dashboard.");
  }
}

async function loadCategories() {
  try {
    categories = await employeeFetch("categories");
  } catch {
    categories = [];
  }

  const select = qs("#product-category");
  const active = select.value;
  select.innerHTML = '<option value="">All categories</option>' +
    categories.map((category) => '<option value="' + escapeHtml(category) + '">' + escapeHtml(category) + "</option>").join("");
  select.value = categories.includes(active) ? active : "";

  qs("#category-options").innerHTML = categories
    .map((category) => '<option value="' + escapeHtml(category) + '"></option>')
    .join("");
}

function productQuery() {
  const params = new URLSearchParams();
  const search = qs("#product-search").value.trim();
  const category = qs("#product-category").value;
  const stock = qs("#product-stock").value;
  const published = qs("#product-published").value;
  if (search) params.set("search", search);
  if (category) params.set("category", category);
  if (stock) params.set("stock", stock);
  if (published) params.set("published", published);
  params.set("page", String(currentPage));
  params.set("page_size", String(currentPageSize));
  params.set("sort", "name");
  return params.toString();
}

async function loadProducts() {
  try {
    if (!categories.length) await loadCategories();
    const page = await employeeFetch("products?" + productQuery());
    currentTotal = Number(page.total || 0);
    renderProducts(page.products || []);
    const pageCount = Math.max(1, Math.ceil(currentTotal / currentPageSize));
    if (currentPage > pageCount) {
      currentPage = pageCount;
      return loadProducts();
    }
    qs("#page-info").textContent = "Page " + currentPage + " of " + pageCount + " • " + currentTotal.toLocaleString() + " products";
    qs("#prev-page").disabled = currentPage <= 1;
    qs("#next-page").disabled = currentPage >= pageCount;
  } catch (error) {
    renderProducts([]);
    showGlobal(error.message || "Unable to load products.");
  }
}

function renderProducts(products) {
  const list = qs("#product-list");
  const empty = qs("#product-empty");
  empty.hidden = products.length > 0;
  list.innerHTML = products.map((product) => {
    const price = product.sale_active ? product.sale_price : product.regular_price;
    const stock = product.tracks_quantity
      ? (product.quantity <= 0 ? "Out" : product.quantity <= 5 ? "Low: " + product.quantity : "Qty: " + product.quantity)
      : "Not tracked";
    const stockClass = product.tracks_quantity && product.quantity <= 0
      ? "warn"
      : product.tracks_quantity && product.quantity <= 5 ? "warn" : "good";
    const visibility = product.published && !product.disabled ? "Published" : "Hidden";
    const image = product.public_id
      ? '<img class="product-thumb" loading="lazy" src="/api/images/' + encodeURIComponent(product.public_id) + '" alt="" onerror="this.outerHTML=\'<div class=&quot;product-thumb product-thumb-placeholder&quot;>✿</div>\'">'
      : '<div class="product-thumb product-thumb-placeholder">✿</div>';
    return `
      <article class="product-row" data-product-id="${escapeHtml(product.id)}" tabindex="0">
        ${image}
        <div class="product-copy">
          <h3>${escapeHtml(product.name || "Unnamed Product")}</h3>
          <div class="product-meta">
            <span>${escapeHtml(product.category || "Uncategorized")}</span>
            <span class="pill ${stockClass}">${escapeHtml(stock)}</span>
            <span class="pill">${visibility}</span>
          </div>
        </div>
        <div class="product-price">
          <strong>$${Number(price || 0).toFixed(2)}</strong>
          <small>Edit ›</small>
        </div>
      </article>
    `;
  }).join("");

  qsa(".product-row").forEach((row) => {
    const open = () => void openEditor(row.dataset.productId);
    row.addEventListener("click", open);
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open();
      }
    });
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function setEditorStatus(message = "", good = false) {
  const el = qs("#editor-status");
  if (!message) {
    el.hidden = true;
    el.textContent = "";
    el.className = "status-message";
    return;
  }
  el.hidden = false;
  el.textContent = message;
  el.className = "status-message" + (good ? " good" : "");
}

function localDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 16);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function updateImagePreview(product, file = null) {
  const image = qs("#editor-image");
  const placeholder = qs("#editor-image-placeholder");
  if (file) {
    image.src = URL.createObjectURL(file);
    image.hidden = false;
    placeholder.hidden = true;
    return;
  }
  if (product?.public_id && (product.image_path || product.picture_url)) {
    image.src = "/api/images/" + encodeURIComponent(product.public_id) + "?t=" + Date.now();
    image.hidden = false;
    placeholder.hidden = true;
    image.onerror = () => {
      image.hidden = true;
      placeholder.hidden = false;
    };
  } else {
    image.removeAttribute("src");
    image.hidden = true;
    placeholder.hidden = false;
  }
}

function populateEditor(product = null) {
  currentProduct = product;
  selectedImageFile = null;
  qs("#editor-image-file").value = "";
  qs("#editor-id").value = product?.id || "";
  qs("#editor-name").value = product?.name || "";
  qs("#editor-category").value = product?.category || "";
  qs("#editor-barcode").value = product?.barcode || "";
  qs("#editor-regular-price").value = product?.regular_price ?? "";
  qs("#editor-sale-price").value = product?.sale_price ?? "";
  qs("#editor-quantity").value = product?.quantity ?? 0;
  qs("#editor-picture-url").value = product?.picture_url || "";
  qs("#editor-description").value = product?.description || "";
  qs("#editor-published").checked = product ? Boolean(product.published) : true;
  qs("#editor-taxable").checked = product ? Boolean(product.taxable) : true;
  qs("#editor-track-quantity").checked = product ? Boolean(product.tracks_quantity) : true;
  qs("#editor-disabled").checked = Boolean(product?.disabled);
  qs("#editor-sale-enabled").checked = Boolean(product?.sale_price_flag);
  qs("#editor-sale-start-enabled").checked = Boolean(product?.sale_start_enabled);
  qs("#editor-sale-end-enabled").checked = Boolean(product?.sale_end_enabled);
  qs("#editor-sale-start").value = localDateTime(product?.sale_start);
  qs("#editor-sale-end").value = localDateTime(product?.sale_end);
  const shipping = product?.shipping || {};
  qs("#editor-shippable").checked = Boolean(shipping.shippable);
  qs("#editor-package-type").value = shipping.package_type || "custom_box";
  qs("#editor-weight-lb").value = shipping.weight_lb ?? 0;
  qs("#editor-length-in").value = shipping.length_in ?? 0;
  qs("#editor-width-in").value = shipping.width_in ?? 0;
  qs("#editor-height-in").value = shipping.height_in ?? 0;
  qs("#editor-ships-separately").checked = Boolean(shipping.ships_separately);
  qs("#editor-max-units-package").value = shipping.max_units_per_package ?? 1;
  qs("#editor-signature-required").checked = Boolean(shipping.signature_required);
  qs("#editor-hazmat").checked = Boolean(shipping.hazardous_materials);
  qs("#editor-dry-ice-weight").value = shipping.dry_ice_weight_lb ?? 0;
  qs("#editor-perishable").checked = Boolean(shipping.perishable);
  qs("#editor-origin-country").value = shipping.country_of_origin || "";
  qs("#editor-hs-code").value = shipping.hs_code || "";
  qs("#editor-customs-description").value = shipping.customs_description || "";
  qs("#editor-declared-value").value = shipping.declared_value_override ?? 0;
  qs("#editor-title").textContent = product ? "Edit Product" : "Add Product";
  qs("#editor-eyebrow").textContent = product ? "Product #" + product.public_id : "New inventory item";
  qs("#editor-delete").hidden = !product;
  qs("#editor-remove-image").hidden = !product || (!product.image_path && !product.picture_url);
  setEditorStatus();
  updateImagePreview(product);
}

async function openEditor(id = null) {
  try {
    let product = null;
    if (id) product = await employeeFetch("products/" + encodeURIComponent(id));
    populateEditor(product);
    const dialog = qs("#product-editor");
    if (!dialog.open) dialog.showModal();
  } catch (error) {
    showGlobal(error.message || "Unable to open product.");
  }
}

function editorPayload() {
  return {
    id: qs("#editor-id").value || undefined,
    category: qs("#editor-category").value.trim(),
    name: qs("#editor-name").value.trim(),
    description: qs("#editor-description").value.trim(),
    barcode: qs("#editor-barcode").value.trim(),
    regular_price: Number(qs("#editor-regular-price").value || 0),
    sale_price: Number(qs("#editor-sale-price").value || 0),
    sale_price_flag: qs("#editor-sale-enabled").checked,
    quantity: Math.max(0, Math.trunc(Number(qs("#editor-quantity").value || 0))),
    tracks_quantity: qs("#editor-track-quantity").checked,
    disabled: qs("#editor-disabled").checked,
    taxable: qs("#editor-taxable").checked,
    published: qs("#editor-published").checked,
    picture_url: qs("#editor-picture-url").value.trim(),
    sale_start_enabled: qs("#editor-sale-start-enabled").checked,
    sale_start: qs("#editor-sale-start").value,
    sale_end_enabled: qs("#editor-sale-end-enabled").checked,
    sale_end: qs("#editor-sale-end").value,
    shipping: {
      shippable: qs("#editor-shippable").checked,
      package_type: qs("#editor-package-type").value || "custom_box",
      weight_lb: Number(qs("#editor-weight-lb").value || 0),
      length_in: Number(qs("#editor-length-in").value || 0),
      width_in: Number(qs("#editor-width-in").value || 0),
      height_in: Number(qs("#editor-height-in").value || 0),
      ships_separately: qs("#editor-ships-separately").checked,
      max_units_per_package: Math.max(1, Math.trunc(Number(qs("#editor-max-units-package").value || 1))),
      signature_required: qs("#editor-signature-required").checked,
      hazardous_materials: qs("#editor-hazmat").checked,
      dry_ice_weight_lb: Number(qs("#editor-dry-ice-weight").value || 0),
      perishable: qs("#editor-perishable").checked,
      country_of_origin: qs("#editor-origin-country").value.trim().toUpperCase(),
      hs_code: qs("#editor-hs-code").value.trim(),
      customs_description: qs("#editor-customs-description").value.trim(),
      declared_value_override: Number(qs("#editor-declared-value").value || 0),
    },
  };
}

async function saveEditor(event) {
  event.preventDefault();
  const button = qs("#editor-save");
  button.disabled = true;
  setEditorStatus();
  try {
    const payload = editorPayload();
    if (!payload.name) throw new Error("Product name is required.");
    const id = qs("#editor-id").value;
    const saved = await employeeFetch(
      id ? "products/" + encodeURIComponent(id) : "products",
      {
        method: id ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
    );

    let finalProduct = saved;
    if (selectedImageFile) {
      finalProduct = await employeeFetch(
        "products/" + encodeURIComponent(saved.id) + "/image",
        {
          method: "PUT",
          headers: {
            "Content-Type": selectedImageFile.type || "image/jpeg",
            "X-File-Name": selectedImageFile.name || "mobile-upload.jpg",
          },
          body: selectedImageFile,
        },
      );
    }

    currentProduct = finalProduct;
    setEditorStatus("Product saved.", true);
    await Promise.all([loadCategories(), loadProducts(), loadDashboard()]);
    setTimeout(() => qs("#product-editor").close(), 450);
  } catch (error) {
    setEditorStatus(error.message || "Unable to save product.");
  } finally {
    button.disabled = false;
  }
}

async function deleteCurrentProduct() {
  if (!currentProduct) return;
  if (!confirm("Delete “" + currentProduct.name + "” from inventory?")) return;
  try {
    await employeeFetch("products/" + encodeURIComponent(currentProduct.id), { method: "DELETE" });
    qs("#product-editor").close();
    showGlobal("Product deleted.");
    await Promise.all([loadCategories(), loadProducts(), loadDashboard()]);
  } catch (error) {
    setEditorStatus(error.message || "Unable to delete product.");
  }
}

async function removeCurrentImage() {
  selectedImageFile = null;
  qs("#editor-image-file").value = "";
  if (!currentProduct) {
    updateImagePreview(null);
    return;
  }
  try {
    currentProduct = await employeeFetch(
      "products/" + encodeURIComponent(currentProduct.id) + "/image",
      { method: "DELETE" },
    );
    qs("#editor-picture-url").value = "";
    qs("#editor-remove-image").hidden = true;
    updateImagePreview(currentProduct);
    setEditorStatus("Product image removed.", true);
  } catch (error) {
    setEditorStatus(error.message || "Unable to remove image.");
  }
}

async function loadSettingsStatus() {
  qs("#settings-name").textContent = currentUser?.displayName || "Signed in";
  qs("#settings-email").textContent = currentUser?.email || "—";
  try {
    const response = await fetch("/api/health", { cache: "no-store" });
    const health = await response.json();
    const connected = response.ok && health?.inventory && health.inventory.ok !== false;
    qs("#settings-backend").textContent = connected
      ? "Connected to the Picalily Inventory backend through Cloudflare."
      : "Cloudflare is reachable, but the shop inventory backend is currently unavailable.";
  } catch {
    qs("#settings-backend").textContent = "Unable to reach the Cloudflare API.";
  }
}

function bindUi() {
  qsa("[data-view]").forEach((button) => {
    button.addEventListener("click", () => switchView(button.dataset.view));
  });
  qsa("[data-add-product]").forEach((button) => {
    button.addEventListener("click", () => void openEditor());
  });
  qs("#top-add-product").addEventListener("click", () => void openEditor());
  qsa("[data-go-products]").forEach((button) => {
    button.addEventListener("click", () => switchView("products"));
  });

  qs("#dashboard-refresh").onclick = () => void loadDashboard();
  qs("#settings-refresh").onclick = () => void loadSettingsStatus();
  qs("#settings-signout").onclick = () => authModule?.signOut(auth);

  qs("#product-search").addEventListener("input", () => {
    qs("#product-search-clear").hidden = !qs("#product-search").value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      currentPage = 1;
      void loadProducts();
    }, 260);
  });
  qs("#product-search-clear").onclick = () => {
    qs("#product-search").value = "";
    qs("#product-search-clear").hidden = true;
    currentPage = 1;
    void loadProducts();
  };
  qs("#product-search-clear").hidden = true;

  ["#product-category", "#product-stock", "#product-published"].forEach((selector) => {
    qs(selector).addEventListener("change", () => {
      currentPage = 1;
      void loadProducts();
    });
  });

  qs("#prev-page").onclick = () => {
    if (currentPage > 1) {
      currentPage--;
      void loadProducts();
    }
  };
  qs("#next-page").onclick = () => {
    if (currentPage * currentPageSize < currentTotal) {
      currentPage++;
      void loadProducts();
    }
  };

  qs("#product-form").addEventListener("submit", saveEditor);
  qs("#editor-close").onclick = () => qs("#product-editor").close();
  qs("#editor-cancel").onclick = () => qs("#product-editor").close();
  qs("#editor-delete").onclick = deleteCurrentProduct;
  qs("#editor-remove-image").onclick = removeCurrentImage;
  qs("#editor-image-file").addEventListener("change", (event) => {
    selectedImageFile = event.target.files?.[0] || null;
    if (selectedImageFile) updateImagePreview(currentProduct, selectedImageFile);
  });

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    qs("#install-pwa").hidden = false;
  });
  qs("#install-pwa").onclick = async () => {
    if (!deferredInstallPrompt) return;
    await deferredInstallPrompt.prompt();
    deferredInstallPrompt = null;
    qs("#install-pwa").hidden = true;
  };
}

async function initializeFirebase() {
  if (!firebaseConfigured) {
    showOnly("setup");
    return;
  }

  const [{ initializeApp }, module] = await Promise.all([
    import("https://www.gstatic.com/firebasejs/12.3.0/firebase-app.js"),
    import("https://www.gstatic.com/firebasejs/12.3.0/firebase-auth.js"),
  ]);
  authModule = module;
  const app = initializeApp(config, "picalily-employee-pwa");
  auth = module.getAuth(app);
  await module.setPersistence(auth, module.browserLocalPersistence);

  const google = new module.GoogleAuthProvider();
  google.setCustomParameters({ prompt: "select_account" });

  qs("#login-google").onclick = async () => {
    setLoginStatus();
    try {
      await module.signInWithPopup(auth, google);
    } catch (error) {
      if (["auth/popup-blocked", "auth/cancelled-popup-request"].includes(error?.code)) {
        await module.signInWithRedirect(auth, google);
        return;
      }
      setLoginStatus(error?.message || "Google sign-in failed.");
    }
  };

  qs("#login-form").onsubmit = async (event) => {
    event.preventDefault();
    setLoginStatus();
    try {
      await module.signInWithEmailAndPassword(
        auth,
        qs("#login-email").value.trim(),
        qs("#login-password").value,
      );
    } catch (error) {
      setLoginStatus(error?.message || "Email sign-in failed.");
    }
  };

  qs("#login-reset").onclick = async () => {
    const email = qs("#login-email").value.trim();
    if (!email) {
      setLoginStatus("Enter your email first.");
      return;
    }
    try {
      await module.sendPasswordResetEmail(auth, email);
      setLoginStatus("Password-reset email sent.", true);
    } catch (error) {
      setLoginStatus(error?.message || "Unable to send password-reset email.");
    }
  };

  qs("#denied-signout").onclick = () => module.signOut(auth);

  module.onAuthStateChanged(auth, async (user) => {
    currentUser = user;
    if (!user) {
      showOnly("login");
      return;
    }

    showOnly("boot");
    try {
      const profile = await authMe();
      if (!profile.employee) {
        qs("#denied-message").textContent =
          (profile.email || user.email || "This account") +
          " is signed in, but is not listed as a Picalily employee.";
        showOnly("denied");
        return;
      }

      qs("#dashboard-email").textContent = profile.email || user.email || "—";
      qs("#settings-name").textContent = profile.name || user.displayName || "Signed in";
      qs("#settings-email").textContent = profile.email || user.email || "—";
      showOnly("app");
      await Promise.all([loadCategories(), loadDashboard()]);
    } catch (error) {
      if (error.status === 403) {
        qs("#denied-message").textContent = error.message;
        showOnly("denied");
      } else {
        showOnly("login");
        setLoginStatus(error.message || "Unable to verify employee access.");
      }
    }
  });
}

bindUi();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js", { scope: "./" }).catch(() => {});
  });
}

initializeFirebase().catch((error) => {
  console.error(error);
  showOnly("login");
  setLoginStatus("Unable to initialize Firebase authentication.");
});
