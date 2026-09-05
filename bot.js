// ============================================================
// 🛒 "СОСЕД НАШЁЛ!" — Москва и МО
// v16: карточка ВСЕГДА с ценой было/стало и скидкой
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
const ADVERTISER = process.env.ADVERTISER_NAME || "ООО «Алиэкспресс (РУ)», ИНН 7703380158";
const USD_RATE = Number(process.env.USD_RATE || 95);

const bot = new Bot(TOKEN);

// ── ПАМЯТЬ ───────────────────────────────────────────────
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
function fmt(n) { return String(Math.round(Number(n))).replace(/\B(?=(\d{3})+(?!\d))/g, " "); }
function eridOf(link) { const m = String(link).match(/erid=([A-Za-z0-9_]+)/i); return m ? m[1] : ""; }
function markLine(ref) { const e = eridOf(ref); return "Реклама. " + ADVERTISER + (e ? ", erid: " + e : ""); }
const hasRu = (s) => /[а-яА-ЯЁё]{3,}/.test(s || "");

// ── ПЕРЕВОД (5 сервисов по цепочке) ─────────────────────
async function translateName(s) {
    if (!/[A-Za-z]{3,}/.test(s) || hasRu(s)) return s;
    const q = s.slice(0, 400);
    try {
        const r = await fetch("https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=ru&dt=t&q=" + encodeURIComponent(q));
        if (r.ok) { const j = await r.json(); const t = Array.isArray(j) && Array.isArray(j[0]) ? j[0].map(x => (x && x[0]) || "").join("") : ""; if (hasRu(t)) { console.log("🏷️ Перевод: Google"); return t; } }
    } catch (e) {}
    try {
        const r = await fetch("https://api.mymemory.translated.net/get?q=" + encodeURIComponent(q) + "&langpair=en|ru");
        if (r.ok) { const j = await r.json(); const t = j?.responseData?.translatedText; if (hasRu(t) && !/WARNING/i.test(t)) { console.log("🏷️ Перевод: MyMemory"); return t; } }
    } catch (e) {}
    for (const host of ["https://lingva.ml/api/v1/en/ru/", "https://lt.vern.cc/api/v1/en/ru/"]) {
        try {
            const r = await fetch(host + encodeURIComponent(q));
            if (r.ok) { const j = await r.json(); const t = j?.translation; if (hasRu(t)) { console.log("🏷️ Перевод: Lingva"); return t; } }
        } catch (e) {}
    }
    try {
        const r = await fetch("https://libretranslate.de/translate", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ q, source: "en", target: "ru" }) });
        if (r.ok) { const j = await r.json(); const t = j?.translatedText; if (hasRu(t)) { console.log("🏷️ Перевод: LibreTranslate"); return t; } }
    } catch (e) {}
    console.log("🏷️ Перевод не удался — оставляю английский");
    return s;
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
    console.log("🔑 Admitad token (" + res.status + "): " + txt.slice(0, 120));
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
    console.log("🔗 Deeplink (" + res.status + "): " + txt.slice(0, 200));
    if (!res.ok) throw new Error("deeplink HTTP " + res.status);
    const arr = JSON.parse(txt);
    const first = Array.isArray(arr) ? arr[0] : null;
    if (!first || !first.link) throw new Error("deeplink пустой");
    return { link: first.link, affiliate: first.is_affiliate_product };
}
async function getAliCoupons() {
    const t = await admGetToken();
    const res = await fetch(`https://api.admitad.com/coupons/?limit=50&advcampaign_id=${ADM_CAMPAIGN}`, { headers: { Authorization: "Bearer " + t } });
    if (!res.ok) throw new Error("coupons HTTP " + res.status);
    const j = await res.json();
    return j.coupons || [];
}

