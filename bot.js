// ============================================================
// 🛒 "СОСЕД НАШЁЛ!" — Москва и МО
// v5: гибрид — автопарсинг ИЛИ карточка по строке "назв | цена | старая"
// ============================================================
import { Bot } from "@maxhub/max-bot-api";

const TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID ? Number(process.env.CHANNEL_ID) : null;
const AFF_KEY = process.env.AFF_KEY || "_9zpFKc";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_KEY || "";

const bot = new Bot(TOKEN);
const pending = new Map(); // юзер -> ссылка, ждущая строку данных

// ── ОБЛАЧНАЯ ПАМЯТЬ ──────────────────────────────────────
async function sb(path, opts = {}) {
    const res = await fetch(SUPABASE_URL + "/rest/v1/" + path, {
        method: opts.method || "GET",
        headers: {
            apikey: SUPABASE_KEY,
            Authorization: "Bearer " + SUPABASE_KEY,
            "Content-Type": "application/json",
            Prefer: opts.prefer || "return=representation"
        },
        body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    if (!res.ok) throw new Error("Supabase " + res.status);
    return res.json();
}

async function saveProduct(p) {
    try {
        await sb("products?on_conflict=source,external_id", {
            method: "POST", body: p,
            prefer: "return=representation,resolution=merge-duplicates"
        });
    } catch (e) { console.log("⚠️ Запись БД: " + e.message); }
}

function getText(ctx) {
    if (ctx.text && typeof ctx.text === "string") return ctx.text;
    if (ctx.message?.text && typeof ctx.message.text === "string") return ctx.message.text;
    if (ctx.message?.body?.text && typeof ctx.message.body.text === "string") return ctx.message.body.text;
    if (ctx.body?.text && typeof ctx.body.text === "string") return ctx.body.text;
    return "";
}

function grab(html, re) { const m = html.match(re); return m ? m[1] : ""; }
function decode(s) {
    return String(s || "").replace(/&quot;/g, '"').replace(/&amp;/g, "&")
        .replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}
function metaContent(html, prop) {
    const tag = html.match(new RegExp('<meta[^>]*property=["\']' + prop + '["\'][^>]*>', "i"));
    if (!tag) return "";
    const c = tag[0].match(/content=["']([^"']*)["']/);
    return c ? decode(c[1]) : "";
}
function fmtPrice(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, " "); }

// ── АВТОПАРСЕР (пробуем мобильную версию) ────────────────
async function fetchProduct(url) {
    const id = (url.match(/item\/(\d+)/) || [])[1];
    const target = id ? `https://m.aliexpress.ru/item/${id}.html` : url;
    const res = await fetch(target, {
        headers: {
            "User-Agent": "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36",
            "Accept-Language": "ru-RU,ru;q=0.9"
        }
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const html = await res.text();
    const p = { title: "", price: "", oldPrice: "", discount: "", sold: "", rating: "", image: "" };
    const h1 = grab(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i);
    if (h1) p.title = decode(h1.replace(/<[^>]+>/g, "").trim());
    if (!p.title) p.title = metaContent(html, "og:title");
    p.price = grab(html, /"salePrice"\s*:\s*"?([\d.,]+)"?/);
    p.oldPrice = grab(html, /"originalPrice"\s*:\s*"?([\d.,]+)"?/);
    if (!p.price) {
        const nums = [...html.matchAll(/([\d][\d\s\u00A0]{1,9})\s*₽/g)]
            .map(m => m[1].replace(/[\s\u00A0]/g, "")).filter(v => /^\d{2,7}$/.test(v));
        if (nums[0]) p.price = nums[0];
        if (nums[1] && Number(nums[1]) > Number(nums[0])) p.oldPrice = nums[1];
    }
    p.discount = grab(html, /[-−](\d{1,2})\s*%/) || "";
    p.sold = grab(html, /([\d][\d\s\u00A0]*)\s*купили/).trim();
    p.image = metaContent(html, "og:image");
    return p;
}

function makeRefLink(productUrl) {
    const id = (productUrl.match(/item\/(\d+)/) || [])[1];
    if (id) return `https://aliexpress.ru/item/${id}.html?aff_short_key=${AFF_KEY}`;
    return productUrl;
}

function buildCard(p, ref) {
    const lines = ["👀 Сосед нашёл!", ""];
    lines.push("🏷️ " + p.title);
    const extra = [];
    if (p.rating) extra.push("⭐ " + String(p.rating).replace(".", ","));
    if (p.sold) extra.push("🛒 купили: " + p.sold);
    if (extra.length) lines.push(extra.join(" | "));
    let line = "💰 ";
    if (p.oldPrice && Number(p.oldPrice) > Number(p.price)) {
        line += `Было ${fmtPrice(p.oldPrice)} ₽ → стало `;
        if (!p.discount) p.discount = String(Math.round((1 - Number(p.price) / Number(p.oldPrice)) * 100));
    }
    line += fmtPrice(p.price) + " ₽";
    if (p.discount) line += ` (−${p.discount}%)`;
    lines.push(line, "", "👉 Забрать со скидкой:", ref);
    return lines.join("\n");
}

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

async function publish(p, link, uid) {
    const ref = makeRefLink(link);
    const ok = await postToChannel(buildCard(p, ref));
    await saveProduct({
        source: "aliexpress",
        external_id: (link.match(/item\/(\d+)/) || [])[1] || link,
        title: p.title,
        price_new: parseInt(String(p.price).replace(/\D/g, "")) || null,
        price_old: parseInt(String(p.oldPrice).replace(/\D/g, "")) || null,
        discount_percent: parseInt(p.discount) || null,
        image_url: p.image || null,
        original_url: link, ref_url: ref,
        category: "manual", status: "posted",
        posted_at: new Date().toISOString()
    });
    await bot.api.sendMessageToUser(uid, ok ? "✅ Готово! Красивая карточка в канале." : "❌ В канал не выложил — проверь CHANNEL_ID.");
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

    // РЕЖИМ 1: ждём строку данных после закрытой страницы
    if (pending.has(uid) && !/https?:\/\//.test(text)) {
        if (text.trim().toLowerCase() === "отмена") { pending.delete(uid); await bot.api.sendMessageToUser(uid, " Отменил."); return; }
        const parts = text.split("|").map(s => s.trim());
        if (parts.length >= 2 && parts[0] && /^\d+$/.test(parts[1].replace(/\s/g, ""))) {
            const link = pending.get(uid);
            pending.delete(uid);
            await publish({
                title: parts[0],
                price: parts[1].replace(/\s/g, ""),
                oldPrice: (parts[2] || "").replace(/\s/g, ""),
                discount: "", sold: (parts[3] || ""), rating: "", image: ""
            }, link, uid);
        } else {
            await bot.api.sendMessageToUser(uid, "🤔 Не понял формат. Нужно: название | цена | старая цена\n(слово «отмена» — отменить)");
        }
        return;
    }

    // РЕЖИМ 2: ссылка на товар
    const link = text.match(/https?:\/\/[^\s]+/);
    if (link && /aliexpress\.ru/i.test(link[0])) {
        await bot.api.sendMessageToUser(uid, "⏳ Принял ссылку, пробую считать товар…");
        try {
            const p = await fetchProduct(link[0]);
            if (p.title && p.price) {
                await publish(p, link[0], uid);
            } else {
                pending.set(uid, link[0]);
                await bot.api.sendMessageToUser(uid,
                    "🔒 Али закрыл страницу от сервера. Делаем карточку вручную — пришли ОДНУ строку:\n\n" +
                    "название | цена | старая цена | купили\n\n" +
                    "Пример: ELEGOO ASA нить для 3D-печати 1 кг | 1209 | 2283 | 2896\n\n" +
                    "(«отмена» — отменить)");
            }
        } catch (e) {
            pending.set(uid, link[0]);
            await bot.api.sendMessageToUser(uid, "⚠️ Страница не открылась (" + e.message + "). Пришли строку: название | цена | старая цена");
        }
        return;
    }

    // РЕЖИМ 3: "тест"
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

process.on("unhandledRejection", (err) => {
    const msg = String(err?.message ?? err) + " " + String(err?.cause?.message ?? "");
    console.error("⚠️ Ошибка: " + msg);
    if (/ETIMEDOUT|ECONNRESET|ECONNREFUSED|EPIPE|fetch failed|socket|not valid JSON|Unexpected token/i.test(msg)) {
        console.log("🔄 Перезапускаюсь…");
        process.exit(1);
    }
});

console.log("🚀 «Сосед нашёл!» v5 (гибрид) запускается…");
bot.start();
