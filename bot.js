// ============================================================
// 🛒 "СОСЕД НАШЁЛ!" — Москва и МО
// v1: регистратор ID чата + тестовый пост + облачная память
// ============================================================
import { Bot } from "@maxhub/max-bot-api";

// ── НАСТРОЙКИ (из переменных Render) ─────────────────────
const TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID ? Number(process.env.CHANNEL_ID) : null;
const REF_LINK = process.env.REF_LINK || "https://aliexpress.ru/one-price?acnt=103863733&src=yandex&aff_short_key=_9zpFKc&aff_platform=true";
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

async function isPosted(extId) {
    try {
        const r = await sb("products?external_id=eq." + encodeURIComponent(extId) + "&select=id");
        return Array.isArray(r) && r.length > 0;
    } catch (e) { console.log("⚠️ Чтение БД: " + e.message); return false; }
}

async function saveProduct(p) {
    try { await sb("products", { method: "POST", body: p }); }
    catch (e) { console.log("⚠️ Запись БД: " + e.message); }
}

async function logPost(productId) {
    try { await sb("post_log", { method: "POST", body: { product_id: productId, channel: "moscow_mo" } }); }
    catch (e) { console.log("⚠️ Лог БД: " + e.message); }
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

// ── КАРТОЧКА ТОВАРА ──────────────────────────────────────
function buildCard(t) {
    return [
        "👀 Сосед нашёл!",
        "",
        `🏷️ ${t.title}`,
        `💰 Было ${t.old} ₽ → стало ${t.now} ₽ (−${t.disc}%)`,
        `🔥 Купили: ${t.sold} человек`,
        "",
        "👉 Забрать со скидкой:",
        REF_LINK
    ].join("\n");
}

// ── РЕГИСТРАТОР: пишет в логи ID всех чатов ──────────────
function chatInfo(ctx) {
    const c = ctx.chat || ctx.message?.chat || ctx.message?.recipient || {};
    return { id: c.chat_id ?? c.id ?? null, type: c.chat_type ?? c.type ?? "?" };
}

bot.hears(/.*/, async (ctx) => {
    const info = chatInfo(ctx);
    const uid = ctx.message?.sender?.user_id ?? ctx.from?.user_id ?? null;
    const text = ctx.message?.text ?? ctx.text ?? "";
    console.log(`💬 Чат: ${info.id} (${info.type}) | Юзер: ${uid} | Текст: ${text}`);

    // ТЕСТ: напиши боту в личку слово "тест" — он выложит пробную карточку
    if (uid && !String(info.type).includes("channel") && String(text).trim().toLowerCase() === "тест") {
        const ok = await postToChannel(buildCard({
            title: "Набор из 10 бесшовных заколок для волос",
            old: 309, now: 99, disc: 68, sold: "50 451"
        }));
        await bot.api.sendMessageToUser(uid, ok
            ? "✅ Тестовый пост опубликован в канале!"
            : "❌ Не вышло. Проверь CHANNEL_ID в Render.");
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

console.log("🚀 «Сосед нашёл!» (Москва и МО) запускается…");
bot.start();
