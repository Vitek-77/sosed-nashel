// ============================================================
// 🛒 "СОСЕД НАШЁЛ!" — Москва и МО
// v8.1: + маркировка "Реклама" + erid из ссылки (ФЗ-38)
// ============================================================
import { Bot } from "@maxhub/max-bot-api";

const TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID ? Number(process.env.CHANNEL_ID) : null;
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_KEY || "";
const ADM_CLIENT = process.env.ADMITAD_CLIENT_ID || "";
const ADM_SECRET = process.env.ADMITAD_CLIENT_SECRET || "";
const ADM_BASIC = process.env.ADMITAD_BASIC || "";
const ADM_SCOPE = process.env.ADMITAD_SCOPE || "advcampaigns banners websites deeplink_generator coupons";
const ADM_CAMPAIGN = process.env.ADMITAD_CAMPAIGN_ID || "25179";
const ADM_WEBSITE = process.env.ADMITAD_WEBSITE_ID || "2990785";
const AE_CLIENT_ID = process.env.AE_CLIENT_ID || "";
const AE_CLIENT_SECRET = process.env.AE_CLIENT_SECRET || "";
const AE_USER_ID = process.env.AE_USER_ID || "";
const ADVERTISER = process.env.ADVERTISER_NAME || "ООО «Алиэкспресс (РУ)», ИНН 7703380158";

const bot = new Bot(TOKEN);

// ── ОБЛАЧНАЯ ПАМЯТЬ ──────────────────────────────────────
async function sb(path, opts = {}) {
    const res = await fetch(SUPABASE_URL + "/rest/v1/" + path, {
        method: opts.method || "GET",
        headers: { apikey: SUPABASE_KEY, Authorization: "Bearer " + SUPABASE_KEY, "Content-Type": "application/json", Prefer: opts.prefer || "return=representation" },
        body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    if (!res.ok) throw new Error("Supabase " + res.status);
    return res.json();
}
async function saveProduct(p) {
    try { await sb("products?on_conflict=source,external_id", { method: "POST", body: p, prefer: "return=representation,resolution=merge-duplicates" }); }
    catch (e) { console.log("⚠️ БД: " + e.message); }
}

// ── МАРКИРОВКА (ФЗ-38) ───────────────────────────────────
function eridOf(link) { const m = String(link).match(/erid=([A-Za-z0-9_]+)/i); return m ? m[1] : ""; }
function markFooter(ref) {
    const e = eridOf(ref);
    return "\n\nРеклама. " + ADVERTISER + (e ? ", erid: " + e : "");
}

// ── ADMITAD ──────────────────────────────────────────────
let admToken = null, admExp = 0;
async function admGetToken() {
    if (admToken && Date.now() < admExp) return admToken;
    const basic = ADM_BASIC || Buffer.from(ADM_CLIENT + ":" + ADM_SECRET).toString("base64");
    const res = await fetch("https://api.admitad.com/token/", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8", Authorization: "Basic " + basic },
        body: new URLSearchParams({ grant_type: "client_credentials", client_id: ADM_CLIENT, scope: ADM_SCOPE })
    });
    const txt = await res.text();
    console.log("🔑 Admitad token (" + res.status + "): " + txt.slice(0, 200));
    if (!res.ok) throw new Error("Admitad token HTTP " + res.status);
    const j = JSON.parse(txt);
    admToken = j.access_token; admExp = Date.now() + 30 * 60 * 1000;
    return admToken;
}
async function makeAdmitadLink(url) {
    const t = await admGetToken();
    const res = await fetch(`https://api.admitad.com/deeplink/${ADM_WEBSITE}/advcampaign/${ADM_CAMPAIGN}/?ulp=${encodeURIComponent(url)}`, {
        headers: { Authorization: "Bearer " + t }
    });
    const txt = await res.text();
    console.log("🔗 Deeplink ответ (" + res.status + "): " + txt.slice(0, 300));
    if (!res.ok) throw new Error("deeplink HTTP " + res.status);
    const arr = JSON.parse(txt);
    const first = Array.isArray(arr) ? arr[0] : null;
    if (!first || !first.link) throw new Error("deeplink пустой");
    return { link: first.link, affiliate: !!first.is_affiliate_product };
}
async function getAliCoupons() {
    const t = await admGetToken();
    const res = await fetch("https://api.admitad.com/coupons/?limit=100&status=active", { headers: { Authorization: "Bearer " + t } });
    if (!res.ok) throw new Error("coupons HTTP " + res.status);
    const j = await res.json();
    const all = j.coupons || [];
    if (all[0]) console.log("🧾 Пример купона: " + JSON.stringify(all[0]).slice(0, 300));
    return all.filter(c => /aliexpress/i.test(String(c.advcampaign_name || "")));
}

// ── AE PLATFORM (подборки) ───────────────────────────────
let aeToken = null, aeExp = 0;
function aeReady() { return !!(AE_CLIENT_ID && AE_CLIENT_SECRET && AE_USER_ID); }
async function aeGetToken() {
    if (aeToken && Date.now() < aeExp) return aeToken;
    const res = await fetch("https://oauth2.aeplatform.ru/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "client_credentials", client_id: AE_CLIENT_ID, client_secret: AE_CLIENT_SECRET })
    });
    if (!res.ok) throw new Error("AE token HTTP " + res.status);
    const j = await res.json();
    aeToken = j.access_token; aeExp = Date.now() + 25 * 60 * 1000;
    return aeToken;
}
async function aeGet(path) {
    const t = await aeGetToken();
    const res = await fetch("https://api2.aeplatform.ru" + path, { headers: { Authorization: "Bearer " + t } });
    if (!res.ok) throw new Error("AE " + res.status + " " + path);
    return res.json();
}
async function aeTopProducts() {
    const feeds = await aeGet("/api/v1/productsfeeds/feeds?limit=5");
    const feedId = feeds?.data?.[0]?.id;
    if (!feedId) throw new Error("нет фида");
    const j = await aeGet(`/api/v1/productsfeeds/products?productFeedId=${feedId}&limit=30&localityType=all&sort=byCommissionRate&page=1`);
    const items = (j.data || []).map(x => x.attributes || {});
    items.sort((a, b) => Number(b.purchasesAmount || 0) - Number(a.purchasesAmount || 0));
    return items.slice(0, 3);
}
function feedPrice(a) {
    const c = Number(a?.price?.cents || 0);
    return c > 1000 ? Math.round(c / 100) : c;
}
function productBlock(i, a) {
    const L = [`${i}️⃣ ${a.title || "Товар с AliExpress"}`];
    const extra = [];
    if (a.rating) extra.push("⭐ " + String(a.rating).replace(".", ","));
    if (a.purchasesAmount) extra.push("🛒 купили: " + fmt(a.purchasesAmount));
    if (extra.length) L.push(extra.join(" | "));
    if (feedPrice(a)) L.push(`💰 ${fmt(feedPrice(a))} ₽`);
    L.push("👉 " + (a.pageURL || ""));
    return L.join("\n");
}

