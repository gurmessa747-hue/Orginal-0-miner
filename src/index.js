const CHANNELS = {
  community: "@Originaltokencommunity",
  payout: "@Originaltokenpayout",
  labs: "@orginallabs",
  marka: "@markacryptonews",
  grampulse: "@grampulsechannel"
};

const ADMIN_ID = "761418905";
const CYCLE = 6 * 60 * 60 * 1000;
const TOP = 20000000;
const RATIO = Math.pow(TOP / 40, 1 / 119);
const MAX = 120;
const FEE = 1000;
const MINW = 10000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/referral") return handleReferral(request, env);
    if (url.pathname === "/withdraw") return handleWithdraw(request, env);
    if (url.pathname === "/check-join") return handleJoin(request, env);
    if (url.pathname === "/admin-mark-paid") return handleMarkPaid(request, env);
    if (url.pathname === "/admin") return handleAdmin(request, env);
    if (url.pathname === "/state") return handleState(request, env);
    if (url.pathname === "/claim") return handleClaim(request, env);
    if (url.pathname === "/boost") return handleBoost(request, env);
    if (url.pathname === "/ad-reward") return handleAdReward(request, env);
    if (url.pathname === "/migrate") return handleMigrate(request, env);
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

function rateOf(n) {
  n = Math.max(1, Math.min(120, Math.floor(n)));
  if (n === 1) return 0.75;
  if (n === 20) return 1.04;
  if (n === 40) return 1.35;
  if (n === 60) return 1.75;
  if (n === 80) return 10;
  if (n === 100) return 20;
  if (n === 120) return 30;
  if (n <= 20) return Math.round((0.75 + (n - 1) * (1.04 - 0.75) / 19) * 100) / 100;
  if (n <= 40) return Math.round((1.04 + (n - 20) * (1.35 - 1.04) / 20) * 100) / 100;
  if (n <= 60) return Math.round((1.35 + (n - 40) * (1.75 - 1.35) / 20) * 100) / 100;
  if (n <= 80) return Math.round((1.75 + (n - 60) * (10 - 1.75) / 20) * 100) / 100;
  if (n <= 100) return Math.round((10 + (n - 80) * (20 - 10) / 20) * 100) / 100;
  return Math.round((20 + (n - 100) * (30 - 20) / 20) * 100) / 100;
}
function costOf(n) { if (n <= 1) return 0; if (n >= 120) return TOP; return Math.round(40 * Math.pow(RATIO, n - 1)); }
function levelFromBalance(amount) {
  let best = 1;
  for (let n = 2; n <= MAX; n++) {
    if (costOf(n) <= amount) best = n;
    else break;
  }
  return best;
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

function defaultUser() {
  return {
    friends: [],
    inviter: null,
    claimed: 0,
    bonus: 0,
    startedAt: Date.now(),
    boostEnd: 0,
    adTaskCount: 0,
    adTaskReset: 0,
    doneTasks: []
  };
}

async function handleMigrate(request, env) {
  const body = await request.json();
  const user = userFrom(body.initData);
  const userId = String(user.id || "");
  if (!userId) return Response.json({ ok: false });

  const key = "user:" + userId;
  const existing = await read(env, key);

  if (existing && (existing.claimed || 0) + (existing.bonus || 0) > 1) {
    return Response.json({ ok: true, migrated: false, reason: "already has balance" });
  }

  const claimed = Math.max(0, Number(body.claimed) || 0);
  const bonus = Math.max(0, Number(body.bonus) || 0);
  const startedAt = Number(body.startedAt) || Date.now();
  const boostEnd = Number(body.boostEnd) || 0;
  const adTaskCount = Math.min(10, Math.max(0, Number(body.adTaskCount) || 0));
  const adTaskReset = Number(body.adTaskReset) || 0;
  const doneTasks = Array.isArray(body.doneTasks) ? body.doneTasks : [];

  if (claimed + bonus > 50000000) {
    return Response.json({ ok: false, error: "Amount too high" });
  }

  const data = existing || defaultUser();
  data.claimed = claimed;
  data.bonus = bonus;
  data.startedAt = startedAt;
  data.boostEnd = boostEnd;
  data.adTaskCount = adTaskCount;
  data.adTaskReset = adTaskReset;
  data.doneTasks = doneTasks;

  await write(env, key, data);
  return Response.json({ ok: true, migrated: true, claimed, bonus });
}

async function handleState(request, env) {
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (!id) return Response.json({ ok: false });
  const data = await read(env, "user:" + id) || defaultUser();
  const level = levelFromBalance(data.claimed + data.bonus);
  return Response.json({ ok: true, ...data, level });
}

async function handleClaim(request, env) {
  const body = await request.json();
  const user = userFrom(body.initData);
  const userId = String(user.id || "");
  if (!userId) return Response.json({ ok: false });

  const key = "user:" + userId;
  const data = await read(env, key) || defaultUser();
  const now = Date.now();
  const elapsed = Math.min(Math.max(0, now - data.startedAt), CYCLE);
  const level = levelFromBalance(data.claimed + data.bonus);
  const rate = rateOf(level) + (now < data.boostEnd ? 1 : 0);
  const mined = rate * (elapsed / 3600000) * 8;

  data.claimed += mined;
  data.startedAt = now;
  await write(env, key, data);

  return Response.json({ ok: true, claimed: data.claimed, bonus: data.bonus, startedAt: data.startedAt, mined });
}

async function handleBoost(request, env) {
  const body = await request.json();
  const user = userFrom(body.initData);
  const userId = String(user.id || "");
  if (!userId) return Response.json({ ok: false });

  const key = "user:" + userId;
  const data = await read(env, key) || defaultUser();
  if (Date.now() < data.boostEnd) return Response.json({ ok: false, error: "Already boosted" });

  data.boostEnd = Date.now() + 2 * 3600000;
  await write(env, key, data);
  return Response.json({ ok: true, boostEnd: data.boostEnd });
}

async function handleAdReward(request, env) {
  const body = await request.json();
  const user = userFrom(body.initData);
  const userId = String(user.id || "");
  if (!userId) return Response.json({ ok: false });

  const key = "user:" + userId;
  const data = await read(env, key) || defaultUser();
  const now = Date.now();
  if (now > data.adTaskReset) {
    data.adTaskCount = 0;
    data.adTaskReset = now + 22 * 3600000;
  }
  if (data.adTaskCount >= 10) return Response.json({ ok: false, error: "Daily limit" });

  data.adTaskCount++;
  data.bonus += 20;
  await write(env, key, data);
  return Response.json({ ok: true, bonus: data.bonus, adTaskCount: data.adTaskCount });
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
    if (joined) {
      const key = "user:" + userId;
      const u = await read(env, key) || defaultUser();
      if (!u.doneTasks.includes(task)) {
        const reward = { community: 50, payout: 50, labs: 30, marka: 30, grampulse: 30 }[task] || 0;
        u.bonus += reward;
        u.doneTasks.push(task);
        await write(env, key, u);
      }
    }
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
    const inv = await read(env, "user:" + inviter) || defaultUser();
    if (!inv.friends.find(f => f.id === userId)) {
      inv.friends.push({
        id: userId,
        name: user.first_name || "Miner",
        qualified: false,
        paid: false
      });
      await write(env, "user:" + inviter, inv);
    }
    const referred = await read(env, "user:" + userId) || defaultUser();
    if (!referred.inviter) {
      referred.inviter = inviter;
      await write(env, "user:" + userId, referred);
    }
    return Response.json({ ok: true });
  }

  if (body.action === "qualify") {
    const referred = await read(env, "user:" + userId) || defaultUser();
    const inviter = referred.inviter;
    if (!inviter) return Response.json({ ok: true });
    const inv = await read(env, "user:" + inviter);
    if (inv && inv.friends) {
      let changed = false;
      inv.friends = inv.friends.map(f => {
        if (f.id === userId && !f.qualified) {
          f.qualified = true;
          changed = true;
        }
        return f;
      });
      if (changed) await write(env, "user:" + inviter, inv);
    }
    return Response.json({ ok: true });
  }

  if (body.action === "claim") {
    const data = await read(env, "user:" + userId) || defaultUser();
    let paid = 0;
    data.friends = (data.friends || []).map(f => {
      if (f.qualified && !f.paid) {
        f.paid = true;
        paid++;
      }
      return f;
    });
    if (paid > 0) {
      data.bonus += paid * 1000;
      await write(env, "user:" + userId, data);
    }
    return Response.json({ ok: true, paid, friends: data.friends, bonus: data.bonus });
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
  if (!userId || !amount || amount < MINW || !wallet) return Response.json({ ok: false, error: "Invalid request" });

  const uKey = "user:" + userId;
  const u = await read(env, uKey) || defaultUser();
  const balance = u.claimed + u.bonus;
  if (balance < amount) return Response.json({ ok: false, error: "Insufficient balance" });

  if (u.bonus >= amount) u.bonus -= amount;
  else {
    u.claimed -= (amount - u.bonus);
    u.bonus = 0;
  }
  await write(env, uKey, u);

  const key = "withdraw:" + userId;
  const data = await read(env, key) || { items: [] };
  const net = amount - FEE;
  data.items.unshift({ net, wallet, status: "pending", ts: Date.now() });
  await write(env, key, data);

  await sendTelegram(env, ADMIN_ID, `New withdrawal request\nUser: ${userId}\nNet: ${net} O\nWallet: ${wallet}`);
  return Response.json({ ok: true, items: data.items, claimed: u.claimed, bonus: u.bonus });
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
