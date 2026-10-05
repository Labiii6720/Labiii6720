import { config } from "./config.js";

async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  if (!config.shopify) throw new Error("Shopify ist nicht eingerichtet (SHOPIFY_SHOP, SHOPIFY_TOKEN).");
  const { shop, token, version } = config.shopify;
  const res = await fetch(`https://${shop}.myshopify.com/admin/api/${version}/graphql.json`, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Shopify HTTP ${res.status}`);
  const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (json.errors?.length) throw new Error(`Shopify: ${json.errors.map((e) => e.message).join("; ")}`);
  if (!json.data) throw new Error("Shopify: leere Antwort");
  return json.data;
}

interface Money { amount: string; currencyCode: string }

export async function recentOrders(count = 10): Promise<string> {
  const data = await gql<{ orders: { nodes: { name: string; createdAt: string; displayFinancialStatus: string; displayFulfillmentStatus: string; totalPriceSet: { shopMoney: Money }; customer?: { displayName: string } }[] } }>(
    `query($n: Int!) { orders(first: $n, sortKey: CREATED_AT, reverse: true) { nodes {
       name createdAt displayFinancialStatus displayFulfillmentStatus
       totalPriceSet { shopMoney { amount currencyCode } } customer { displayName } } } }`,
    { n: Math.min(Math.max(count, 1), 50) },
  );
  const rows = data.orders.nodes.map(
    (o) => `${o.name} · ${o.createdAt.slice(0, 16)} · ${o.totalPriceSet.shopMoney.amount} ${o.totalPriceSet.shopMoney.currencyCode} · ${o.displayFinancialStatus}/${o.displayFulfillmentStatus}${o.customer ? " · " + o.customer.displayName : ""}`,
  );
  return rows.join("\n") || "Keine Bestellungen.";
}

export async function searchProducts(search?: string): Promise<string> {
  const data = await gql<{ products: { nodes: { id: string; title: string; status: string; variants: { nodes: { id: string; title: string; price: string; inventoryQuantity: number | null }[] } }[] } }>(
    `query($q: String) { products(first: 20, query: $q) { nodes {
       id title status variants(first: 10) { nodes { id title price inventoryQuantity } } } } }`,
    { q: search || null },
  );
  const rows = data.products.nodes.map((p) => {
    const v = p.variants.nodes.map((x) => `    ${x.id} · ${x.title} · ${x.price} · Lager ${x.inventoryQuantity ?? "?"}`).join("\n");
    return `${p.title} (${p.status}) · ${p.id}\n${v}`;
  });
  return rows.join("\n") || "Keine Produkte.";
}

/** Preis einer Variante ändern – läuft nur nach Freigabe. */
export async function updatePrice(productId: string, variantId: string, price: string): Promise<string> {
  const data = await gql<{ productVariantsBulkUpdate: { productVariants: { id: string; price: string }[]; userErrors: { message: string }[] } }>(
    `mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
       productVariantsBulkUpdate(productId: $productId, variants: $variants) {
         productVariants { id price } userErrors { field message } } }`,
    { productId, variants: [{ id: variantId, price }] },
  );
  const errs = data.productVariantsBulkUpdate.userErrors;
  if (errs.length) throw new Error(errs.map((e) => e.message).join("; "));
  return data.productVariantsBulkUpdate.productVariants.map((v) => `${v.id} → ${v.price}`).join(", ");
}
