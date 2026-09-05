// ============================================================
// 🛒 "СОСЕД НАШЁЛ!" — Москва и МО
// v10.1: исправлен парсер фида (oldprice, проценты) + диагностика
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

// ⛔ НЕ АФФ магазины (из таблицы Admitad) — верх списка
const NON_AFF = new Set(("1103489061,1104030822,1104037812,3010045,2800188,1104981079,911355049,1104031803,5070109,1104977094,911842395,1104977191,4776002,1103191382,1980682,1103472625,1104206902,911207215,2684007,1105175794,1104904457,1102210530,1105180541,608229,411294,1105131001,1577002,1105184508,1105226069,1105378045,1100115010,1104527004,1103330495,911755149,911058180,1102191945,1104631533,1105003602,910358408,1103203642,1105324765,204419,405501,1103864887,911812026,1105348580,1102092452,2939001,1104474060,911705531,5204010,1104160567,808990,1105223248,1367236,3889024,911971085,1104704612,5250176,2539007,5098062,4555045,1103657098,1105145263,1102634703,1971225,1103156072,2415022,4669071,1105185626,1719259,1105215075,912151410,1951301,1105092455,1105175729,1086484,4664082,1103370334,1104931660,1104554261,2983032,3988037,5796744,1102989116,912618659,815336,2135107,2287083,5146085,4586015,1103187789,911055219,1104889053,5880442,1472219,1103337287,5791687,1104931478,1102305001,1102196689,5244086,912432424,4392085,609719,1100324072,1104094069,1103474448,1104802041,911599067,1103181009,1102062110").split(","));

const STOP = /difference|supplement|postage|freight|after sales|shipping|surcharge|custom|do not|not sell|special link|payment|deposit|test|sample|fee|repair|link only|spare parts|accessories store/i;

const bot = new Bot(TOKEN);

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

// ── ПАРСЕР ФИДА v2 (терпит любые теги) ───────────────────
function parseOffer(b) {
    const g = (re) => { const m = b.match(re); return m ? m[1] : ""; };
    const id = g(/<offer[^>]*\bid="(\d{6,})"/) || ((b.match(/item(?:%252F|%2F|\/)(\d{6,})/) || [])[1] || "");
    const url = g(/<url>([\s\S]*?)<\/url>/);
    const price = parseFloat(g(/<price>([\d.]+)</)) || 0;
    const old = parseFloat(g(/<oldprice>([\d.]+)</) || g(/<old_price>([\d.]+)</)) || 0;
    let discount = parseInt(g(/<[^>]+>\s*(\d{1,3})\s*%\s*<\/[^>]+>/)) || 0;
    if (!discount && old > price && old > 0) discount = Math.round((1 - price / old) * 100);
    const commission = parseFloat(g(/<[^>]+>\s*(\d+\.\d+)\s*%\s*<\/[^>]+>/)) || 0;
    const img = g(/<(?:img|picture)[^>]*>(https?:[^<]+)<\/(?:img|picture)>/);
    return { id, url, price, old, discount, commission, img, name: decode(g(/<name>([\s\S]*?)<\/name>/) || g(/<title>([\s\S]*?)<\/title>/)) };
}
function passes(o) {
    if (!o.id || !o.img) return false;
    if (o.price < 0.5) return false;          // мусор с 0.00 — мимо
    if (o.discount < 40) return false;        // слабые скидки — мимо
    if (STOP.test(o.name)) return false;      // «доплаты/тесты» — мимо
    if (o.name.length < 15) return false;
    return true;
}

