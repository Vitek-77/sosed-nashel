// ============================================================
// 🛒 "СОСЕД НАШЁЛ!" — Москва и МО
// v10: команда "пост" = случайный товар из фида для настройки вида
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
const ADM_FEED = process.env.ADMITAD_FEED_URL || "";
const ADVERTISER = process.env.ADVERTISER_NAME || "ООО «Алиэкспресс (РУ)», ИНН 7703380158";
const USD_RATE = Number(process.env.USD_RATE || 95);
// 🔧 ПАРАМЕТРЫ ПОИСКА В ФИДЕ (меняются без кода)
const F_MIN_PRICE = Number(process.env.FEED_MIN_PRICE || 3);      // мин. цена, $
const F_MIN_DISC = Number(process.env.FEED_MIN_DISCOUNT || 30);   // мин. скидка, %
const F_MIN_COMM = Number(process.env.FEED_MIN_COMMISSION || 3);  // мин. комиссия, %

const bot = new Bot(TOKEN);
const POOL = [];          // пул товаров в памяти
const LAST = new Set();   // уже постигнутые

// ── ПАМЯТЬ/МАРКИРОВКА ────────────────────────────────────
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
function eridOf(link) { const m = String(link).match(/erid=([A-Za-z0-9_]+)/i); return m ? m[1] : ""; }
function markFooter(ref) { const e = eridOf(ref); return "\n\nРеклама. " + ADVERTISER + (e ? ", erid: " + e : ""); }
function decode(s) { return String(s || "").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">"); }
function fmt(n) { return String(Math.round(Number(n))).replace(/\B(?=(\d{3})+(?!\d))/g, " "); }
async function translateName(s) {
    if (!/[A-Za-z]{3,}/.test(s)) return s;
    try {
        const res = await fetch("https://api.mymemory.translated.net/get?q=" + encodeURIComponent(s.slice(0, 450)) + "&langpair=en|ru");
        const j = await res.json();
        const t = j?.responseData?.translatedText;
        if (t && /[\u0400-\u04FF]/.test(t)) return t;
    } catch (e) { console.log("⚠️ Перевод: " + e.message); }
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

// ── ФИД: ПАРСЕР + ПУЛ ────────────────────────────────────
const STOP = /difference|supplement|postage|freight|after sales|shipping|surcharge|custom|do not|not sell|special link|payment|deposit|test|sample|fee|repair|link only|spare parts/i;
function parseOffer(b) {
    const g = (re) => { const m = b.match(re); return m ? m[1] : ""; };
    const id = g(/<offer[^>]*\bid="(\d{6,})"/) || ((b.match(/item(?:%252F|%2F|\/)(\d{6,})/) || [])[1] || "");
    const price = parseFloat(g(/<price>([\d.]+)</)) || 0;
    const old = parseFloat(g(/<old_price>([\d.]+)</)) || 0;
    let discount = parseInt(g(/<discount>(\d{1,3})/)) || 0;
    if (!discount && old > price && old > 0) discount = Math.round((1 - price / old) * 100);
    let commission = parseFloat(g(/<commission>([\d.]+)/)) || 0;
    if (!commission) { const two = b.match(/(\d{1,3})%\s*<\/[^>]+>\s*<[^>]+>\s*([\d.]+)\s*%/); if (two) commission = parseFloat(two[2]); }
    const img = g(/<(?:img|picture)[^>]*>(https?:[^<]+)<\/(?:img|picture)>/);
    return { id, price, old, discount, commission, img, name: decode(g(/<name>([\s\S]*?)<\/name>/) || g(/<title>([\s\S]*?)<\/title>/)) };
}
function passes(o) {
    if (!o.id || !o.img) return false;
    if (o.price < F_MIN_PRICE) return false;
    if (o.discount < F_MIN_DISC) return false;
    if (o.commission > 0 && o.commission < F_MIN_COMM) return false;
    if (STOP.test(o.name)) return false;
    if (o.name.length < 15) return false;
    return true;
}
async function fillPool(want = 150) {
    if (!ADM_FEED) throw new Error("нет ADMITAD_FEED_URL");
    const res = await fetch(ADM_FEED, { headers: { "User-Agent": "Mozilla/5.0", "Accept-Encoding": "identity" } });
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
                if (POOL.length >= want || bytes > 25 * 1048576) { reader.cancel(); console.log(`📦 Пул: ${POOL.length} (просмотрено ${seen}, ${(bytes / 1048576).toFixed(1)} МБ)`); return; }
            }
            if (buf.length > 300000) buf = buf.slice(-150000);
        }
    } catch (e) { console.log("⚠️ fillPool: " + e.message); }
    console.log(`📦 Пул: ${POOL.length} (просмотрено ${seen}, ${(bytes / 1048576).toFixed(1)} МБ)`);
}

