// ============================================================
// 🛒 "СОСЕД НАШЁЛ!" — Москва и МО
// v3: красивый парсер — название, цены, скидка, "купили",
//     короткая реф-ссылка без мусора
// ============================================================
import { Bot } from "@maxhub/max-bot-api";

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

// ── ВСПОМОГАТЕЛЬНЫЕ ──────────────────────────────────────
function grab(html, re) { const m = html.match(re); return m ? m[1] : ""; }
function decode(s) {
    return String(s || "")
        .replace(/&quot;/g, '"').replace(/&amp;/g, "&")
        .replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/\\u[\dA-Fa-f]{4}/g, "");
}
function metaContent(html, prop) {
    const tag = html.match(new RegExp('<meta[^>]*property=["\']' + prop + '["\'][^>]*>', "i"))
        || html.match(new RegExp('<meta[^>]*name=["\']' + prop + '["\'][^>]*>', "i"));
    if (!tag) return "";
    const c = tag[0].match(/content=["']([^"']*)["']/);
    return c ? decode(c[1]) : "";
}
function fmtPrice(n) {
    return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

// ── ПАРСЕР ТОВАРА (v3 — по реальной странице) ────────────
async function fetchProduct(url) {
    const res = await fetch(url, {
        headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
            "Accept-Language": "ru-RU,ru;q=0.9"
        }
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const html = await res.text();
    const p = { title: "", image: "", price: "", oldPrice: "", discount: "", sold: "", rating: "" };

    // НАЗВАНИЕ: H1 → og:title → <title>
    const h1 = grab(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i);
    if (h1) p.title = decode(h1.replace(/<[^>]+>/g, "").trim());
    if (!p.title) p.title = metaContent(html, "og:title");
    if (!p.title) {
        const t = grab(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
        p.title = decode(t).split(/—|–|\|/)[0].replace(/купить.*/i, "").trim();
    }

    // ФОТО
    p.image = metaContent(html, "og:image");

    // ЦЕНЫ из JSON-блоков (надёжнее всего)
    p.price = grab(html, /"salePrice"\s*:\s*"?([\d.,]+)"?/)
        || grab(html, /"activityPrice"\s*:\s*"?([\d.,]+)"?/)
        || grab(html, /"displayPrice"\s*:\s*"?([\d.,]+)"?/);
    p.oldPrice = grab(html, /"originalPrice"\s*:\s*"?([\d.,]+)"?/);

    // Запасной вариант цен: первые две "N ₽" на странице
    if (!p.price) {
        const nums = [...html.matchAll(/([\d][\d\s\u00A0]{1,9})\s*₽/g)]
            .map(m => m[1].replace(/[\s\u00A0]/g, ""))
            .filter(v => /^\d{2,7}$/.test(v));
        if (nums[0]) p.price = nums[0];
        if (nums[1] && Number(nums[1]) > Number(nums[0])) p.oldPrice = nums[1];
    }

    // СКИДКА
    p.discount = grab(html, /[-−](\d{1,2})\s*%/) || "";

    // КУПИЛИ
    p.sold = grab(html, /([\d][\d\s\u00A0]*)\s*купили/).trim();

    // РЕЙТИНГ
    p.rating = grab(html, /"averageStar"\s*:\s*"([\d.]+)"/)
        || grab(html, /"evarageStar"\s*:\s*"([\d.]+)"/)
        || grab(html, /"averageRating"\s*:\s*"([\d.]+)"/);

    console.log(`🔎 v3: ${p.title} | ${p.price}→${p.oldPrice} | −${p.discount}% | купили:${p.sold} | фото:${p.image ? "есть" : "нет"}`);
    return p;
}

// ── КОРОТКАЯ РЕФ-ССЫЛКА (без мусора) ─────────────────────
function makeRefLink(productUrl) {
    const id = (productUrl.match(/item\/(\d+)/) || [])[1];
    if (id) return `https://aliexpress.ru/item/${id}.html?aff_short_key=${AFF_KEY}`;
    try {
        const u = new URL(productUrl);
        u.search = `?aff_short_key=${AFF_KEY}`;
        return u.toString();
    } catch (e) { return productUrl; }
}

// ── КАРТОЧКА v3 ──────────────────────────────────────────
function buildCard(p, ref) {
    const lines = ["👀 Сосед нашёл!", ""];
    lines.push("🏷️ " + (p.title || "Товар с AliExpress"));
    const extra = [];
    if (p.rating) extra.push("⭐ " + p.rating.replace(".", ","));
    if (p.sold) extra.push("🛒 купили: " + p.sold);
    if (extra.length) lines.push(extra.join(" | "));
    if (p.price) {
        let line = "💰 " + (p.oldPrice ? `Было ${fmtPrice(p.oldPrice)} ₽ → стало ` : "") + fmtPrice(p.price) + " ₽";
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

    // РЕЖИМ 1: ссылка на товар → красивая карточка
    const link = text.match(/https?:\/\/[^\s]+/);
    if (link && /aliexpress\.ru/i.test(link[0])) {
        await bot.api.sendMessageToUser(uid, "⏳ Принял ссылку, делаю красивую карточку…");
        try {
            const p = await fetchProduct(link[0]);
            const ref = makeRefLink(link[0]);
            const ok = await postToChannel(buildCard(p, ref));
            await saveProduct({
                source: "aliexpress",
                external_id: (link[0].match(/item\/(\d+)/) || [])[1] || link[0],
                title: p.title || link[0],
                price_new: parseInt(String(p.price).replace(/\D/g, "")) || null,
                price_old: parseInt(String(p.oldPrice).replace(/\D/g, "")) || null,
                discount_percent: parseInt(p.discount) || null,
                image_url: p.image || null,
                original_url: link[0], ref_url: ref,
                category: "manual", status: "posted",
                posted_at: new Date().toISOString()
            });
            await bot.api.sendMessageToUser(uid, ok ? "✅ Готово! Красивая карточка в канале." : "❌ В канал не выложил — проверь CHANNEL_ID.");
        } catch (e) {
            await bot.api.sendMessageToUser(uid, "⚠️ Не смог прочитать товар: " + e.message);
        }
        return;
    }

    // РЕЖИМ 2: "тест"
    if (text.trim().toLowerCase() === "тест") {
        const ok = await postToChannel([
            "👀 Сосед нашёл!", "",
            "🏷️ Набор из 10 бесшовных заколок для волос",
            "🛒 купили: 50 451",
            "💰 Было 309 ₽ → стало 99 ₽ (−68%)", "",
            "👉 Забрать со скидкой:",
            "https://aliexpress.ru/one-price?acnt=103863733&aff_short_key=" + AFF_KEY
        ].join("\n"));
        await bot.api.sendMessageToUser(uid, ok ? "✅ Тестовый пост в канале!" : "❌ Не вышло. Проверь CHANNEL_ID.");
    }
});

// ── ВЕБ-СЕРВЕР ───────────────────────────────────────────
const http = await import("node:http");
const port = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Сосед нашёл! работает ✅");
}).listen(port, () => console.log("🌐 Веб-сервер на порту " + port));

// ── АВТОПЕРЕЗАПУСК ───────────────────────────────────────
process.on("unhandledRejection", (err) => {
    const msg = String(err?.message ?? err) + " " + String(err?.cause?.message ?? "");
    console.error("⚠️ Ошибка: " + msg);
    if (/ETIMEDOUT|ECONNRESET|ECONNREFUSED|EPIPE|fetch failed|socket|not valid JSON|Unexpected token/i.test(msg)) {
        console.log("🔄 Перезапускаюсь…");
        process.exit(1);
    }
});

console.log("🚀 «Сосед нашёл!» v3 (красивый парсер) запускается…");
bot.start();
