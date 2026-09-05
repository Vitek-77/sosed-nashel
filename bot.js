// ============================================================
// 🛒 "СОСЕД НАШЁЛ!" — Москва и МО
// v9.1: надёжное чтение фида (заголовки, ретрай, счётчики)
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
    return (j.coupons || []).filter(c => /aliexpress/i.test(String(c.advcampaign_name || "")));
}

// ── ЧТЕНИЕ ФИДА (надёжное, со счётчиками) ────────────────
function parseOffer(b) {
    const g = (re) => { const m = b.match(re); return m ? m[1] : ""; };
    const url = g(/<url>([\s\S]*?)<\/url>/);
    const idm = url.match(/item%2F(\d{6,})/) || url.match(/item\/(\d{6,})/);
    return {
        url,
        id: idm ? idm[1] : "",
        name: decode(g(/<name>([\s\S]*?)<\/name>/) || g(/<title>([\s\S]*?)<\/title>/)),
        price: g(/<price>([\d.]+)/),
        oldPrice: g(/<old_price>([\d.]+)/),
        discount: parseInt(g(/<discount>(\d+)/)) || 0,
        commission: parseFloat(g(/<commission>([\d.]+)/)) || 0,
        img: g(/<(?:img|picture)>(https?:[\s\S]*?)<\/(?:img|picture)>/)
    };
}
function goodOffer(o) {
    if (!o.id || !o.img) return false;
    if (o.discount < 40 || o.commission < 3) return false;
    if (/test|difference|shipping|supplement|postage|freight|custom|do not|after sales|paypay|link only|surcharge/i.test(o.name)) return false;
    if (o.name.length < 15) return false;
    return true;
}
async function fetchFeedOffers(want = 30) {
    if (!ADM_FEED) throw new Error("нет ADMITAD_FEED_URL");
    let lastErr = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
        const ctrl = new AbortController();
        const offers = [];
        let bytes = 0, seen = 0;
        try {
            const res = await fetch(ADM_FEED, {
                signal: ctrl.signal,
                headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", "Accept": "*/*", "Accept-Encoding": "identity" }
            });
            if (!res.ok) throw new Error("feed HTTP " + res.status);
            const reader = res.body.getReader();
            const dec = new TextDecoder();
            let buf = "", first = true;
            while (true) {
                const r = await reader.read();
                if (r.done) break;
                bytes += r.value.length;
                buf += dec.decode(r.value, { stream: true });
                let m;
                while ((m = buf.match(/<offer[\s\S]*?<\/offer>/))) {
                    const block = m[0];
                    if (first) { console.log("🧬 Пример offer: " + block.slice(0, 400)); first = false; }
                    buf = buf.slice(buf.indexOf(block) + block.length);
                    seen++;
                    const o = parseOffer(block);
                    if (goodOffer(o)) offers.push(o);
                    if (offers.length >= want) {
                        ctrl.abort();
                        console.log(`📊 Поток остановлен: ${(bytes / 1048576).toFixed(1)} МБ, просмотрено ${seen}, отобрано ${offers.length}`);
                        return offers;
                    }
                }
                if (buf.length > 300000) buf = buf.slice(-150000);
            }
            console.log(`📊 Поток завершён: ${(bytes / 1048576).toFixed(1)} МБ, просмотрено ${seen}, отобрано ${offers.length}`);
            if (offers.length) return offers;
            throw new Error("фид прочитан, но подходящих товаров 0");
        } catch (e) {
            lastErr = e;
            console.log(`⚠️ Попытка ${attempt}: ${e.message} | МБ: ${(bytes / 1048576).toFixed(1)}, просмотрено: ${seen}, отобрано: ${offers.length}`);
            if (offers.length) return offers;
        }
    }
    throw lastErr || new Error("фид не дал товаров");
}

// ── ПОСТ С ФОТО ──────────────────────────────────────────
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
function fmt(n) { return String(Math.round(Number(n))).replace(/\B(?=(\d{3})+(?!\d))/g, " "); }
function chatInfo(ctx) {
    const c = ctx.chat || ctx.message?.chat || ctx.message?.recipient || {};
    return { id: c.chat_id ?? c.id ?? null, type: c.chat_type ?? c.type ?? "?" };
}
function couponCard(c, ref) {
    return ["🎟 ПРОМОКОД: " + (c.code || c.coupon_code || "—"), "💥 " + (c.discount || ""), "📝 " + (c.description || ""), "⏰ до " + (c.expiration_date ? String(c.expiration_date).slice(0, 10) : "—"), "", "👉 Активировать:", ref].join("\n");
}

// ── АВТОПОДБОРКА ─────────────────────────────────────────
async function runSelection(ctx, uid) {
    await bot.api.sendMessageToUser(uid, "⏳ Сканирую фид: ищу жирные скидки с комиссией…");
    try {
        const offers = await fetchFeedOffers(30);
        console.log("🎯 Отобрано кандидатов: " + offers.length);
        if (!offers.length) { await bot.api.sendMessageToUser(uid, "😕 В фиде не нашлось подходящих товаров."); return; }
        offers.sort((a, b) => b.discount - a.discount);
        const top = offers.slice(0, 3);
        let posted = 0;
        for (const o of top) {
            try {
                const clean = `https://aliexpress.ru/item/${o.id}.html`;
                const r = await makeAdmitadLink(clean);
                if (!r.affiliate) { console.log("⚠️ Не аффилиат: " + o.id); continue; }
                const text = ["👀 Сосед нашёл!", "", "🏷️ " + o.name, `💥 Скидка −${o.discount}%`, "", "👉 Забрать со скидкой:", r.link].join("\n") + markFooter(r.link);
                try { await postWithPhoto(ctx, text, o.img); }
                catch (e) { console.log("⚠️ Фото не вышло: " + e.message); await postToChannel(text); }
                await saveProduct({ source: "aliexpress", external_id: o.id, title: o.name, price_new: null, discount_percent: o.discount, image_url: o.img, original_url: clean, ref_url: r.link, category: "auto", status: "posted", posted_at: new Date().toISOString() });
                posted++;
            } catch (e) { console.log("⚠️ Товар " + o.id + ": " + e.message); }
        }
        await bot.api.sendMessageToUser(uid, posted ? `✅ Готово! Карточек с фото в канале: ${posted}` : "😕 Все кандидаты без комиссии — попробуй ещё раз.");
    } catch (e) { await bot.api.sendMessageToUser(uid, "⚠️ Фид: " + e.message); }
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

async function runPhotoTest(ctx, uid) {
    const demoUrl = "https://ae04.alicdn.com/kf/S1c00c769b2de4ea78cf5fdd606738f2e4.jpg_480x480.jpg";
    await bot.api.sendMessageToUser(uid, "⏳ Собираю пост с картинкой…");
    try {
        await postWithPhoto(ctx, "👀 Сосед нашёл! Тест поста с фото 📸\n\n🏷️ Так будут выглядеть карточки товаров с картинкой" + markFooter(""), demoUrl);
        await bot.api.sendMessageToUser(uid, "✅ Пост с фото в канале! Смотри 👀");
    } catch (e) { await bot.api.sendMessageToUser(uid, "⚠️ Фото не удалось: " + e.message); }
}

bot.hears(/.*/, async (ctx) => {
    const info = chatInfo(ctx);
    const uid = ctx.message?.sender?.user_id ?? ctx.from?.user_id ?? null;
    const text = getText(ctx);
    console.log(`💬 Чат: ${info.id} (${info.type}) | Юзер: ${uid} | Текст: ${text}`);
    if (!uid || String(info.type).includes("channel")) return;
    const low = text.trim().toLowerCase();

    if (low === "купон" || low === "промокод") { await runCoupon(uid); return; }
    if (low === "подборка" || low === "найди" || low === "поиск") { await runSelection(ctx, uid); return; }
    if (low === "фототест") { await runPhotoTest(ctx, uid); return; }

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

console.log("🚀 «Сосед нашёл!» v9.1 (надёжный фид) запущен");
bot.start();
