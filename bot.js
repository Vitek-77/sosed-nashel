// ============================================================
// 🛒 "СОСЕД НАШЁЛ!" — Москва и МО
// v2: умный помощник — кинь ссылку на товар в личку,
//     бот сам сделает карточку и выложит в канал
// ============================================================
import { Bot } from "@maxhub/max-bot-api";

// ── НАСТРОЙКИ (из переменных Render) ─────────────────────
const TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID ? Number(process.env.CHANNEL_ID) : null;
const AFF_KEY = process.env.AFF_KEY || "_9zpFKc";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_KEY || "";

const bot = new Bot(TOKEN);

// ── ОБЛАЧНАЯ ПАМЯТЬ (Supabase) ───────────────────────────
async function sb(path, opts = {}) {
    const res = await fetch(SUPABASE_URL + "/rest/v1/" + path, {
        method: opts.method || "GET",
        headers: {
            apikey: SUPABASE_KEY,
            Authorization: "Bearer " + SUPABASE_KEY,
            "Content-Type": "application/json",
            Prefer: "return=representation"
        },
        body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    if (!res.ok) throw new Error("Supabase " + res.status);
    return res.json();
}

async function saveProduct(p) {
    try { await sb("products", { method: "POST", body: p }); }
    catch (e) { console.log("⚠️ Запись БД: " + e.message); }
}

// ── ЧТЕНИЕ ТЕКСТА СООБЩЕНИЯ ──────────────────────────────
function getText(ctx) {
    if (ctx.text && typeof ctx.text === "string") return ctx.text;
    if (ctx.message?.text && typeof ctx.message.text === "string") return ctx.message.text;
    if (ctx.message?.body?.text && typeof ctx.message.body.text === "string") return ctx.message.body.text;
    if (ctx.body?.text && typeof ctx.body.text === "string") return ctx.body.text;
    return "";
}

// ── ИЗВЛЕЧЕНИЕ ДАННЫХ ТОВАРА СО СТРАНИЦЫ ─────────────────
function grab(html, re) { const m = html.match(re); return m ? m[1] : ""; }
function decode(s) {
    return String(s || "")
        .replace(/&quot;/g, '"').replace(/&amp;/g, "&")
        .replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

async function fetchProduct(url) {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" } });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const html = await res.text();
    const p = { title: "", image: "", price: "", oldPrice: "", discount: "" };

    // 1) Ищем JSON-LD (Product) — там чистые данные
    const ldBlocks = [...html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)];
    for (const m of ldBlocks) {
        try {
            const obj = JSON.parse(m[1]);
            const list = Array.isArray(obj) ? obj : (obj["@graph"] || [obj]);
            for (const o of list) {
                if (String(o["@type"] || "").includes("Product")) {
                    p.title = p.title || o.name || "";
                    p.image = p.image || (Array.isArray(o.image) ? o.image[0] : o.image) || "";
                    const off = o.offers || {};
                    p.price = p.price || off.price || off.lowPrice || "";
                }
            }
        } catch (e) {}
    }

    // 2) Запасной вариант — og-метатеги
    if (!p.title) p.title = decode(grab(html, /<meta[^>]+property="og:title"[^>]+content="([^"]*)"/));
    if (!p.image) p.image = grab(html, /<meta[^>]+property="og:image"[^>]+content="([^"]*)"/);
    if (!p.price) p.price = grab(html, /"displayPrice"\s*:\s*"([^"]+)"/) || grab(html, /"formattedPrice"\s*:\s*"([^"]+)"/);
    if (!p.oldPrice) p.oldPrice = grab(html, /"originalPrice"\s*:\s*"?([\d\s.,]+)"?/);
    if (!p.discount) p.discount = grab(html, /"discountPercentage"\s*:\s*"?(\d+)"?/) || grab(html, /−(\d+)\s*%/);

    p.title = decode(p.title);
    console.log(`🔎 Спарсил: ${p.title} | цена: ${p.price} | скидка: ${p.discount} | фото: ${p.image ? "есть" : "нет"}`);
    return p;
}

// ── РЕФ-ССЫЛКА ИЗ ССЫЛКИ НА ТОВАР ────────────────────────
function makeRefLink(productUrl) {
    try {
        const u = new URL(productUrl);
        u.searchParams.set("aff_short_key", AFF_KEY);
        return u.toString();
    } catch (e) { return productUrl; }
}

// ── КАРТОЧКА ТОВАРА ──────────────────────────────────────
function buildCard(p, ref) {
    const lines = ["👀 Сосед нашёл!", ""];
    lines.push("🏷️ " + (p.title || "Товар с AliExpress"));
    if (p.price) {
        let line = "💰 " + (p.oldPrice ? `Было ${p.oldPrice} ₽ → стало ` : "") + p.price + " ₽";
        if (p.discount) line += ` (−${p.discount}%)`;
        lines.push(line);
    }
    lines.push("", "👉 Забрать со скидкой:", ref);
    return lines.join("\n");
}

// ── ОТПРАВКА В КАНАЛ ─────────────────────────────────────
async function postToChannel(text) {
    if (!CHANNEL_ID) { console.log("⚠️ CHANNEL_ID не задан"); return false; }
    try {
        await bot.api.sendMessageToChat(CHANNEL_ID, text);
        console.log("📢 Пост опубликован в канале!");
        return true;
    } catch (e) {
        console.log("⚠️ Пост не вышел: " + (e?.message ?? e));
        return false;
    }
}

// ── РЕГИСТРАТОР ЧАТОВ ────────────────────────────────────
function chatInfo(ctx) {
    const c = ctx.chat || ctx.message?.chat || ctx.message?.recipient || {};
    return { id: c.chat_id ?? c.id ?? null, type: c.chat_type ?? c.type ?? "?" };
}

bot.hears(/.*/, async (ctx) => {
    const info = chatInfo(ctx);
    const uid = ctx.message?.sender?.user_id ?? ctx.from?.user_id ?? null;
    const text = getText(ctx);
    console.log(`💬 Чат: ${info.id} (${info.type}) | Юзер: ${uid} | Текст: ${text}`);

    const isChannel = String(info.type).includes("channel");
    if (!uid || isChannel) return;

    // РЕЖИМ 1: кидаешь ссылку на товар — бот делает карточку сам
    const link = text.match(/https?:\/\/[^\s]+/);
    if (link && /aliexpress\.ru/i.test(link[0])) {
        await bot.api.sendMessageToUser(uid, "⏳ Принял ссылку, делаю карточку…");
        try {
            const p = await fetchProduct(link[0]);
            const ref = makeRefLink(link[0]);
            const ok = await postToChannel(buildCard(p, ref));
            const extId = (link[0].match(/item\/(\d+)/) || [])[1] || link[0];
            await saveProduct({
                source: "aliexpress", external_id: extId,
                title: p.title || link[0],
                price_new: parseInt(String(p.price).replace(/\D/g, "")) || null,
                price_old: parseInt(String(p.oldPrice).replace(/\D/g, "")) || null,
                discount_percent: parseInt(p.discount) || null,
                image_url: p.image || null,
                original_url: link[0], ref_url: ref,
                category: "manual", status: "posted",
                posted_at: new Date().toISOString()
            });
            await bot.api.sendMessageToUser(uid, ok
                ? "✅ Готово! Карточка в канале (фото подтянется превью к ссылке)."
                : "❌ Карточка собрана, но в канал не выложил — проверь CHANNEL_ID.");
        } catch (e) {
            await bot.api.sendMessageToUser(uid, "⚠️ Не смог прочитать товар: " + e.message);
        }
        return;
    }

    // РЕЖИМ 2: слово "тест" — пробная карточка
    if (text.trim().toLowerCase() === "тест") {
        const ok = await postToChannel([
            "👀 Сосед нашёл!", "",
            "🏷️ Набор из 10 бесшовных заколок для волос",
            "💰 Было 309 ₽ → стало 99 ₽ (−68%)",
            "🔥 Купили: 50 451 человек", "",
            "👉 Забрать со скидкой:",
            "https://aliexpress.ru/one-price?acnt=103863733&aff_short_key=" + AFF_KEY
        ].join("\n"));
        await bot.api.sendMessageToUser(uid, ok ? "✅ Тестовый пост в канале!" : "❌ Не вышло. Проверь CHANNEL_ID.");
    }
});

// ── ВЕБ-СЕРВЕР (чтобы Render не усыплял) ─────────────────
const http = await import("node:http");
const port = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Сосед нашёл! работает ✅");
}).listen(port, () => console.log("🌐 Веб-сервер на порту " + port));

// ── АВТОПЕРЕЗАПУСК ПРИ СБОЯХ ─────────────────────────────
process.on("unhandledRejection", (err) => {
    const msg = String(err?.message ?? err) + " " + String(err?.cause?.message ?? "");
    console.error("⚠️ Ошибка: " + msg);
    if (/ETIMEDOUT|ECONNRESET|ECONNREFUSED|EPIPE|fetch failed|socket|not valid JSON|Unexpected token/i.test(msg)) {
        console.log("🔄 Перезапускаюсь…");
        process.exit(1);
    }
});

console.log("🚀 «Сосед нашёл!» v2 (умный помощник) запускается…");
bot.start();
