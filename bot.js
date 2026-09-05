// ============================================================
// 🛒 "СОСЕД НАШЁЛ!" — Москва и МО
// v7.5: токен Admitad ТОЧНО по документации (добавлен scope)
// ============================================================
import { Bot } from "@maxhub/max-bot-api";

const TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID ? Number(process.env.CHANNEL_ID) : null;
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_KEY || "";
const ADM_CLIENT = process.env.ADMITAD_CLIENT_ID || "";
const ADM_SECRET = process.env.ADMITAD_CLIENT_SECRET || "";
const ADM_BASIC = process.env.ADMITAD_BASIC || "";

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

// ── ADMITAD (по официальной документации) ────────────────
let admToken = null, admExp = 0, aliCampaignId = null;

async function admGetToken() {
    if (admToken && Date.now() < admExp) return admToken;
    const basic = ADM_BASIC || Buffer.from(ADM_CLIENT + ":" + ADM_SECRET).toString("base64");
    const res = await fetch("https://api.admitad.com/token/", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8", Authorization: "Basic " + basic },
        body: new URLSearchParams({
            grant_type: "client_credentials",
            client_id: ADM_CLIENT,
            scope: "advcampaigns websites coupons deeplink banners"
        })
    });
    const txt = await res.text();
    console.log("🔑 Admitad token (" + res.status + "): " + txt.slice(0, 200));
    if (!res.ok) throw new Error("Admitad token HTTP " + res.status);
    const j = JSON.parse(txt);
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
    console.log("🎯 Кампания AliExpress: id=" + aliCampaignId + " (" + (ru ? ru.name : "не найдена") + ")");
    return aliCampaignId;
}
async function makeAdmitadLink(url) {
    const cid = await findAliCampaign();
    const t = await admGetToken();
    const res = await fetch("https://api.admitad.com/deeplink/", {
        method: "POST",
        headers: { Authorization: "Bearer " + t, "Content-Type": "application/json" },
        body: JSON.stringify({ url, advcampaign_id: cid })
    });
    const txt = await res.text();
    console.log("🔗 Deeplink ответ (" + res.status + "): " + txt.slice(0, 300));
    if (!res.ok) throw new Error("deeplink HTTP " + res.status);
    try { return JSON.parse(txt).url || url; } catch (e) { return url; }
}
async function getAliCoupons() {
    const j = await admGet("/coupons/?limit=100&status=active");
    const all = j.coupons || [];
    if (all[0]) console.log("🧾 Пример купона: " + JSON.stringify(all[0]).slice(0, 300));
    return all.filter(c => /aliexpress/i.test(String(c.advcampaign_name || "")));
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
            if (!coupons.length) { await bot.api.sendMessageToUser(uid, "😕 У AliExpress сейчас нет активных купонов в Admitad."); return; }
            const c = coupons[0];
            const ref = await makeAdmitadLink(c.url || "https://aliexpress.ru/");
            const ok = await postToChannel(couponCard(c, ref));
            await bot.api.sendMessageToUser(uid, ok ? `✅ Купон в канале! (всего: ${coupons.length})` : "❌ Не выложил.");
        } catch (e) { await bot.api.sendMessageToUser(uid, "⚠️ Admitad: " + e.message); }
        return;
    }

    const link = text.match(/https?:\/\/[^\s|]+/);
    if (link && /aliexpress\.(ru|com)/i.test(link[0])) {
        await bot.api.sendMessageToUser(uid, "⏳ Делаю реф-ссылку через Admitad…");
        try {
            const ref = await makeAdmitadLink(link[0]);
            const parts = text.split("|").map(s => s.trim());
            let ok;
            if (parts[1]) {
                ok = await postToChannel(["👀 Сосед нашёл!", "", "🏷️ " + parts[1], parts[2] ? "💰 " + (parts[3] ? `Было ${fmt(parts[3])} ₽ → стало ` : "") + fmt(parts[2]) + " ₽" : "", "", "👉 Забрать со скидкой:", ref].join("\n"));
            } else {
                ok = await postToChannel(["👀 Сосед нашёл!", "", "🔥 Годная находка — цена по ссылке 👇", "", "👉 Забрать со скидкой:", ref].join("\n"));
            }
            await saveProduct({ source: "aliexpress", external_id: (link[0].match(/item\/(\d+)/) || [])[1] || link[0], title: parts[1] || link[0], price_new: Number((parts[2] || "").replace(/\D/g, "")) || null, original_url: link[0], ref_url: ref, category: "manual", status: "posted", posted_at: new Date().toISOString() });
            await bot.api.sendMessageToUser(uid, (ok ? "✅ Пост в канале!\n" : "❌ В канал не выложил.\n") + "🔗 Твоя реф-ссылка:\n" + ref);
        } catch (e) { await bot.api.sendMessageToUser(uid, "⚠️ Admitad: " + e.message); }
        return;
    }

    if (low === "тест") {
        const ok = await postToChannel(["👀 Сосед нашёл!", "", "🏷️ Набор из 10 бесшовных заколок для волос", "💰 Было 309 ₽ → стало 99 ₽ (−68%)", "", "👉 Забрать со скидкой:", "https://aliexpress.ru/one-price"].join("\n"));
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

console.log("🚀 «Сосед нашёл!» v7.5 (scope по документации) запущен");
bot.start();
