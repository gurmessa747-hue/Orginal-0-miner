const CHANNELS = {
  community: "@Originaltokencommunity",
  payout: "@Originaltokenpayout",
  labs: "@orginallabs",
  marka: "@markacryptonews",
  grampulse: "@grampulsechannel"
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
  const userId = String(user.id || "");
  const task = body.task;
  const channel = CHANNELS[task];
  if (!userId || !channel) return Response.json({ ok: false, error: "Invalid" });

  try {
    const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/getChatMember?chat_id=${encodeURIComponent(channel)}&user_id=${userId}`);
    const data = await res.json();
    const status = data.result && data.result.status;
    const joined = status && status !== "left" && status !== "kicked";
    return Response.json({ ok: joined });
  } catch (e) {
    return Response.json({ ok: false, error: "Check failed" });
  }
}

async function handleReferral(request, env) {
  const url = new URL(request.url);
  if (request.method === "GET") {
    const id = url.searchParams.get("id");
    if (!id) return Response.json({ friends: [] });
    const data = await read(env, "user:" + id) || { friends: [] };
    return Response.json({ friends: data.friends || [] });
  }

  const body = await request.json();
  const user = userFrom(body.initData);
  const userId = String(user.id || "");
  if (!userId) return Response.json({ ok: false });

  if (body.action === "join") {
    const inviter = String(body.inviter || "");
    if (!inviter || inviter === userId) return Response.json({ ok: true });
    const inv = await read(env, "user:" + inviter) || { friends: [] };
    if (!inv.friends.find(f => f.id === userId)) {
      inv.friends.push({ id: userId, name: user.first_name || "Miner", qualified: false, paid: false });
      await write(env, "user:" + inviter, inv);
    }
    return Response.json({ ok: true });
  }

  if (body.action === "qualify") {
    const data = await read(env, "user:" + userId) || { friends: [] };
    // Mark this user as qualified in inviter's list if needed
    return Response.json({ ok: true });
  }

  if (body.action === "claim") {
    const data = await read(env, "user:" + userId) || { friends: [] };
    let paid = 0;
    data.friends = (data.friends || []).map(f => {
      if (f.qualified && !f.paid) { f.paid = true; paid++; }
      return f;
    });
    await write(env, "user:" + userId, data);
    return Response.json({ ok: true, paid, friends: data.friends });
  }

  return Response.json({ ok: false });
}

async function handleWithdraw(request, env) {
  const url = new URL(request.url);
  if (request.method === "GET") {
    const id = url.searchParams.get("id");
    if (!id) return Response.json({ items: [] });
    const data = await read(env, "withdraw:" + id) || { items: [] };
    return Response.json({ items: data.items || [] });
  }

  const body = await request.json();
  const user = userFrom(body.initData);
  const userId = String(user.id || "");
  const amount = Number(body.amount);
  const wallet = body.wallet || "";
  if (!userId || !amount || amount < 10000 || !wallet) return Response.json({ ok: false, error: "Invalid request" });

  const key = "withdraw:" + userId;
  const data = await read(env, key) || { items: [] };
  const net = amount - 1000;
  data.items.unshift({ net, wallet, status: "pending", ts: Date.now() });
  await write(env, key, data);

  await sendTelegram(env, ADMIN_ID, `New withdrawal request\nUser: ${userId}\nNet: ${net} O\nWallet: ${wallet}`);
  return Response.json({ ok: true, items: data.items });
}

async function handleMarkPaid(request, env) {
  const body = await request.json();
  const { userId, index } = body;
  if (!userId) return Response.json({ ok: false });
  const key = "withdraw:" + userId;
  const data = await read(env, key) || { items: [] };
  if (data.items[index]) data.items[index].status = "paid";
  await write(env, key, data);
  return Response.json({ ok: true });
}

async function handleAdmin(request, env) {
  const url = new URL(request.url);
  const page = Math.max(0, Number(url.searchParams.get("page") || 0));
  const limit = 20;
  const all = [];
  // Simple listing (in production you may want better indexing)
  const list = await env.REFERRALS.list({ prefix: "withdraw:" });
  for (const key of list.keys) {
    const data = await read(env, key.name);
    if (data && data.items) {
      data.items.forEach((item, i) => {
        if (item.status === "pending") all.push({ userId: key.name.replace("withdraw:", ""), index: i, ...item });
      });
    }
  }
  const pending = all.slice(page * limit, (page + 1) * limit);
  const prev = page > 0 ? `<a href="?page=${page-1}">Prev</a>` : "";
  const next = all.length > (page + 1) * limit ? `<a href="?page=${page+1}">Next</a>` : "";

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Original Admin</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: system-ui; background:#0a0f0c; color:#eee; padding:16px; }
    .card { background:#151c18; border:1px solid #2a4a32; border-radius:12px; padding:14px; margin-bottom:12px; }
    button { background:#2fce4a; color:#06210c; border:0; padding:10px 16px; border-radius:8px; font-weight:700; }
    .pager { margin: 20px 0; font-size: 18px; }
  </style>
</head>
<body>
  <h1>Pending Withdrawals</h1>
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
