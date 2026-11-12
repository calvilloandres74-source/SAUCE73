import { getStore } from "@netlify/blobs";

export const config = { path: "/api/stock" };

const HOLD_MS = 15 * 60 * 1000; // un carrito aparta sus productos 15 min (se renueva mientras siga abierto)
const MAX_HOLDS = 300;
const H = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: H });

async function readHolds(store, now) {
  const h = (await store.get("holds", { type: "json" })) || {};
  for (const id of Object.keys(h)) if (!h[id] || h[id].exp <= now) delete h[id];
  return h;
}
function heldBy(holds, exceptCart) {
  const m = {};
  for (const [id, h] of Object.entries(holds)) {
    if (id === exceptCart) continue;
    for (const [n, q] of Object.entries(h.items || {})) m[n] = (m[n] || 0) + q;
  }
  return m;
}
function cleanItems(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [n, q] of Object.entries(raw).slice(0, 80)) {
    if (n.length < 200 && Number.isFinite(q) && q >= 1) out[n] = Math.min(Math.floor(q), 99);
  }
  return out;
}
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

export default async (req) => {
  const store = getStore("inventario");
  const url = new URL(req.url);
  const action = url.searchParams.get("action");
  const now = Date.now();

  if (req.method === "GET") {
    const stock = await store.get("stock", { type: "json" });
    const holds = await readHolds(store, now);
    const out = { init: stock !== null, stock: stock || {}, held: heldBy(holds, url.searchParams.get("cart") || "") };
    const k = Netlify.env.get("INV_KEY");
    if (k && req.headers.get("x-key") === k) out.log = (await store.get("log", { type: "json" })) || [];
    return json(out);
  }

  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);

  let body;
  try { body = await req.json(); } catch { return json({ error: "JSON inválido" }, 400); }

  /* ----- Público: los clientes apartan productos y envían pedidos ----- */
  if (action === "hold" || action === "order") {
    const cart = typeof body.cart === "string" ? body.cart : "";
    if (cart.length < 8 || cart.length > 64) return json({ error: "carrito inválido" }, 400);
    const items = cleanItems(body.items);
    const stock = (await store.get("stock", { type: "json" })) || {};
    const holds = await readHolds(store, now);
    const others = heldBy(holds, cart);
    const avail = (n) => Math.max(0, stock[n] - (others[n] || 0));

    if (action === "hold") {
      const granted = {};
      for (const [n, q] of Object.entries(items)) {
        if (!isNum(stock[n])) continue; // sin stock capturado = sin límite, no se aparta
        const g = Math.min(q, avail(n));
        if (g > 0) granted[n] = g;
      }
      if (Object.keys(granted).length) {
        if (Object.keys(holds).length >= MAX_HOLDS && !holds[cart]) return json({ error: "ocupado" }, 429);
        holds[cart] = { exp: now + HOLD_MS, items: granted };
      } else delete holds[cart];
      await store.setJSON("holds", holds);
      return json({ stock, held: others, granted });
    }

    // order: descuenta del stock real y libera el apartado
    const short = [];
    for (const [n, q] of Object.entries(items)) {
      if (isNum(stock[n]) && q > avail(n)) short.push({ name: n, avail: avail(n) });
    }
    if (short.length) return json({ short, stock, held: others }, 409);
    for (const [n, q] of Object.entries(items)) {
      if (isNum(stock[n])) stock[n] = Math.max(0, stock[n] - q);
    }
    delete holds[cart];
    await store.setJSON("stock", stock);
    await store.setJSON("holds", holds);
    return json({ ok: true, stock, held: others });
  }

  /* ----- Privado: el dueño/vendedor cambia el inventario (requiere clave) ----- */
  const key = Netlify.env.get("INV_KEY");
  if (!key) return json({ error: "Falta configurar INV_KEY en Netlify" }, 500);
  if (req.headers.get("x-key") !== key) return json({ error: "Clave incorrecta" }, 401);

  const cur = (await store.get("stock", { type: "json" })) || {};
  for (const [name, v] of Object.entries(body.set || {})) {
    if (isNum(v) && v >= 0 && name.length < 200) cur[name] = Math.floor(v);
  }
  for (const name of Array.isArray(body.del) ? body.del : []) delete cur[name];
  // Cambios por diferencia (ventas y compras): se suman al stock actual del servidor,
  // así dos dispositivos vendiendo a la vez no se pisan.
  for (const [name, d] of Object.entries(body.add || {})) {
    if (isNum(d) && name.length < 200) cur[name] = Math.max(0, (isNum(cur[name]) ? cur[name] : 0) + Math.trunc(d));
  }
  await store.setJSON("stock", cur);

  // Registro de ventas y gastos compartido entre dispositivos
  let log = (await store.get("log", { type: "json" })) || [];
  if (Array.isArray(body.logAdd) || Array.isArray(body.logDel)) {
    const del = new Set(Array.isArray(body.logDel) ? body.logDel : []);
    const have = new Set(log.map((r) => r.id));
    for (const r of Array.isArray(body.logAdd) ? body.logAdd.slice(0, 500) : []) {
      if (!r || typeof r.id !== "string" || r.id.length > 80 || have.has(r.id) || del.has(r.id)) continue;
      log.push({
        id: r.id, t: isNum(r.t) ? r.t : Date.now(), type: r.type === "compra" ? "compra" : "venta",
        name: String(r.name || "").slice(0, 200), qty: isNum(r.qty) ? r.qty : 0, unit: isNum(r.unit) ? r.unit : 0,
        total: isNum(r.total) ? r.total : 0, cost: isNum(r.cost) ? r.cost : null,
        by: typeof r.by === "string" ? r.by.slice(0, 30) : null, other: r.other ? true : undefined,
      });
      have.add(r.id);
    }
    log = log.filter((r) => !del.has(r.id)).slice(-5000);
    await store.setJSON("log", log);
  }
  return json({ init: true, stock: cur, log });
};
