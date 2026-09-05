// ============================================================
// 🛒 "СОСЕД НАШЁЛ!" — Москва и МО
// v9.5: чистые подборки (фильтр мусора) + без голых тизеров
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
const NON_AFF = new Set(("1103489061,1104030822,1104037812,3010045,2800188,1104981079,911355049,1104031803,5070109,1104977094,911842395,1104977191,4776002,1103191382,1980682,1103472625,1104206902,911207215,2684007,1105175794,1104904457,1102210530,1105180541,608229,411294,1105131001,1577002,1105184508,1105226069,1105378045,1100115010,1104527004,1103330495,911755149,911058180,1102191945,1104631533,1105003602,910358408,1103203642,1105324765,204419,405501,1103864887,911812026,1105348580,1102092452,2939001,1104474060,911705531,5204010,1104160567,808990,1105223248,1367236,3889024,911971085,1104704612,5250176,2539007,5098062,4555045,1103657098,1105145263,1102634703,1971225,1103156072,2415022,4669071,1105185626,1719259,1105215075,912151410,1951301,1105092455,1105175729,1086484,4664082,1103370334,1104931660,1104554261,2983032,3988037,5796744,1102989116,912618659,815336,2135107,2287083,5146085,4586015,1103187789,911055219,1104889053,5880442,1472219,1103337287,5791687,1104931478,1102305001,1102196689,5244086,912432424,4392085,609719,1104074752,1103266478,805486,2828069,811228,1103276470,1105216738,1104067514,1102425440,911833474,1159132,1105181620,1104111857,1103474448,912067676,4383081,5374134,911944912,1102056225,1953865,4847079,4998286,1971296,1103614199,4067001,1105250239,900246095,605052,1102597618,1103554327,1104781423,2227131,1105280985,1020605,4921004,1103812459,3097060,932490,219072,1103886793,911735070,3251001,5034021,1105134507,1102291325,1103739106,830007,4658150,5161049,912170163,1487249,4743011,510887,911820138,911683032,1104913427,2393002,3193060,5628349,912564544,1103797110,4376032,1034164,1105209551,1105381909,2744003,1105185563,5077386,1105437829,5437112,3093007,911797189,1779070,3660007,5798857,803871,1103335351,2934031,912151058,1105074345,1105244708,1104399110,1086609,1945231,912115092,5214003").split(","));

// 🗑 Стоп-слова «мусорных» товаров фида
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
    console.log("🔗 Deeplink ответ (" + res.status + "): " + txt.slice(0, 200));
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

// ── ФИД: парсер + жёсткий фильтр ─────────────────────────
function parseOffer(b) {
    const g = (re) => { const m = b.match(re); return m ? m[1] : ""; };
    const id = g(/<offer[^>]*\bid="(\d{6,})"/) || ((b.match(/item(?:%252F|%2F|\/)(\d{6,})/) || [])[1] || "");
    const url = g(/<url>([\s\S]*?)<\/url>/);
    const price = parseFloat(g(/<price>([\d.]+)</)) || 0;
    const oldPrice = parseFloat(g(/<old_price>([\d.]+)</)) || 0;
    const discount = parseInt(g(/<discount>(\d{1,3})/)) || (oldPrice > price && oldPrice > 0 ? Math.round((1 - price / oldPrice) * 100) : 0);
    const commission = parseFloat(g(/<commission>([\d.]+)/)) || 0;
    const hot = /hot_product(%3D|=)1/.test(url) ? 1 : 0;
    const img = g(/<(?:img|picture)[^>]*>(https?:[^<]+)<\/(?:img|picture)>/);
    return { id, url, price, oldPrice, discount, commission, hot, img, name: decode(g(/<name>([\s\S]*?)<\/name>/) || g(/<title>([\s\S]*?)<\/title>/)) };
}
function goodOffer(o) {
    if (!o.id || !o.img) return false;
    if (o.price < 0.5) return false;          // мусор с ценой 0 — сразу мимо
    if (o.discount < 40 || o.commission < 3) return false;
    if (STOP.test(o.name)) return false;      // «доплаты/разницы/тесты» — мимо
    if (o.name.length < 15) return false;
    return true;
}
async function fetchFeedOffers(want = 30) {
    if (!ADM_FEED) throw new Error("нет ADMITAD_FEED_URL");
    const ctrl = new AbortController();
    const offers = [];
    let bytes = 0, seen = 0;
    try {
        const res = await fetch(ADM_FEED, { signal: ctrl.signal, headers: { "User-Agent": "Mozilla/5.0", "Accept-Encoding": "identity" } });
        if (!res.ok) throw new Error("feed HTTP " + res.status);
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
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
                if (goodOffer(o)) offers.push(o);
                if (offers.length >= want) { ctrl.abort(); break; }
            }
            if (buf.length > 300000) buf = buf.slice(-150000);
            if (offers.length >= want) break;
        }
    } catch (e) {
        if (!offers.length) throw e;
    }
    console.log(`📊 Поток: ${(bytes / 1048576).toFixed(1)} МБ, просмотрено ${seen}, отобрано ${offers.length}`);
    return offers;
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

