// ============================================================
// 🛒 "СОСЕД НАШЁЛ!" — Москва и МО
// v7 "АВТОПИЛОТ": расписание подборок и купонов
// ============================================================
import { Bot } from "@maxhub/max-bot-api";

const TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID ? Number(process.env.CHANNEL_ID) : null;
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_KEY || "";
const ADM_CLIENT = process.env.ADMITAD_CLIENT_ID || "";
const ADM_SECRET = process.env.ADMITAD_CLIENT_SECRET || "";
const AE_CLIENT_ID = process.env.AE_CLIENT_ID || "";
const AE_CLIENT_SECRET = process.env.AE_CLIENT_SECRET || "";
const AE_USER_ID = process.env.AE_USER_ID || "";

// ⏰ РАСПИСАНИЕ (московское время) — меняй под себя:
const PRODUCT_TIMES = ["11:00", "14:00", "19:00"]; // подборки товаров
const COUPON_TIMES = ["10:00", "15:00", "20:00"];  // купоны

const bot = new Bot(TOKEN);

// ── SUPABASE ─────────────────────────────────────────────
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

// ── ADMITAD ──────────────────────────────────────────────
let admToken = null, admExp = 0, aliCampaignId = null;
async function admGetToken() {
    if (admToken && Date.now() < admExp) return admToken;
    const res = await fetch("https://api.admitad.com/token/", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "client_credentials", client_id: ADM_CLIENT, client_secret: ADM_SECRET })
    });
    if (!res.ok) throw new Error("Admitad token HTTP " + res.status);
    const j = await res.json();
    admToken = j.access_token; admExp = Date.now() + 30 * 60 * 1000;
    return admToken;
}
async function admGet(path) {
    const t = await admGetToken();
    const res = await fetch("https://api.admitad.com" + path, { headers: { Authorization: "Bearer " + t } });
    if (!res.ok) throw new Error("Admitad " + res.status + " " + path);
    return res.json();
}
async function findAliCampaign() {
    if (aliCampaignId) return aliCampaignId;
    const j = await admGet("/advcampaigns/?name=AliExpress&limit=10");
    const list = j.advcampaigns || [];
    const ru = list.find(c => /RU|CIS/i.test(c.name)) || list[0];
    aliCampaignId = ru ? ru.id : null;
    return aliCampaignId;
}
async function makeAdmitadLink(url) {
    try {
        const cid = await findAliCampaign();
        const t = await admGetToken();
        const res = await fetch("https://api.admitad.com/deeplink/", {
            method: "POST",
            headers: { Authorization: "Bearer " + t, "Content-Type": "application/json" },
            body: JSON.stringify({ url, advacampaign_id: cid })
        });
        if (!res.ok) throw new Error("deeplink " + res.status);
        return (await res.json()).url || url;
    } catch (e) { console.log("⚠️ Deeplink: " + e.message); return url; }
}
async function getAliCoupons() {
    const j = await admGet("/coupons/?limit=100&status=active");
    return (j.coupons || []).filter(c => /aliexpress/i.test(String(c.advcampaign_name || "")));
}

