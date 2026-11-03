const CHANNELS = {
  community: "@originaltokencommunity",   // ← change to your real channels
  payouts: "@originalpayouts",            // ← change to your real channels
  gramapps: "@gramminiappsmining",
  grammoney: "@Grammoneywallet"
};

const ADMIN_ID = "761418905";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/referral") return handleReferral(request, env);
    if (url.pathname === "/withdraw") return handleWithdraw(request, env);
    if (url.pathname === "/check-join") return handleJoin(request, env);
    if (url.pathname === "/admin-mark-paid") return handleMarkPaid(request, env);
    if (url.pathname === "/admin") return handleAdmin(request, env);
    return env.ASSETS.fetch(request);
  }
};

async function read(env, key) {
  const raw = await env.REFERRALS.get(key);
  return raw ? JSON.parse(raw) : null;
}
async function write(env, key, value) {
  await env.REFERRALS.put(key, JSON.stringify(value));
}
function userFrom(initData) {
  try { return JSON.parse(new URLSearchParams(initData || "").get("user") || "{}"); }
  catch (e) { return {}; }
}

async function sendTelegram(env, chatId, text) {
  if (!env.BOT_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" })
    });
  } catch (e) {}
}

async function handleJoin(request, env) {
  const body = await request.json();
  const user = userFrom(body.initData);
  const chat = CHANNELS[body.task];
  if (!user.id || !chat) return Response.json({ ok: false, error: "Bad task" });
  if (!env.BOT_TOKEN) return Response.json({ ok: false, error: "Bot token missing" });
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/getChatMember?chat_id=${encodeURIComponent(chat)}&user_id=${user.id}`);
  const data = await res.json();
  const status = data.result && data.result.status;
  const ok = status === "member" || status === "administrator" || status === "creator";
  return Response.json({ ok, status: status || data.description || "left" });
}

async function handleReferral(request, env) {
  if (request.method === "GET") {
    const id = new URL(request.url).searchParams.get("id");
    const row = id ? await read(env, "ref:" + id) : null;
    return Response.json({ friends: (row && row.friends) || [] });
  }
  const body = await request.json();
  const user = userFrom(body.initData);
  const id = String(user.id || "");
  if (!id) return Response.json({ ok: false, error: "No Telegram user" }, { status: 401 });

  if (body.action === "join" && body.inviter && body.inviter !== id) {
    const owner = (await read(env, "ref:" + body.inviter)) || { friends: [] };
    if (!owner.friends.some((f) => f.id === id)) {
      owner.friends.unshift({ id, name: user.first_name || "Miner", qualified: false, paid: false });
      await write(env, "ref:" + body.inviter, owner);
    }
    await write(env, "link:" + id, body.inviter);
    return Response.json({ ok: true, friends: owner.friends });
  }

  if (body.action === "qualify") {
    const link = await read(env, "link:" + id);
    if (!link) return Response.json({ ok: true });
    const owner = (await read(env, "ref:" + link)) || { friends: [] };
    const friend = owner.friends.find((f) => f.id === id);
    if (friend && !friend.qualified) {
      friend.qualified = true;
      await write(env, "ref:" + link, owner);
    }
    return Response.json({ ok: true });
  }

  if (body.action === "claim") {
    const owner = (await read(env, "ref:" + id)) || { friends: [] };
    const unpaid = owner.friends.filter((f) => f.qualified && !f.paid);
    unpaid.forEach((f) => { f.paid = true; });
    if (unpaid.length) await write(env, "ref:" + id, owner);
    return Response.json({ ok: true, paid: unpaid.length, friends: owner.friends });
  }
  return Response.json({ ok: false }, { status: 400 });
}

async function handleWithdraw(request, env) {
  if (request.method === "GET") {
    const id = new URL(request.url).searchParams.get("id");
    const row = id ? await read(env, "wd:" + id) : null;
    return Response.json({ items: (row && row.items) || [] });
  }
  const body = await request.json();
  const user = userFrom(body.initData);
  const id = String(user.id || "");
  const amount = Number(body.amount || 0);
  if (!id || amount < 10000) return Response.json({ ok: false, error: "Invalid request" }, { status: 400 });

  const row = (await read(env, "wd:" + id)) || { items: [] };
  const net = amount - 1000;
  row.items.unshift({ net, status: "pending", wallet: body.wallet || "", requestedAt: Date.now() });
  await write(env, "wd:" + id, row);

  const msg = `💰 <b>New Withdrawal Request</b>\n\nUser: ${user.first_name || "Miner"} (ID: ${id})\nAmount: ${amount} O\nNet: ${net} O\nWallet: <code>${body.wallet || "none"}</code>`;
  await sendTelegram(env, ADMIN_ID, msg);
  await sendTelegram(env, id, "Your Original(O) withdrawal request has been received.");

  return Response.json({ ok: true, items: row.items });
}

async function handleMarkPaid(request, env) {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  try {
    const body = await request.json();
    const userId = String(body.userId || "");
    const index = Number(body.index || 0);
    if (!userId) return Response.json({ ok: false, error: "Missing userId" });

    const row = await read(env, "wd:" + userId);
    if (!row || !row.items || !row.items[index]) return Response.json({ ok: false, error: "Not found" });

    row.items[index].status = "paid";
    await write(env, "wd:" + userId, row);
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  }
}

async function handleAdmin(request, env) {
  const url = new URL(request.url);
  const key = url.searchParams.get("key");
  if (key !== "761418905") return new Response("Unauthorized", { status: 401 });

  const page = Math.max(0, parseInt(url.searchParams.get("page") || "0", 10));
  const PER_PAGE = 50;

  let pending = [];
  try {
    const list = await env.REFERRALS.list({ prefix: "wd:", limit: 1000 });
    let count = 0;
    const start = page * PER_PAGE;

    for (const k of list.keys) {
      if (count >= start + PER_PAGE) break;
      const row = await read(env, k.name);
      if (!row || !row.items) continue;

      for (let index = 0; index < row.items.length; index++) {
        const item = row.items[index];
        if (item.status !== "pending") continue;
        if (count >= start && count < start + PER_PAGE) {
          pending.push({
            userId: k.name.replace("wd:", ""),
            index,
            net: item.net,
            wallet: item.wallet || ""
          });
        }
        count++;
        if (count >= start + PER_PAGE) break;
      }
    }
  } catch (e) {
    return new Response("Error loading data: " + e, { status: 500 });
  }

  const prev = page > 0 ? `<a href="?key=761418905&page=${page - 1}" style="color:#2fce4a;margin-right:16px">← Previous</a>` : "";
  const next = pending.length === PER_PAGE ? `<a href="?key=761418905&page=${page + 1}" style="color:#2fce4a">Next →</a>` : "";

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Original(O) Admin</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: system-ui; background:#0a0f0c; color:#eee; padding:16px; }
    .card { background:#151c18; border:1px solid #2a4a32; border-radius:12px; padding:14px; margin-bottom:12px; }
    button { background:#2fce4a; color:#06210c; border:0; padding:10px 16px; border-radius:8px; font-weight:700; }
    .pager { margin: 20px 0; font-size: 18px; }
  </style>
</head>
<body>
  <h1>Pending Withdrawals (Original O)</h1>
  <div class="pager">${prev}${next}</div>
  ${pending.length ? pending.map(p => `
    <div class="card">
      User ID: <b>${p.userId}</b><br>
      Net: ${p.net} O<br>
      Wallet: <code>${p.wallet}</code><br>
      <button onclick="mark('${p.userId}', ${p.index})">Mark as Paid</button>
    </div>
  `).join("") : "<p>No pending withdrawals on this page</p>"}
  <div class="pager">${prev}${next}</div>
  <script>
    async function mark(userId, index) {
      const res = await fetch("/admin-mark-paid", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, index })
      });
      const data = await res.json();
      if (data.ok) location.reload();
      else alert(data.error || "Failed");
    }
  </script>
</body>
</html>`;

  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}