// ── СЛУЖЕБНЫЕ ────────────────────────────────────────────
function getText(ctx) {
    if (ctx.text && typeof ctx.text === "string") return ctx.text;
    if (ctx.message?.text && typeof ctx.message.text === "string") return ctx.message.text;
    if (ctx.message?.body?.text && typeof ctx.message.body.text === "string") return ctx.message.body.text;
    if (ctx.body?.text && typeof ctx.body.text === "string") return ctx.body.text;
    return "";
}
function fmt(n) { return String(Math.round(Number(n))).replace(/\B(?=(\d{3})+(?!\d))/g, " "); }
function chatInfo(ctx) {
    const c = ctx.chat || ctx.message?.chat || ctx.message?.recipient || {};
    return { id: c.chat_id ?? c.id ?? null, type: c.chat_type ?? c.type ?? "?" };
}
async function postToChannel(text) {
    if (!CHANNEL_ID) { console.log("⚠️ CHANNEL_ID не задан"); return false; }
    try { await bot.api.sendMessageToChat(CHANNEL_ID, text); console.log("📢 Пост опубликован!"); return true; }
    catch (e) { console.log("⚠️ Пост не вышел: " + (e?.message ?? e)); return false; }
}
function couponCard(c, ref) {
    return ["🎟 ПРОМОКОД: " + (c.code || c.coupon_code || "—"), "💥 " + (c.discount || ""), "📝 " + (c.description || ""), "⏰ до " + (c.expiration_date ? String(c.expiration_date).slice(0, 10) : "—"), "", "👉 Активировать:", ref].join("\n");
}

async function runCoupon(uid) {
    try {
        const coupons = await getAliCoupons();
        if (!coupons.length) { await bot.api.sendMessageToUser(uid, "😕 У AliExpress сейчас нет активных купонов в Admitad."); return; }
        const c = coupons[0];
        const r = await makeAdmitadLink(c.url || "https://aliexpress.ru/");
        const ok = await postToChannel(couponCard(c, r.link) + markFooter(r.link));
        await bot.api.sendMessageToUser(uid, ok ? `✅ Купон в канале! (всего нашёл: ${coupons.length})` : "❌ Не выложил.");
    } catch (e) { await bot.api.sendMessageToUser(uid, "⚠️ Admitad: " + e.message); }
}

