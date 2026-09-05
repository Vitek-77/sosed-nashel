// ============================================================
// 🛒 "СОСЕД НАШЁЛ!" — Москва и МО
// v9.4: купоны исправлены + стоп-лист НЕ АФФ + карточки магазинов
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

// ⛔ СТОП-ЛИСТ НЕАФФИЛИАТНЫХ МАГАЗИНОВ (из списка Admitad)
const NON_AFF = new Set(("1103489061,1104030822,1104037812,1104031803,3010045,2800188,1104981079,911355049,5070109,1104977094,911842395,1104977191,4776002,1103191382,1980682,1103472625,1104206902,911207215,2684007,1105175794,1104904457,1102210530,1105180541,608229,411294,1105131001,1577002,1105184508,1105226069,1105378045,1100115010,1104527004,1103330495,911755149,911058180,1102191945,1104631533,1105003602,910358408,1103203642,1105324765,204419,405501,1103864887,911812026,1105348580,1102092452,2939001,1104474060,911705531,5204010,1104160567,808990,1105223248,1367236,3889024,911971085,1104704612,5250176,2539007,5098062,4555045,1103657098,1105145263,1102634703,1971225,1103156072,2415022,4669071,1105185626,1719259,1105215075,912151410,1951301,1105092455,1105175729,1086484,4664082,1103370334,1104931660,2983032,3988037,5796744,1102989116,815336,2135107,2287083,5146085,4586015,1103187789,911055219,1104889053,5880442,1472219,1103337287,5791687,1104931478,1102305001,1102196689,910341212,1104338277,5208015,1105057251,1104074752,1103266478,805486,2828069,811228,1103276470,1105216738,1104067514,1102425440,911833474,1159132,911944912,1102056225,1953865,4847079,4998286,1971296,1103614199,4067001,1105250239,900246095,605052,1102597618,1103554327,1104781423,2227131,1020605,4921004,3097060,932490,219072,1103886793,911735070,3251001,5034021,1102291325,830007,4658150,5161049,912170163,1487249,4743011,510887,911820138,911683032,1104913427,2393002,3193060,5628349,912564544,4376032,1034164,1105209551,1105381909,2744003,5077386,5437112,3093007,911797189,1779070,3660007,5798857,803871,1103335351,2934031,912151058,1105074345,1105244708,1104399110,1086609,1945231,912115092,5214003").split(","));

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
    return { link: first.link, affiliate: first.is_affiliate_product };
}
async function getAliCoupons() {
    const t = await admGetToken();
    let res = await fetch(`https://api.admitad.com/coupons/?limit=50&advcampaign_id=${ADM_CAMPAIGN}`, { headers: { Authorization: "Bearer " + t } });
    if (!res.ok) res = await fetch("https://api.admitad.com/coupons/?limit=50", { headers: { Authorization: "Bearer " + t } });
    if (!res.ok) throw new Error("coupons HTTP " + res.status);
    const j = await res.json();
    const all = j.coupons || j.results || [];
    if (all[0]) console.log("🧾 Купон raw: " + JSON.stringify(all[0]).slice(0, 400));
    console.log("🧾 Купонов получено: " + all.length);
    return all;
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
    const code = c.code || c.coupon_code || c.promo_code || "";
    const name = c.name || c.title || c.description || "Скидка в магазине AliExpress";
    const L = ["🎟 КУПОН / СКИДКА", "", "🏷️ " + decode(name)];
    if (c.discount) L.push("💥 " + c.discount);
    L.push(code ? "🔑 Код: " + code : "✅ Промокод не нужен — скидка применится по ссылке");
    if (c.expiration_date) L.push("⏰ до " + String(c.expiration_date).slice(0, 10));
    L.push("", "👉 Забрать:", ref);
    return L.join("\n");
}

bot.hears(/.*/, async (ctx) => {
    const info = chatInfo(ctx);
    const uid = ctx.message?.sender?.user_id ?? ctx.from?.user_id ?? null;
    const text = getText(ctx);
    console.log(`💬 Чат: ${info.id} (${info.type}) | Юзер: ${uid} | Текст: ${text}`);
    if (!uid || String(info.type).includes("channel")) return;
    const low = text.trim().toLowerCase();

    if (low === "купон" || low === "промокод") {
        try {
            const coupons = await getAliCoupons();
            if (!coupons.length) { await bot.api.sendMessageToUser(uid, "😕 API купонов вернул пусто. Смотри лог 🧾 — там сырой ответ."); return; }
            const c = coupons[0];
            const target = c.url || c.landing_url || "https://aliexpress.ru/";
            const r = await makeAdmitadLink(target);
            const ok = await postToChannel(couponCard(c, r.link) + markFooter(r.link));
            await bot.api.sendMessageToUser(uid, ok ? `✅ Купон в канале! (всего: ${coupons.length})` : "❌ Не выложил.");
        } catch (e) { await bot.api.sendMessageToUser(uid, "⚠️ Admitad: " + e.message); }
        return;
    }

    const link = text.match(/https?:\/\/[^\s|]+/);
    if (link && /aliexpress\.(ru|com)/i.test(link[0])) {
        // проверка стоп-листа НЕ АФФ (для ссылок на магазины)
        const sm = link[0].match(/\/store\/(\d+)/);
        if (sm && NON_AFF.has(sm[1])) {
            await bot.api.sendMessageToUser(uid, "⛔ Магазин из списка НЕАФФИЛИАТНЫХ — комиссия не платится. Не постим. Выбери другой.");
            return;
        }
        await bot.api.sendMessageToUser(uid, "⏳ Проверяю комиссию и делаю реф-ссылку…");
        try {
            const r = await makeAdmitadLink(link[0]);
            if (r.affiliate === false) {
                await bot.api.sendMessageToUser(uid, "❌ За этот товар/магазин комиссия НЕ платится — в канал не постим.");
                return;
            }
            const parts = text.split("|").map(s => s.trim());
            let ok;
            if (parts[1]) {
                ok = await postToChannel(["👀 Сосед нашёл!", "", "🏷️ " + parts[1], parts[2] ? "💰 " + (parts[3] ? `Было ${fmt(parts[3])} ₽ → стало ` : "") + fmt(parts[2]) + " ₽" : "", "", "👉 Забрать со скидкой:", r.link].join("\n") + markFooter(r.link));
            } else if (sm) {
                ok = await postToChannel(["👀 Сосед нашёл!", "", "🏬 Годный магазин на AliExpress — скидки внутри 👇", "", "👉 Смотреть:", r.link].join("\n") + markFooter(r.link));
            } else {
                ok = await postToChannel(["👀 Сосед нашёл!", "", "🔥 Годная находка — цена по ссылке 👇", "", "👉 Забрать со скидкой:", r.link].join("\n") + markFooter(r.link));
            }
            await saveProduct({ source: "aliexpress", external_id: (link[0].match(/item\/(\d+)/) || [])[1] || sm?.[1] || link[0], title: parts[1] || (sm ? "Магазин " + sm[1] : link[0]), price_new: Number((parts[2] || "").replace(/\D/g, "")) || null, original_url: link[0], ref_url: r.link, category: sm ? "store" : "manual", status: "posted", posted_at: new Date().toISOString() });
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

console.log("🚀 «Сосед нашёл!» v9.4 (купоны + стоп-лист не афф) запущен");
bot.start();