// ── ПОДБОРКА ─────────────────────────────────────────────
async function runSelection(ctx, uid) {
    await bot.api.sendMessageToUser(uid, "⏳ Сканирую фид: ищу РЕАЛЬНЫЕ товары со скидкой и комиссией…");
    try {
        const offers = await fetchFeedOffers(30);
        if (!offers.length) { await bot.api.sendMessageToUser(uid, "😕 Подходящих товаров не нашлось."); return; }
        offers.sort((a, b) => (b.hot - a.hot) || (b.discount - a.discount));
        const top = offers.slice(0, 3);
        let posted = 0;
        for (const o of top) {
            try {
                const clean = `https://aliexpress.ru/item/${o.id}.html`;
                const r = await makeAdmitadLink(clean);
                if (r.affiliate === false) { console.log("⚠️ Не аффилиат: " + o.id); continue; }
                const name = String(await translateName(o.name)).slice(0, 90);
                const lines = ["👀 Сосед нашёл!", "", "🏷️ " + name, `💥 Скидка −${o.discount}%`];
                if (o.price > 0) lines.push("💰 " + (o.oldPrice > o.price ? `Было ${fmt(o.oldPrice * USD_RATE)} ₽ → стало ` : "") + `около ${fmt(o.price * USD_RATE)} ₽`);
                lines.push("", "👉 Забрать со скидкой:", r.link);
                const text = lines.join("\n") + markFooter(r.link);
                try { await postWithPhoto(ctx, text, o.img); }
                catch (e) { console.log("⚠️ Фото не вышло: " + e.message); await postToChannel(text); }
                await saveProduct({ source: "aliexpress", external_id: o.id, title: name, price_new: Math.round(o.price * USD_RATE) || null, discount_percent: o.discount, image_url: o.img, original_url: clean, ref_url: r.link, category: "auto", status: "posted", posted_at: new Date().toISOString() });
                posted++;
            } catch (e) { console.log("⚠️ Товар " + o.id + ": " + e.message); }
        }
        await bot.api.sendMessageToUser(uid, posted ? `✅ Готово! Карточек с фото: ${posted}` : "😕 Все кандидаты отфильтрованы (не аффилиат).");
    } catch (e) { await bot.api.sendMessageToUser(uid, "⚠️ Фид: " + e.message); }
}

// ── КУПОН ────────────────────────────────────────────────
async function runCoupon(uid) {
    try {
        const coupons = await getAliCoupons();
        if (!coupons.length) { await bot.api.sendMessageToUser(uid, "😕 Купонов пока нет."); return; }
        const c = coupons[0];
        const r = await makeAdmitadLink(c.url || "https://aliexpress.ru/");
        const code = c.code || c.coupon_code || "";
        const text = ["🎟 КУПОН / СКИДКА", "", "🏷️ " + decode(c.name || c.description || "Скидка в магазине AliExpress"), c.discount ? "💥 " + c.discount : "", code ? "🔑 Код: " + code : "✅ Промокод не нужен — скидка по ссылке", c.expiration_date ? "⏰ до " + String(c.expiration_date).slice(0, 10) : "", "", "👉 Забрать:", r.link].filter(Boolean).join("\n") + markFooter(r.link);
        const ok = await postToChannel(text);
        await bot.api.sendMessageToUser(uid, ok ? "✅ Купон в канале!" : "❌ Не выложил.");
    } catch (e) { await bot.api.sendMessageToUser(uid, "⚠️ Admitad: " + e.message); }
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

    if (low === "купон" || low === "промокод") { await runCoupon(uid); return; }
    if (low === "подборка" || low === "найди" || low === "поиск") { await runSelection(ctx, uid); return; }

    const link = text.match(/https?:\/\/[^\s|]+/);
    if (link && /aliexpress\.(ru|com)/i.test(link[0])) {
        const sm = link[0].match(/\/store\/(\d+)/);
        if (sm && NON_AFF.has(sm[1])) {
            await bot.api.sendMessageToUser(uid, "⛔ Магазин из списка НЕАФФИЛИАТНЫХ — комиссия не платится. Не постим.");
            return;
        }
        const parts = text.split("|").map(s => s.trim());
        if (!parts[1]) {
            await bot.api.sendMessageToUser(uid, "✍️ Чтобы карточка была красивой, пришли в формате:\nссылка | название | цена | старая цена\n(голые ссылки больше не постим — иначе канал выглядит плохо)");
            return;
        }
        await bot.api.sendMessageToUser(uid, "⏳ Проверяю комиссию и делаю реф-ссылку…");
        try {
            const r = await makeAdmitadLink(link[0]);
            if (r.affiliate === false) {
                await bot.api.sendMessageToUser(uid, "❌ Комиссия НЕ платится — в канал не постим.");
                return;
            }
            const ok = await postToChannel(["👀 Сосед нашёл!", "", "🏷️ " + parts[1], parts[2] ? "💰 " + (parts[3] ? `Было ${fmt(parts[3])} ₽ → стало ` : "") + fmt(parts[2]) + " ₽" : "", "", "👉 Забрать со скидкой:", r.link].join("\n") + markFooter(r.link));
            await saveProduct({ source: "aliexpress", external_id: (link[0].match(/item\/(\d+)/) || [])[1] || sm?.[1] || link[0], title: parts[1], price_new: Number((parts[2] || "").replace(/\D/g, "")) || null, original_url: link[0], ref_url: r.link, category: "manual", status: "posted", posted_at: new Date().toISOString() });
            await bot.api.sendMessageToUser(uid, (ok ? "✅ Пост в канале! Комиссия капает 💰\n" : "❌ Не выложил.\n") + "🔗 Реф-ссылка:\n" + r.link);
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

console.log("🚀 «Сосед нашёл!» v9.5 (чистые подборки) запущен");
bot.start();