// ── AE PLATFORM ──────────────────────────────────────────
let aeToken = null, aeExp = 0, aePlacement = null, aeAdvertiser = null;
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
async function aePost(path, body) {
    const t = await aeGetToken();
    const res = await fetch("https://api2.aeplatform.ru" + path, {
        method: "POST",
        headers: { Authorization: "Bearer " + t, "Content-Type": "application/json" },
        body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error("AE " + res.status + " " + path);
    return res.json();
}
async function aeGetPlacement() {
    if (aePlacement) return aePlacement;
    const j = await aeGet(`/api/v1/users/${AE_USER_ID}/placements/active`);
    aePlacement = (j.placements && j.placements[0]) ? j.placements[0].id : null;
    return aePlacement;
}
async function aeGetAdvertiser(link) {
    if (aeAdvertiser) return aeAdvertiser;
    try {
        const j = await aePost("/api/v1/link/advertiser", { link });
        const c = j?.data?.contracts?.initialContractInfo?.client || j?.data?.contracts?.aliInfo || {};
        aeAdvertiser = { name: c.fullName || "ООО «Алиэкспресс»", itn: c.itn || "" };
    } catch (e) { aeAdvertiser = { name: "ООО «Алиэкспресс»", itn: "" }; }
    return aeAdvertiser;
}
async function aeCreateCreative(link, title) {
    const pid = await aeGetPlacement();
    const j = await aePost(`/api/v1/users/${AE_USER_ID}/creative`, {
        link, title, placementId: pid,
        ordInfo: { description: title },
        creationConditions: { createLinks: true, createArticles: false }
    });
    return { url: j.targetLink || link, erid: j.eridToken || "" };
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

// ── КАРТОЧКИ ─────────────────────────────────────────────
function fmt(n) { return String(Math.round(Number(n))).replace(/\B(?=(\d{3})+(?!\d))/g, " "); }
function feedPrice(a) {
    const c = Number(a?.price?.cents || 0);
    return c > 1000 ? Math.round(c / 100) : c;
}
function productBlock(i, a, ref) {
    const L = [`${i}️⃣ ${a.title || "Товар с AliExpress"}`];
    const extra = [];
    if (a.rating) extra.push("⭐ " + String(a.rating).replace(".", ","));
    if (a.purchasesAmount) extra.push("🛒 купили: " + fmt(a.purchasesAmount));
    if (extra.length) L.push(extra.join(" | "));
    if (feedPrice(a)) L.push(`💰 ${fmt(feedPrice(a))} ₽`);
    L.push("👉 " + ref);
    return L.join("\n");
}
function couponCard(c, ref) {
    return ["🎟 ПРОМОКОД: " + (c.code || c.coupon_code || "—"), "💥 " + (c.discount || ""), "📝 " + (c.description || ""), "⏰ до " + (c.expiration_date ? String(c.expiration_date).slice(0, 10) : "—"), "", "👉 Активировать:", ref].join("\n");
}

async function postToChannel(text) {
    if (!CHANNEL_ID) { console.log("⚠️ CHANNEL_ID не задан"); return false; }
    try { await bot.api.sendMessageToChat(CHANNEL_ID, text); console.log("📢 Пост опубликован!"); return true; }
    catch (e) { console.log("⚠️ Пост не вышел: " + (e?.message ?? e)); return false; }
}

// ── АВТО-ПОСТ ПОДБОРКИ ───────────────────────────────────
async function runProductPost() {
    console.log("🕐 Авто-подборка: старт");
    if (!aeReady()) { console.log("⏳ AE ключи ещё не заданы — подборка пропущена"); return; }
    try {
        const items = await aeTopProducts();
        const blocks = [];
        for (const a of items) {
            const pageUrl = a.pageURL || `https://aliexpress.ru/item/${a.itemId}.html`;
            let ref = pageUrl, erid = "";
            try {
                const cr = await aeCreateCreative(pageUrl, a.title || "Товар");
                ref = cr.url; erid = cr.erid;
            } catch (e) { console.log("⚠️ Креатив: " + e.message); }
            blocks.push(productBlock(blocks.length + 1, a, ref));
            if (erid) blocks.push("");
            await saveProduct({ source: "aliexpress", external_id: String(a.itemId), title: a.title || "", price_new: feedPrice(a) || null, discount_percent: null, image_url: a.imageURL || null, original_url: pageUrl, ref_url: ref, category: "auto", status: "posted", posted_at: new Date().toISOString() });
        }
        let post = ["👀 Сосед нашёл! Топ-3 находки дня 🔥", ""].concat(blocks.join("\n\n")).join("\n");
        if (blocks.length) {
            try {
                const adv = await aeGetAdvertiser(items[0].pageURL || "https://aliexpress.ru");
                const lastErid = ""; // erid добавится к ссылке креатива автоматически
                post += "\n\nРеклама. " + adv.name + (adv.itn ? ", ИНН " + adv.itn : "") + (lastErid ? ", erid: " + lastErid : "");
            } catch (e) {}
        }
        const ok = await postToChannel(post);
        console.log(ok ? "✅ Подборка вышла" : "❌ Подборка не вышла");
    } catch (e) { console.log("⚠️ Авто-подборка: " + e.message); }
}

// ── АВТО-ПОСТ КУПОНА ─────────────────────────────────────
let lastCouponId = null;
async function runCouponPost() {
    console.log("🕐 Авто-купон: старт");
    try {
        const coupons = await getAliCoupons();
        const fresh = coupons.find(c => c.id !== lastCouponId) || coupons[0];
        if (!fresh) { console.log("😕 Купонов нет"); return; }
        lastCouponId = fresh.id;
        const ref = await makeAdmitadLink(fresh.url || "https://aliexpress.ru/");
        const ok = await postToChannel(couponCard(fresh, ref));
        console.log(ok ? "✅ Купон вышел" : "❌ Купон не вышел");
    } catch (e) { console.log("⚠️ Авто-купон: " + e.message); }
}

// ── ПЛАНИРОВЩИК (московское время) ───────────────────────
const done = new Set();
setInterval(() => {
    const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Moscow" }));
    const hm = String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0");
    const day = now.getFullYear() + "-" + (now.getMonth() + 1) + "-" + now.getDate();
    if (PRODUCT_TIMES.includes(hm) && !done.has(day + "P" + hm)) { done.add(day + "P" + hm); runProductPost(); }
    if (COUPON_TIMES.includes(hm) && !done.has(day + "C" + hm)) { done.add(day + "C" + hm); runCouponPost(); }
}, 30000);

// ── РУЧНЫЕ КОМАНДЫ (для настройки) ───────────────────────
function getText(ctx) {
    if (ctx.text && typeof ctx.text === "string") return ctx.text;
    if (ctx.message?.text && typeof ctx.message.text === "string") return ctx.message.text;
    if (ctx.message?.body?.text && typeof ctx.message.body.text === "string") return ctx.message.body.text;
    if (ctx.body?.text && typeof ctx.body.text === "string") return ctx.body.text;
    return "";
}
function chatInfo(ctx) {
    const c = ctx.chat || ctx.message?.chat || ctx.message?.recipient || {};
    return { id: c.chat_id ?? c.id ?? null, type: c.chat_type ?? c.type ?? "?" };
}
bot.hears(/.*/, async (ctx) => {
    const info = chatInfo(ctx);
    const uid = ctx.message?.sender?.user_id ?? ctx.from?.user_id ?? null;
    const text = getText(ctx);
    console.log(`💬 Чат: ${info.id} (${info.type}) | Юзер: ${uid} | Текст: ${text}`);
    if (!uid || String(info.type).includes("channel")) return;
    const low = text.trim().toLowerCase();

    if (low === "купон") { await runCouponPost(); await bot.api.sendMessageToUser(uid, "✅ Купон отправлен в канал (смотри логи, если что)."); return; }
    if (low === "подборка") { await runProductPost(); await bot.api.sendMessageToUser(uid, aeReady() ? "✅ Подборка отправлена в канал." : "⏳ Подборка включится, когда добавишь AE-ключи в Render."); return; }

    const link = text.match(/https?:\/\/[^\s|]+/);
    if (link && /aliexpress\.(ru|com)/i.test(link[0])) {
        const parts = text.split("|").map(s => s.trim());
        const ref = await makeAdmitadLink(link[0]);
        if (parts[1]) {
            const ok = await postToChannel(["👀 Сосед нашёл!", "", "🏷️ " + parts[1], parts[2] ? "💰 " + (parts[3] ? `Было ${fmt(parts[3])} ₽ → стало ` : "") + fmt(parts[2]) + " ₽" : "", "", "👉 Забрать со скидкой:", ref].join("\n"));
            await bot.api.sendMessageToUser(uid, ok ? "✅ Карточка в канале!" : "❌ Не выложил.");
        } else {
            const ok = await postToChannel(["👀 Сосед нашёл!", "", "🔥 Годная находка — цена по ссылке 👇", "", "👉 Забрать со скидкой:", ref].join("\n"));
            await bot.api.sendMessageToUser(uid, (ok ? "✅ Тизер в канале.\n" : "") + "💡 Полная карточка: ссылка | название | цена | старая цена");
        }
        return;
    }

    if (low === "тест") {
        const ok = await postToChannel(["👀 Сосед нашёл!", "", "🏷️ Набор из 10 бесшовных заколок для волос", "💰 Было 309 ₽ → стало 99 ₽ (−68%)", "", "👉 Забрать со скидкой:", "https://aliexpress.ru/one-price"].join("\n"));
        await bot.api.sendMessageToUser(uid, ok ? "✅ Тест в канале!" : "❌ Не вышло.");
    }
});

// ── ВЕБ-СЕРВЕР + АВТОПЕРЕЗАПУСК ──────────────────────────
const http = await import("node:http");
const port = process.env.PORT || 3000;
http.createServer((req, res) => { res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }); res.end("Сосед нашёл! работает ✅"); }).listen(port, () => console.log("🌐 Веб-сервер на порту " + port));
process.on("unhandledRejection", (err) => {
    const msg = String(err?.message ?? err) + " " + String(err?.cause?.message ?? "");
    console.error("⚠️ Ошибка: " + msg);
    if (/ETIMEDOUT|ECONNRESET|ECONNREFUSED|EPIPE|fetch failed|socket|not valid JSON|Unexpected token/i.test(msg)) { console.log("🔄 Перезапускаюсь…"); process.exit(1); }
});

console.log("🚀 «Сосед нашёл!» v7 АВТОПИЛОТ запущен. Подборки: " + PRODUCT_TIMES.join(", ") + " | Купоны: " + COUPON_TIMES.join(", "));
bot.start();