// ── ПУЛ ──────────────────────────────────────────────────
const POOL = [];
const LAST = new Set();
async function fillPool(want = 150) {
    if (!ADM_FEED) throw new Error("нет ADMITAD_FEED_URL");
    const res = await fetch(ADM_FEED, { headers: { "User-Agent": "Mozilla/5.0", "Accept-Encoding": "identity" } });
    if (!res.ok) throw new Error("feed HTTP " + res.status);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "", bytes = 0, seen = 0, withPrice = 0, loggedReal = false;
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
                if (o.price > 0) {
                    withPrice++;
                    if (!loggedReal) { loggedReal = true; console.log("🧬 Товар с ценой: " + block.slice(0, 700)); }
                }
                if (passes(o)) POOL.push(o);
                if (POOL.length >= want || bytes > 25 * 1048576) { reader.cancel(); break; }
            }
            if (buf.length > 300000) buf = buf.slice(-150000);
            if (POOL.length >= want) break;
        }
    } catch (e) { if (!POOL.length) throw e; }
    console.log(`📦 Пул: ${POOL.length} (с ценой: ${withPrice}, просмотрено ${seen}, ${(bytes / 1048576).toFixed(1)} МБ)`);
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
function fmt(n) { return String(Math.round(Number(n))).replace(/\B(?=(\d{3})+(?!\d))/g, " "); }
function productCard(o, ref) {
    const p = Math.round(o.price * USD_RATE), op = Math.round((o.old || 0) * USD_RATE);
    const L = ["👀 Сосед нашёл!", "", "🏷️ " + o.name];
    if (p > 0) L.push("💰 " + (op > p ? `Было ${fmt(op)} ₽ → стало ` : "") + `около ${fmt(p)} ₽`);
    if (o.discount) L.push("💥 Скидка −" + o.discount + "%");
    L.push("", "👉 Забрать со скидкой:", ref);
    return L.join("\n") + markFooter(ref);
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

    // ── ПОСТ = случайный товар из фида ──
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
            const clean = `https://aliexpress.ru/item/${o.id}.html`;
            const r = await makeAdmitadLink(clean);
            if (r.affiliate === false) {
                await bot.api.sendMessageToUser(uid, "⛔ Выпал неаффилиатный товар — тяну ещё раз. Кинь «пост» ещё раз.");
                return;
            }
            const name = String(await translateName(o.name)).slice(0, 90);
            const ok = await postWithPhoto(ctx, productCard({ ...o, name }, r.link), o.img);
            await saveProduct({ source: "aliexpress", external_id: o.id, title: name, price_new: Math.round(o.price * USD_RATE) || null, discount_percent: o.discount, image_url: o.img, original_url: clean, ref_url: r.link, category: "random", status: "posted", posted_at: new Date().toISOString() });
            await bot.api.sendMessageToUser(uid, "✅ Карточка с фото в канале! (пул: " + POOL.length + ")");
        } catch (e) { await bot.api.sendMessageToUser(uid, "⚠️ " + e.message); }
        return;
    }

    // ── ПУЛ = статистика ──
    if (low === "пул") {
        if (!POOL.length) await fillPool(150);
        await bot.api.sendMessageToUser(uid, `📦 В пуле: ${POOL.length} товаров.`);
        return;
    }

    // ── ССЫЛКА (ручной режим с данными) ──
    const link = text.match(/https?:\/\/[^\s|]+/);
    if (link && /aliexpress\.(ru|com)/i.test(link[0])) {
        const sm = link[0].match(/\/store\/(\d+)/);
        if (sm && NON_AFF.has(sm[1])) {
            await bot.api.sendMessageToUser(uid, "⛔ Магазин из списка НЕАФФИЛИАТНЫХ — комиссия не платится. Не постим.");
            return;
        }
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
            await saveProduct({ source: "aliexpress", external_id: (link[0].match(/item\/(\d+)/) || [])[1] || sm?.[1] || link[0], title: parts[1], price_new: Number((parts[2] || "").replace(/\D/g, "")) || null, original_url: link[0], ref_url: r.link, category: "manual", status: "posted", posted_at: new Date().toISOString() });
            await bot.api.sendMessageToUser(uid, (ok ? "✅ Пост в канале! Комиссия капает 💰\n" : "❌ Не выложил.\n") + "🔗 Реф-ссылка:\n" + r.link);
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

console.log("🚀 «Сосед нашёл!» v10.1 (парсер фида исправлен) запущен");
bot.start();