// ── ФИД: только товары с нормальной ценой ───────────────
function parseOffer(b) {
    const g = (re) => { const m = b.match(re); return m ? m[1] : ""; };
    const id = g(/<offer[^>]*\bid="(\d{6,})"/) || ((b.match(/item(?:%252F|%2F|\/)(\d{6,})/) || [])[1] || "");
    const price = parseFloat(g(/<price>([\d.]+)</)) || 0;
    const old = parseFloat(g(/<oldprice>([\d.]+)</) || g(/<old_price>([\d.]+)</)) || 0;
    let discount = parseInt(g(/<[^>]+>\s*(\d{1,3})\s*%\s*<\/[^>]+>/)) || 0;
    if (!discount && old > price && old > 0) discount = Math.round((1 - price / old) * 100);
    const img = g(/<(?:img|picture)[^>]*>(https?:[^<]+)<\/(?:img|picture)>/);
    return { id, price, old, discount, img, name: (g(/<name>([\s\S]*?)<\/name>/) || g(/<title>([\s\S]*?)<\/title>/)).replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&#39;/g, "'") };
}
function passes(o) {
    if (!o.id || !o.img) return false;
    if (!(o.price > 0) || !(o.old > o.price)) return false;   // цена ОБЯЗАТЕЛЬНА
    if (o.discount < 40) return false;
    if (/difference|supplement|postage|freight|after sales|shipping|surcharge|custom|do not|not sell|special link|payment|deposit|test|sample|fee|repair|link only|spare parts/i.test(o.name)) return false;
    if (o.name.length < 15) return false;
    return true;
}
const POOL = [];
const LAST = new Set();
async function fillPool(want = 80) {
    const FEED = process.env.ADMITAD_FEED_URL || "";
    if (!FEED) throw new Error("нет ADMITAD_FEED_URL");
    const res = await fetch(FEED, { headers: { "User-Agent": "Mozilla/5.0", "Accept-Encoding": "identity" } });
    if (!res.ok) throw new Error("feed HTTP " + res.status);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "", bytes = 0, seen = 0;
    try {
        while (true) {
            const r = await reader.read();
            if (r.done) break;
            bytes += r.value.length;
            buf += dec.decode(r.value, { stream: true });
            let m;
            while ((m = buf.match(/<offer[\s\S]*?<\/offer>/))) {
                const block = m[0];
                buf = buf.slice(buf.indexOf(block) + block.length);
                seen++;
                const o = parseOffer(block);
                if (passes(o)) POOL.push(o);
                if (POOL.length >= want || bytes > 40 * 1048576) { reader.cancel(); break; }
            }
            if (buf.length > 300000) buf = buf.slice(-150000);
            if (POOL.length >= want) break;
        }
    } catch (e) { if (!POOL.length) throw e; }
    console.log(`📦 Пул: ${POOL.length} (просмотрено ${seen}, ${(bytes / 1048576).toFixed(1)} МБ)`);
}

// ── ПОСТЫ ────────────────────────────────────────────────
async function uploadPhoto(imgUrl) {
    const res = await fetch(imgUrl);
    if (!res.ok) throw new Error("фото HTTP " + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    const fs = await import("node:fs");
    const path = "/tmp/photo_" + Date.now() + ".jpg";
    fs.writeFileSync(path, buf);
    const image = await bot.api.uploadImage({ source: path });
    return image.toJson();
}
async function publish(bodyText, ref, imgUrl) {
    let attach = null;
    if (imgUrl) { try { attach = await uploadPhoto(imgUrl); } catch (e) { console.log("⚠️ Фото: " + e.message); } }
    const full = bodyText + "\n\n👉 Забрать со скидкой:\n" + ref + "\n\n" + markLine(ref);
    const opts = attach ? { attachments: [attach] } : undefined;
    await bot.api.sendMessageToChat(CHANNEL_ID, full, opts);
    console.log("📢 Пост опубликован");
    return true;
}

// ── СЛУЖЕБНЫЕ ────────────────────────────────────────────
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

    // ── ПОСТ = случайный товар с ценой и скидкой ──
    if (low === "пост" || low === "подборка" || low === "post") {
        await bot.api.sendMessageToUser(uid, "⏳ Ищу товар с жирной скидкой и нормальной ценой…");
        try {
            if (!POOL.length) await fillPool(80);
            if (!POOL.length) { await bot.api.sendMessageToUser(uid, "😕 В фиде не нашлось товаров с ценой — попробуй ещё раз."); return; }
            let o = null;
            for (let i = 0; i < 15; i++) {
                const cand = POOL[Math.floor(Math.random() * POOL.length)];
                if (!LAST.has(cand.id)) { o = cand; break; }
            }
            if (!o) o = POOL[Math.floor(Math.random() * POOL.length)];
            LAST.add(o.id);
            const r = await makeAdmitadLink(`https://aliexpress.ru/item/${o.id}.html`);
            if (r.affiliate === false) { await bot.api.sendMessageToUser(uid, "⛔ Выпал неаффилиатный — кинь «пост» ещё раз."); return; }
            const name = String(await translateName(o.name)).slice(0, 90);
            const p = Math.round(o.price * USD_RATE), op = Math.round(o.old * USD_RATE);
            const body = ["📌 Сосед нашёл!", "", "🏷️ " + name, `💰 Было ${fmt(op)} ₽ → стало около ${fmt(p)} ₽`, `💥 Скидка −${o.discount}%`].join("\n");
            await publish(body, r.link, o.img);
            await saveProduct({ source: "aliexpress", external_id: o.id, title: name, price_new: p, price_old: op, discount_percent: o.discount, image_url: o.img, original_url: `https://aliexpress.ru/item/${o.id}.html`, ref_url: r.link, category: "auto", status: "posted", posted_at: new Date().toISOString() });
            await bot.api.sendMessageToUser(uid, "✅ Карточка в канале! (пул: " + POOL.length + ")");
        } catch (e) { await bot.api.sendMessageToUser(uid, "⚠️ " + e.message); }
        return;
    }

    // ── КУПОН ──
    if (low === "купон" || low === "промокод") {
        try {
            const coupons = await getAliCoupons();
            if (!coupons.length) { await bot.api.sendMessageToUser(uid, "😕 Купонов пока нет."); return; }
            const c = coupons[0];
            const r = await makeAdmitadLink(c.url || "https://aliexpress.ru/");
            const code = c.code || c.coupon_code || "";
            const body = ["📌 КУПОН / СКИДКА", "", "🏷️ " + String(await translateName(c.name || c.description || "Скидка в магазине AliExpress")).slice(0, 90), c.discount ? "💥 " + c.discount : "", code ? "🔑 Код: " + code : "✅ Промокод не нужен — скидка по ссылке", c.expiration_date ? "⏰ до " + String(c.expiration_date).slice(0, 10) : ""].filter(Boolean).join("\n");
            await publish(body, r.link, null);
            await bot.api.sendMessageToUser(uid, "✅ Купон в канале!");
        } catch (e) { await bot.api.sendMessageToUser(uid, "⚠️ " + e.message); }
        return;
    }

    // ── ССЫЛКА вручную (с данными) ──
    const link = text.match(/https?:\/\/[^\s|]+/);
    if (link && /aliexpress\.(ru|com)/i.test(link[0])) {
        const parts = text.split("|").map(s => s.trim());
        if (!parts[1]) { await bot.api.sendMessageToUser(uid, "✍️ Пришли: ссылка | название | цена | старая цена"); return; }
        await bot.api.sendMessageToUser(uid, "⏳ Проверяю комиссию…");
        try {
            const r = await makeAdmitadLink(link[0]);
            if (r.affiliate === false) { await bot.api.sendMessageToUser(uid, "❌ Комиссия НЕ платится — не постим."); return; }
            const body = ["📌 Сосед нашёл!", "", "🏷️ " + parts[1], parts[2] ? "💰 " + (parts[3] ? `Было ${fmt(parts[3])} ₽ → стало ` : "") + fmt(parts[2]) + " ₽" : "", parts[2] && parts[3] ? "💥 Скидка −" + Math.round((1 - Number(parts[2]) / Number(parts[3])) * 100) + "%" : ""].filter(Boolean).join("\n");
            await publish(body, r.link, null);
            await saveProduct({ source: "aliexpress", external_id: (link[0].match(/item\/(\d+)/) || [])[1] || link[0], title: parts[1], price_new: Number((parts[2] || "").replace(/\D/g, "")) || null, original_url: link[0], ref_url: r.link, category: "manual", status: "posted", posted_at: new Date().toISOString() });
            await bot.api.sendMessageToUser(uid, "✅ Пост в канале! Комиссия капает 💰");
        } catch (e) { await bot.api.sendMessageToUser(uid, "⚠️ " + e.message); }
        return;
    }

    if (low === "тест") {
        await publish(["📌 Сосед нашёл!", "", "🏷️ Набор из 10 бесшовных заколок для волос", "💰 Было 309 ₽ → стало 99 ₽", "💥 Скидка −68%"].join("\n"), "https://aliexpress.ru/one-price", null);
        await bot.api.sendMessageToUser(uid, "✅ Тест в канале!");
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

console.log("🚀 «Сосед нашёл!» v16 (цена+скидка всегда) запущен");
bot.start();