async function runSelection(uid) {
    if (!aeReady()) {
        await bot.api.sendMessageToUser(uid, "🛒 Поиск ТОВАРОВ включится, когда добавим ключи AE Platform. А пока — купон 👇");
        await runCoupon(uid);
        return;
    }
    try {
        await bot.api.sendMessageToUser(uid, "⏳ Ищу товары с комиссией и продажами…");
        const items = await aeTopProducts();
        if (!items.length) { await bot.api.sendMessageToUser(uid, "😕 Фид пустой."); return; }
        const post = ["👀 Сосед нашёл! Топ-3 находки 🔥", ""].concat(items.map((a, i) => productBlock(i + 1, a))).join("\n\n") + markFooter("");
        const ok = await postToChannel(post);
        for (const a of items) {
            await saveProduct({ source: "aliexpress", external_id: String(a.itemId), title: a.title || "", price_new: feedPrice(a) || null, image_url: a.imageURL || null, original_url: a.pageURL || "", ref_url: a.pageURL || "", category: "auto", status: "posted", posted_at: new Date().toISOString() });
        }
        await bot.api.sendMessageToUser(uid, ok ? "✅ Подборка в канале!" : "❌ Не выложил.");
    } catch (e) { await bot.api.sendMessageToUser(uid, "⚠️ AE: " + e.message); }
}

bot.hears(/.*/, async (ctx) => {
    const info = chatInfo(ctx);
    const uid = ctx.message?.sender?.user_id ?? ctx.from?.user_id ?? null;
    const text = getText(ctx);
    console.log(`💬 Чат: ${info.id} (${info.type}) | Юзер: ${uid} | Текст: ${text}`);
    if (!uid || String(info.type).includes("channel")) return;
    const low = text.trim().toLowerCase();

    if (low === "купон" || low === "промокод") { await runCoupon(uid); return; }
    if (low === "подборка" || low === "найди" || low === "поиск") { await runSelection(uid); return; }

    const link = text.match(/https?:\/\/[^\s|]+/);
    if (link && /aliexpress\.(ru|com)/i.test(link[0])) {
        await bot.api.sendMessageToUser(uid, "⏳ Проверяю комиссию и делаю реф-ссылку…");
        try {
            const r = await makeAdmitadLink(link[0]);
            if (!r.affiliate) {
                await bot.api.sendMessageToUser(uid, "❌ За этот товар комиссия НЕ платится — в канал не постим. Выбери другой.");
                return;
            }
            const parts = text.split("|").map(s => s.trim());
            let ok;
            if (parts[1]) {
                ok = await postToChannel(["👀 Сосед нашёл!", "", "🏷️ " + parts[1], parts[2] ? "💰 " + (parts[3] ? `Было ${fmt(parts[3])} ₽ → стало ` : "") + fmt(parts[2]) + " ₽" : "", "", "👉 Забрать со скидкой:", r.link].join("\n") + markFooter(r.link));
            } else {
                ok = await postToChannel(["👀 Сосед нашёл!", "", "🔥 Годная находка — цена по ссылке 👇", "", "👉 Забрать со скидкой:", r.link].join("\n") + markFooter(r.link));
            }
            await saveProduct({ source: "aliexpress", external_id: (link[0].match(/item\/(\d+)/) || [])[1] || link[0], title: parts[1] || link[0], price_new: Number((parts[2] || "").replace(/\D/g, "")) || null, original_url: link[0], ref_url: r.link, category: "manual", status: "posted", posted_at: new Date().toISOString() });
            await bot.api.sendMessageToUser(uid, (ok ? "✅ Пост в канале! Комиссия капает 💰\n" : "❌ В канал не выложил.\n") + "🔗 Твоя реф-ссылка:\n" + r.link);
        } catch (e) { await bot.api.sendMessageToUser(uid, "⚠️ Admitad: " + e.message); }
        return;
    }

    if (low === "тест") {
        const ok = await postToChannel(["👀 Сосед нашёл!", "", "🏷️ Набор из 10 бесшовных заколок для волос", "💰 Было 309 ₽ → стало 99 ₽ (−68%)", "", "👉 Забрать со скидкой:", "https://aliexpress.ru/one-price"].join("\n") + markFooter(""));
        await bot.api.sendMessageToUser(uid, ok ? "✅ Тест в канале!" : "❌ Не вышло.");
    }
});

const http = await import("node:http");
const port = process.env.PORT || 3000;
http.createServer((req, res) => { res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }); res.end("Сосед нашёл! работает ✅"); }).listen(port, () => console.log("🌐 Веб-сервер на порту " + port));
process.on("unhandledRejection", (err) => {
    const msg = String(err?.message ?? err) + " " + String(err?.cause?.message ?? "");
    console.error("⚠️ Ошибка: " + msg);
    if (/ETIMEDOUT|ECONNRESET|ECONNREFUSED|EPIPE|fetch failed|socket|not valid JSON|Unexpected token/i.test(msg)) { console.log("🔄 Перезапускаюсь…"); process.exit(1); }
});

console.log("🚀 «Сосед нашёл!» v8.1 (маркировка ФЗ-38) запущен");
bot.start();