// ── КАРТОЧКА ТОВАРА (вид будем тюнить) ───────────────────
function productCard(o, ref) {
    const L = ["👀 Сосед нашёл!", ""];
    L.push("🏷️ " + o.name);
    const p = Math.round(o.price * USD_RATE), op = Math.round((o.old || 0) * USD_RATE);
    if (p > 0) L.push("💰 " + (op > p ? `Было ${fmt(op)} ₽ → стало ${fmt(p)} ₽` : `${fmt(p)} ₽`));
    if (o.discount) L.push("💥 Скидка −" + o.discount + "%");
    L.push("", "👉 Забрать со скидкой:", ref);
    return L.join("\n");
}

// ── ПОСТЫ ────────────────────────────────────────────────
async function postWithPhoto(ctx, text, imgUrl) {
    const res = await fetch(imgUrl);
    if (!res.ok) throw new Error("фото HTTP " + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    const fs = await import("node:fs");
    const path = "/tmp/photo_" + Date.now() + ".jpg";
    fs.writeFileSync(path, buf);
    const image = await ctx.api.uploadImage({ source: path });
    await ctx.api.sendMessageToChat(CHANNEL_ID, text, { attachments: [image.toJson()] });
    console.log("📢 Пост с фото опубликован!");
}
async function postToChannel(text) {
    if (!CHANNEL_ID) { console.log("⚠️ CHANNEL_ID не задан"); return false; }
    try { await bot.api.sendMessageToChat(CHANNEL_ID, text); console.log("📢 Пост опубликован!"); return true; }
    catch (e) { console.log("⚠️ Пост не вышел: " + (e?.message ?? e)); return false; }
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

    // ── "ПОСТ" = случайный товар из фида ──
    if (low === "пост" || low === "post") {
        await bot.api.sendMessageToUser(uid, "⏳ Тяну случайный товар из фида…");
        try {
            if (!POOL.length) await fillPool(150);
            if (!POOL.length) { await bot.api.sendMessageToUser(uid, "😕 Пул пуст. Проверь фид/фильтры."); return; }
            let o = null;
            for (let i = 0; i < 15; i++) {
                const cand = POOL[Math.floor(Math.random() * POOL.length)];
                if (!LAST.has(cand.id)) { o = cand; break; }
            }
            if (!o) o = POOL[Math.floor(Math.random() * POOL.length)];
            LAST.add(o.id);
            const r = await makeAdmitadLink(`https://aliexpress.ru/item/${o.id}.html`);
            if (r.affiliate === false) {
                await bot.api.sendMessageToUser(uid, "⛔ Выпал неаффилиатный товар — пропускаю. Кинь «пост» ещё раз.");
                return;
            }
            const name = String(await translateName(o.name)).slice(0, 90);
            const card = productCard({ ...o, name }, r.link) + markFooter(r.link);
            await postWithPhoto(ctx, card, o.img);
            await saveProduct({ source: "aliexpress", external_id: o.id, title: name, price_new: Math.round(o.price * USD_RATE) || null, discount_percent: o.discount, image_url: o.img, original_url: `https://aliexpress.ru/item/${o.id}.html`, ref_url: r.link, category: "random", status: "posted", posted_at: new Date().toISOString() });
            await bot.api.sendMessageToUser(uid, `✅ Карточка в канале! (пул: ${POOL.length})\nСмотри вид и говори, что менять: текст, эмодзи, строки.`);
        } catch (e) { await bot.api.sendMessageToUser(uid, "⚠️ " + e.message); }
        return;
    }

    // ── "ПУЛ" = сколько товаров в памяти ──
    if (low === "пул") {
        if (!POOL.length) await fillPool(150);
        await bot.api.sendMessageToUser(uid, `📦 В пуле: ${POOL.length} товаров.\nФильтры сейчас: цена ≥ $${F_MIN_PRICE}, скидка ≥ ${F_MIN_DISC}%, комиссия ≥ ${F_MIN_COMM}%`);
        return;
    }

    // ── КУПОН ──
    if (low === "купон" || low === "промокод") {
        try {
            const t = await admGetToken();
            const res = await fetch(`https://api.admitad.com/coupons/?limit=50&advcampaign_id=${ADM_CAMPAIGN}`, { headers: { Authorization: "Bearer " + t } });
            if (!res.ok) throw new Error("coupons HTTP " + res.status);
            const j = await res.json();
            const coupons = j.coupons || [];
            if (!coupons.length) { await bot.api.sendMessageToUser(uid, "😕 Купонов пока нет."); return; }
            const c = coupons[0];
            const r = await makeAdmitadLink(c.url || "https://aliexpress.ru/");
            const code = c.code || c.coupon_code || "";
            const card = ["🎟 КУПОН / СКИДКА", "", "🏷️ " + decode(c.name || c.description || "Скидка в магазине AliExpress"), c.discount ? "💥 " + c.discount : "", code ? "🔑 Код: " + code : "✅ Промокод не нужен — скидка по ссылке", c.expiration_date ? "⏰ до " + String(c.expiration_date).slice(0, 10) : "", "", "👉 Забрать:", r.link].filter(Boolean).join("\n") + markFooter(r.link);
            const ok = await postToChannel(card);
            await bot.api.sendMessageToUser(uid, ok ? "✅ Купон в канале!" : "❌ Не выложил.");
        } catch (e) { await bot.api.sendMessageToUser(uid, "⚠️ " + e.message); }
        return;
    }

    // ── ССЫЛКА (ручной режим с данными) ──
    const link = text.match(/https?:\/\/[^\s|]+/);
    if (link && /aliexpress\.(ru|com)/i.test(link[0])) {
        const parts = text.split("|").map(s => s.trim());
        if (!parts[1]) {
            await bot.api.sendMessageToUser(uid, "✍️ Для карточки пришли: ссылка | название | цена | старая цена");
            return;
        }
        await bot.api.sendMessageToUser(uid, "⏳ Проверяю комиссию и делаю реф-ссылку…");
        try {
            const r = await makeAdmitadLink(link[0]);
            if (r.affiliate === false) { await bot.api.sendMessageToUser(uid, "❌ Комиссия НЕ платится — не постим."); return; }
            const ok = await postToChannel(["👀 Сосед нашёл!", "", "🏷️ " + parts[1], parts[2] ? "💰 " + (parts[3] ? `Было ${fmt(parts[3])} ₽ → стало ` : "") + fmt(parts[2]) + " ₽" : "", "", "👉 Забрать со скидкой:", r.link].join("\n") + markFooter(r.link));
            await bot.api.sendMessageToUser(uid, ok ? "✅ Пост в канале!" : "❌ Не выложил.");
        } catch (e) { await bot.api.sendMessageToUser(uid, "⚠️ " + e.message); }
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

console.log("🚀 «Сосед нашёл!» v10 (пост = рандом из фида) запущен");
bot.start();
