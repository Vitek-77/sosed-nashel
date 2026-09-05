// ============================================================
// 🛒 "СОСЕД НАШЁЛ!" — Москва и МО
// v15: точные цены/названия со страницы + запасные переводчики
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
function dec(s) { return String(s || "").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">"); }
const hasRu = (s) => /[а-яА-ЯЁё]{3,}/.test(s || "");

// ── ДАННЫЕ СО СТРАНИЦЫ ТОВАРА (название + цена) ──────────
async function fetchRuData(id) {
    try {
        const res = await fetch(`https://aliexpress.ru/item/${id}.html`, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36", "Accept-Language": "ru-RU,ru;q=0.9" } });
        if (!res.ok) { console.log("🏷️ Страница: статус " + res.status); return null; }
        const html = await res.text();
        const g = (re) => { const m = html.match(re); return m ? m[1] : ""; };
        let title = dec(g(/<meta[^>]*property="og:title"[^>]*content="([^"]+)"/) || g(/<title[^>]*>([^<]+)<\/title>/) || g(/"subject":"([^"]+)"/)).trim();
        if (!hasRu(title)) title = "";
        const price = g(/"price":\s*\{[^}]*"value":\s*"?([\d.]+)"?/) || g(/"price":"([\d.]+)"/) || g(/"minPrice":\s*"?([\d.]+)"?/);
        const oldPrice = g(/"originalPrice":\s*\{[^}]*"value":\s*"?([\d.]+)"?/) || g(/"originalPrice":"([\d.]+)"/);
        console.log(`🏷️ Страница: title=${(title || "-").slice(0, 40)} | price=${price || "-"} | old=${oldPrice || "-"}`);
        return { title, price: Number(price) || 0, oldPrice: Number(oldPrice) || 0 };
    } catch (e) { console.log("🏷️ Страница: " + e.message); return null; }
}

// ── ПЕРЕВОД (цепочка запасных сервисов) ──────────────────
async function translateName(s) {
    if (!/[A-Za-z]{3,}/.test(s) || hasRu(s)) return s;
    const q = encodeURIComponent(s.slice(0, 400));
    for (const host of ["lingva.ml", "lingva.lunar.icu", "translate.plausibility.cloud"]) {
        try {
            const r = await fetch(`https://${host}/api/v1/en/ru/${q}`);
            if (r.ok) { const j = await r.json(); const t = j?.translation; if (hasRu(t)) { console.log("🏷️ Перевод: " + host); return t; } }
        } catch (e) {}
    }
    try {
        const r = await fetch("https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=ru&dt=t&q=" + q);
        if (r.ok) { const j = await r.json(); const t = Array.isArray(j) && Array.isArray(j[0]) ? j[0].map(x => (x && x[0]) || "").join("") : ""; if (hasRu(t)) { console.log("🏷️ Перевод: Google"); return t; } }
    } catch (e) {}
    try {
        const r = await fetch("https://api.mymemory.translated.net/get?q=" + q + "&langpair=en|ru");
        if (r.ok) { const j = await r.json(); const t = j?.responseData?.translatedText; if (hasRu(t) && !/WARNING/i.test(t)) { console.log("🏷️ Перевод: MyMemory"); return t; } }
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

// ── ФИД ──────────────────────────────────────────────────
function parseOffer(b) {
    const g = (re) => { const m = b.match(re); return m ? m[1] : ""; };
    const id = g(/<offer[^>]*\bid="(\d{6,})"/) || ((b.match(/item(?:%252F|%2F|\/)(\d{6,})/) || [])[1] || "");
    let discount = parseInt(g(/<[^>]+>\s*(\d{1,3})\s*%\s*<\/[^>]+>/)) || 0;
    const img = g(/<(?:img|picture)[^>]*>(https?:[^<]+)<\/(?:img|picture)>/);
    return { id, discount, img, name: dec(g(/<name>([\s\S]*?)<\/name>/) || g(/<title>([\s\S]*?)<\/title>/)) };
}
function passes(o) {
    if (!o.id || !o.img) return false;
    if (o.discount < 40) return false;
    if (/difference|supplement|postage|freight|after sales|shipping|surcharge|custom|do not|not sell|special link|payment|deposit|test|sample|fee|repair|link only|spare parts/i.test(o.name)) return false;
    if (o.name.length < 15) return false;
    return true;
}
const POOL = [];
const LAST = new Set();
async function fillPool(want = 150) {
    const FEED = process.env.ADMITAD_FEED_URL || "";
    if (!FEED) throw new Error("нет ADMITAD_FEED_URL");
    const res = await fetch(FEED, { headers: { "User-Agent": "Mozilla/5.0", "Accept-Encoding": "identity" } });
    if (!res.ok) throw new Error("feed HTTP " + res.status);
    const reader = res.body.getReader();
    const d = new TextDecoder();
    let buf = "", bytes = 0, seen = 0;
    try {
        while (true) {
            const r = await reader.read();
            if (r.done) break;
            bytes += r.value.length;
            buf += d.decode(r.value, { stream: true });
            let m;
            while ((m = buf.match(/<offer[\s\S]*?<\/offer>/))) {
                const block = m[0];
                buf = buf.slice(buf.indexOf(block) + block.length);
                seen++;
                const o = parseOffer(block);
                if (passes(o)) POOL.push(o);
                if (POOL.length >= want || bytes > 25 * 1048576) { reader.cancel(); break; }
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

// ── КАРТОЧКА (только проверенные цифры) ─────────────────
function cardLines(name, page) {
    const L = ["📌 Сосед нашёл!", "", "🏷️ " + name];
    if (page && page.price > 0) {
        L.push("💰 " + (page.oldPrice > page.price ? `Было ${fmt(page.oldPrice)} ₽ → стало ` : "") + `${fmt(page.price)} ₽`);
        if (page.oldPrice > page.price) L.push("💥 Скидка −" + Math.round((1 - page.price / page.oldPrice) * 100) + "%");
    } else {
        L.push("💥 Скидка по ссылке 👇");
    }
    return L;
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

    // ── ПОСТ = случайный товар ──
    if (low === "пост" || low === "подборка" || low === "post") {
        await bot.api.sendMessageToUser(uid, "⏳ Ищу товар, проверяю цену и название…");
        try {
            if (!POOL.length) await fillPool(150);
            if (!POOL.length) { await bot.api.sendMessageToUser(uid, "😕 Пул пуст."); return; }
            let posted = false;
            for (let attempt = 0; attempt < 5 && !posted; attempt++) {
                let o = POOL[Math.floor(Math.random() * POOL.length)];
                for (let i = 0; i < 10; i++) { const c = POOL[Math.floor(Math.random() * POOL.length)]; if (!LAST.has(c.id)) { o = c; break; } }
                LAST.add(o.id);
                const clean = `https://aliexpress.ru/item/${o.id}.html`;
                const r = await makeAdmitadLink(clean);
                if (r.affiliate === false) { console.log("⚠️ Не аффилиат: " + o.id); continue; }
                const page = await fetchRuData(o.id);
                let name = page?.title || "";
                if (!name) name = String(await translateName(o.name)).slice(0, 90);
                await publish(cardLines(name, page).join("\n"), r.link, o.img);
                await saveProduct({ source: "aliexpress", external_id: o.id, title: name, price_new: page?.price || null, image_url: o.img, original_url: clean, ref_url: r.link, category: "auto", status: "posted", posted_at: new Date().toISOString() });
                posted = true;
            }
            await bot.api.sendMessageToUser(uid, posted ? "✅ Карточка в канале!" : "😕 Все кандидаты неаффилиатные — кинь «пост» ещё раз.");
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
            const body = ["📌 КУПОН / СКИДКА", "", "🏷️ " + dec(c.name || c.description || "Скидка в магазине AliExpress").slice(0, 90), c.discount ? "💥 " + c.discount : "", code ? "🔑 Код: " + code : "✅ Промокод не нужен — скидка по ссылке", c.expiration_date ? "⏰ до " + String(c.expiration_date).slice(0, 10) : ""].filter(Boolean).join("\n");
            await publish(body, r.link, null);
            await bot.api.sendMessageToUser(uid, "✅ Купон в канале!");
        } catch (e) { await bot.api.sendMessageToUser(uid, "⚠️ " + e.message); }
        return;
    }

    // ── ССЫЛКА вручную ──
    const link = text.match(/https?:\/\/[^\s|]+/);
    if (link && /aliexpress\.(ru|com)/i.test(link[0])) {
        const parts = text.split("|").map(s => s.trim());
        if (!parts[1]) { await bot.api.sendMessageToUser(uid, "✍️ Пришли: ссылка | название | цена | старая цена"); return; }
        await bot.api.sendMessageToUser(uid, "⏳ Проверяю комиссию…");
        try {
            const r = await makeAdmitadLink(link[0]);
            if (r.affiliate === false) { await bot.api.sendMessageToUser(uid, "❌ Комиссия НЕ платится — не постим."); return; }
            const body = ["📌 Сосед нашёл!", "", "🏷️ " + parts[1], parts[2] ? "💰 " + (parts[3] ? `Было ${fmt(parts[3])} ₽ → стало ` : "") + fmt(parts[2]) + " ₽" : ""].filter(Boolean).join("\n");
            await publish(body, r.link, null);
            await saveProduct({ source: "aliexpress", external_id: (link[0].match(/item\/(\d+)/) || [])[1] || link[0], title: parts[1], price_new: Number((parts[2] || "").replace(/\D/g, "")) || null, original_url: link[0], ref_url: r.link, category: "manual", status: "posted", posted_at: new Date().toISOString() });
            await bot.api.sendMessageToUser(uid, "✅ Пост в канале! Комиссия капает 💰");
        } catch (e) { await bot.api.sendMessageToUser(uid, "⚠️ " + e.message); }
        return;
    }

    if (low === "тест") {
        await publish(["📌 Сосед нашёл!", "", "🏷️ Набор из 10 бесшовных заколок для волос", "💰 Было 309 ₽ → стало 99 ₽ (−68%)"].join("\n"), "https://aliexpress.ru/one-price", null);
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

console.log("🚀 «Сосед нашёл!» v15 (точные цены + запасные переводчики) запущен");
bot.start();
