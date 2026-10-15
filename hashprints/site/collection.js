/* global HashPrints, HPWallet */
(function () {
  const HP = window.HashPrints;
  const $ = (id) => document.getElementById(id);
  const PAGE = 60;
  const REFRESH_MS = 30000;
  const FILTER_TRAITS = ['Status', 'Rarity', 'Edition', 'Style', 'Symmetry', 'Registration', 'Glitch', 'Run', 'Inks'];
  const OPEN_BY_DEFAULT = new Set(['Status', 'Rarity', 'Edition', 'Style']);
  const RARITY_ORDER = { 'Holo Foil': 2, 'Gold Leaf': 1, Common: 0 };

  const q = new URLSearchParams(location.search);
  const key = q.get('c') === 'test' ? 'test' : 'main';
  const shape = HP.COLLECTIONS[key];
  const ownerParam = /^0x[0-9a-fA-F]{40}$/.test(q.get('owner') || '') ? q.get('owner') : null;
  const owner = ownerParam && ownerParam.toLowerCase();
  const withC = (path) => (key === 'test' ? path + (path.includes('?') ? '&' : '?') + 'c=test' : path);

  let data = null;
  let market = { enabled: false, listings: [] };
  let listed = new Map(); // token id -> live listing
  let prints = []; // tokens + rendered art, in token order
  let tab = ['items', 'activity', 'offers', 'holders'].includes(q.get('tab')) ? q.get('tab') : 'items';
  let shown = PAGE;
  let account = null;
  const picked = new Map(); // trait -> Set(values)

  // ------------------------------------------------------------ helpers
  const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
  const same = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
  const ZERO = '0x0000000000000000000000000000000000000000';
  const label = (t) => (t.id <= data.artistProofs ? `A/P ${t.id}` : `#${t.id}`);
  const runOf = (t) => (t.id <= data.artistProofs ? 'Artist Proof' : String(Math.floor((t.id - data.artistProofs - 1) / data.runSize) + 1));
  const printUrl = (t) => withC(`print.html?id=${t.id}&seed=${t.seed}&d=${t.d}`);
  const walletUrl = (a) => withC(`collection.html?owner=${a}`);
  const who = (a) => (same(a, account) ? 'you' : short(a));
  const eth = (wei, unit = 'ETH') => {
    const n = Number(BigInt(wei)) / 1e18;
    return `${n.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${unit}`;
  };

  function ago(sec) {
    const s = Math.max(0, Math.floor(Date.now() / 1000 - sec));
    if (s < 60) return 'just now';
    const units = [[86400 * 30, 'mo'], [86400, 'd'], [3600, 'h'], [60, 'm']];
    for (const [n, u] of units) if (s >= n) return `${Math.floor(s / n)}${u} ago`;
    return 'just now';
  }

  function paint(canvas, art) {
    canvas.width = canvas.height = art.size;
    const ctx = canvas.getContext('2d');
    art.grid.forEach((row, y) => row.forEach((v, x) => { ctx.fillStyle = art.palette[v]; ctx.fillRect(x, y, 1, 1); }));
    return canvas;
  }
  const thumb = (p) => paint(document.createElement('canvas'), p.art);

  function rarityTag(p) {
    if (p.id <= data.artistProofs) return '<span class="tag ap">A/P</span>';
    const r = p.traits.Rarity;
    if (r === 'Holo Foil') return '<span class="tag holo">Holo</span>';
    if (r === 'Gold Leaf') return '<span class="tag gold">Gold</span>';
    return '';
  }

  // ------------------------------------------------------------ header
  function renderHeader() {
    const mine = owner ? prints.filter((p) => same(p.owner, owner)) : prints;
    const strip = $('strip');
    const pool = (mine.length ? mine : prints).slice().reverse().slice(0, 12);
    strip.replaceChildren(...pool.map(thumb));
    strip.classList.toggle('hidden', !pool.length);

    const avatar = $('avatar');
    const face = owner ? mine[0] : prints.find((p) => p.traits.Rarity !== 'Common') || prints[0];
    if (face) {
      avatar.className = 'avatar';
      avatar.replaceChildren(thumb(face));
    } else if (owner) {
      avatar.className = 'avatar addr';
      avatar.style.background = `#${owner.slice(2, 8)}`;
      avatar.textContent = owner.slice(2, 4).toUpperCase();
    }
    document.querySelector('.head').classList.toggle('flat', !pool.length);

    const explorer = data.explorer;
    if (owner) {
      $('title').textContent = same(owner, account) ? 'Your prints' : short(ownerParam);
      document.title = `${short(ownerParam)} · ${shape.name}`;
      $('meta').innerHTML = `<span>${esc(ownerParam)}</span><a href="${explorer}/address/${esc(ownerParam)}" target="_blank" rel="noopener">Etherscan ↗</a>`;
      $('actions').innerHTML = `<a class="btn ghost" href="${withC('collection.html')}">All prints</a>`;
      renderWalletTools();
      $('desc').classList.add('hidden');
      const minted = prints.filter((p) => same(p.minter, owner)).length;
      const rare = mine.filter((p) => p.traits.Rarity !== 'Common').length;
      $('stats').innerHTML = stat(mine.length, 'Holding') + stat(minted, 'Minted') + stat(rare, 'Gold / Holo')
        + stat(mine.filter((p) => p.traits.Edition === 'Night').length, 'Night') + stat(mine.filter((p) => p.traits.Edition === 'Paper').length, 'Paper')
        + stat(mine.filter((p) => p.id <= data.artistProofs).length, 'Artist proofs');
      $('progressWrap').classList.add('hidden');
      $('holdersTab').classList.add('hidden');
      return;
    }
    document.title = `${shape.name} Collection`;
    if (key === 'test') $('desc').textContent = `A ${data.max}-print test run of HashPrints on ${data.chainId === 1 ? 'Ethereum' : 'Sepolia'}, used to try the mint and the market before the main collection.`;
    $('title').textContent = shape.name;
    const status = data.total >= data.max ? '<span class="badge">Sold out</span>'
      : data.live ? '<span class="badge live"><i></i>Minting now</span>' : '<span class="badge off"><i></i>Not live</span>';
    $('meta').innerHTML = `${status}<a href="${explorer}/address/${data.address}#code" target="_blank" rel="noopener">${short(data.address)} ↗</a><span>${data.chainId === 1 ? 'Ethereum' : 'Sepolia'}</span><a href="https://x.com/hashprintsnft" target="_blank" rel="noopener">@hashprintsnft ↗</a>`;
    $('actions').innerHTML = `${market.enabled ? '<button class="btn ghost" type="button" id="offerBtn">Make collection offer</button>' : ''}<a class="btn" href="${withC('mint.html')}">Mint · ${esc(eth(data.price))}</a>`;
    if (market.enabled) $('offerBtn').onclick = openCollectionOffer;
    const holders = new Set(prints.map((p) => p.owner.toLowerCase())).size;
    const rare = prints.filter((p) => p.traits.Rarity !== 'Common').length;
    const minted = stat(`${data.total.toLocaleString()}<small style="color:var(--muted);font-weight:400"> / ${data.max.toLocaleString()}</small>`, 'Minted', true);
    if (market.enabled) {
      const floor = market.listings.length ? eth(market.listings[0].price) : '–';
      const top = market.offers.find((o) => o.tokenId === null);
      $('stats').innerHTML = minted + stat(floor, 'Floor') + stat(top ? eth(top.price, 'WETH') : '–', 'Top offer') + stat(market.listings.length, 'Listed')
        + stat(data.volume && data.volume !== '0' ? eth(data.volume) : '0 ETH', `Volume · ${data.sales || 0} sale${data.sales === 1 ? '' : 's'}`) + stat(holders, 'Holders');
    } else {
      $('stats').innerHTML = minted + stat(holders, 'Holders') + stat(eth(data.price), 'Mint price')
        + stat(data.live ? `${data.run + 1} / ${data.runs}` : '–', 'Run') + stat(`${data.difficulty} bits`, 'Difficulty') + stat(rare, 'Gold / Holo');
    }
    $('progress').style.width = `${(data.total / data.max) * 100}%`;
  }

  function stat(value, name, html = false) {
    return `<div><b>${html ? value : esc(typeof value === 'number' ? value.toLocaleString() : value)}</b><span>${esc(name)}</span></div>`;
  }

  // ------------------------------------------------------------ items
  function scope() {
    return owner ? prints.filter((p) => same(p.owner, owner)) : prints;
  }

  function renderFilters() {
    const list = scope();
    const groups = FILTER_TRAITS.filter((trait) => trait !== 'Status' || market.enabled).map((trait) => {
      const counts = new Map();
      for (const p of list) counts.set(p.traits[trait], (counts.get(p.traits[trait]) || 0) + 1);
      if (!counts.size) return '';
      const values = [...counts.entries()].sort((a, b) => (trait === 'Run' ? runSort(a[0], b[0]) : b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))));
      const sel = picked.get(trait) || new Set();
      const open = OPEN_BY_DEFAULT.has(trait) || sel.size ? ' open' : '';
      return `<details${open}><summary>${esc(trait)}</summary><div>${values.map(([v, n]) =>
        `<label><input type="checkbox" data-trait="${esc(trait)}" value="${esc(v)}"${sel.has(String(v)) ? ' checked' : ''}><span>${esc(v)}</span><em>${n}</em></label>`).join('')}</div></details>`;
    }).join('');
    $('filterGroups').innerHTML = groups;
  }
  const runSort = (a, b) => (a === 'Artist Proof' ? -1 : b === 'Artist Proof' ? 1 : Number(a) - Number(b));

  function filtered() {
    const term = $('search').value.trim().replace(/^#/, '');
    let list = scope().filter((p) => {
      for (const [trait, values] of picked) if (values.size && !values.has(String(p.traits[trait]))) return false;
      if (!term) return true;
      if (/^\d+$/.test(term)) return String(p.id).startsWith(term);
      if (/^0x/i.test(term)) return p.owner.toLowerCase().startsWith(term.toLowerCase()) || p.minter.toLowerCase().startsWith(term.toLowerCase());
      return Object.values(p.traits).some((v) => String(v).toLowerCase().includes(term.toLowerCase()));
    });
    const sort = $('sort').value;
    list = list.slice();
    if (sort === 'new') list.sort((a, b) => b.block - a.block || b.id - a.id);
    else if (sort === 'old') list.sort((a, b) => a.block - b.block || a.id - b.id);
    else if (sort === 'id') list.sort((a, b) => a.id - b.id);
    else if (sort === 'price' || sort === 'price-desc') {
      const dir = sort === 'price' ? 1 : -1;
      list.sort((a, b) => {
        const pa = listed.get(a.id), pb = listed.get(b.id);
        if (!pa || !pb) return (pa ? -1 : 0) + (pb ? 1 : 0) || a.id - b.id;
        const x = BigInt(pa.price), y = BigInt(pb.price);
        return (x < y ? -dir : x > y ? dir : 0) || a.id - b.id;
      });
    } else if (sort === 'work') list.sort((a, b) => b.extra - a.extra || (RARITY_ORDER[b.traits.Rarity] || 0) - (RARITY_ORDER[a.traits.Rarity] || 0) || a.id - b.id);
    return list;
  }

  function renderChips() {
    const chips = [];
    for (const [trait, values] of picked) for (const v of values) chips.push(`<button class="chip" type="button" data-trait="${esc(trait)}" data-value="${esc(v)}">${esc(trait)}: ${esc(v)} ✕</button>`);
    if (chips.length > 1) chips.push('<button class="chip clear" type="button" data-clear="1">Clear all</button>');
    $('chips').innerHTML = chips.join('');
    $('filterBtn').textContent = chips.length ? `Filters (${[...picked.values()].reduce((n, s) => n + s.size, 0)})` : 'Filters';
  }

  function renderItems() {
    const list = filtered();
    renderChips();
    const grid = $('grid');
    if (!scope().length) {
      $('count').textContent = '';
      grid.innerHTML = `<div class="empty" style="grid-column:1/-1">${owner
        ? `<p>This wallet doesn't hold any ${esc(shape.name)} yet.</p><a class="btn" href="${withC('mint.html')}">Mint one</a>`
        : `<p>Nothing minted yet.</p><a class="btn" href="${withC('mint.html')}">Go to the mint</a>`}</div>`;
      $('moreBtn').classList.add('hidden');
      return;
    }
    $('count').textContent = `${list.length.toLocaleString()} ${list.length === 1 ? 'print' : 'prints'}`;
    if (!list.length) {
      grid.innerHTML = '<div class="empty" style="grid-column:1/-1"><p>No prints match these filters.</p></div>';
      $('moreBtn').classList.add('hidden');
      return;
    }
    const cards = list.slice(0, shown).map((p) => {
      const a = document.createElement('a');
      a.className = 'card';
      a.href = printUrl(p);
      a.appendChild(thumb(p));
      const info = document.createElement('div');
      info.className = 'info';
      info.innerHTML = `<div class="name"><span>${esc(label(p))}</span>${rarityTag(p)}</div>`
        + `<div class="sub">${esc(p.traits.Edition)} · ${esc(p.traits.Style)} · ${esc(who(p.owner))}</div>`
        + (listed.has(p.id) ? `<div class="price">${esc(eth(listed.get(p.id).price))}</div>`
          : p.lastSale ? `<div class="sub">Last sale ${esc(eth(p.lastSale.price))}</div>` : '');
      a.appendChild(info);
      return a;
    });
    grid.replaceChildren(...cards);
    $('moreBtn').classList.toggle('hidden', list.length <= shown);
  }

  // ------------------------------------------------------------ activity + holders
  function renderActivity() {
    const byId = new Map(prints.map((p) => [p.id, p]));
    const rows = data.activity.filter((a) => !owner || same(a.from, owner) || same(a.to, owner));
    const body = $('activity');
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="5"><div class="empty" style="margin:16px 0">No activity yet.</div></td></tr>';
      return;
    }
    body.replaceChildren(...rows.map((a) => {
      const p = byId.get(a.id);
      const tr = document.createElement('tr');
      const addr = (x) => (x === ZERO ? '<span style="color:var(--muted)">–</span>' : `<a class="addr" href="${walletUrl(x)}">${esc(who(x))}</a>`);
      const evName = a.kind === 'mint' ? 'Minted' : a.kind === 'sale' ? `Sale · ${esc(eth(a.price))}${a.currency === 'WETH' ? ' WETH' : ''}` : 'Transfer';
      tr.innerHTML = `<td><span class="ev ${a.kind}">${evName}</span></td>`
        + '<td class="itemcell"></td>'
        + `<td class="hide-sm">${addr(a.from)}</td><td>${addr(a.to)}</td>`
        + `<td class="num"><a href="${data.explorer}/tx/${a.tx}" target="_blank" rel="noopener" title="${new Date(a.time * 1000).toLocaleString()}">${ago(a.time)} ↗</a></td>`;
      const cell = tr.querySelector('.itemcell');
      const link = document.createElement('a');
      link.className = 'item';
      if (p) {
        link.href = printUrl(p);
        link.appendChild(thumb(p));
        link.append(label(p));
      } else {
        link.textContent = `#${a.id}`;
      }
      cell.appendChild(link);
      return tr;
    }));
    if (data.activityTotal > data.activity.length && !owner) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td colspan="5" style="color:var(--muted);font:12px 'JetBrains Mono',monospace">Showing the latest ${data.activity.length}. Older events are on <a href="${data.explorer}/token/${data.address}" target="_blank" rel="noopener">Etherscan ↗</a></td>`;
      body.appendChild(tr);
    }
  }

  function renderHolders() {
    const owned = new Map();
    for (const p of prints) {
      const k = p.owner.toLowerCase();
      if (!owned.has(k)) owned.set(k, { addr: p.owner, prints: [] });
      owned.get(k).prints.push(p);
    }
    const list = [...owned.values()].sort((a, b) => b.prints.length - a.prints.length || a.addr.localeCompare(b.addr));
    const body = $('holders');
    if (!list.length) {
      $('holderStats').innerHTML = '';
      $('holderDist').innerHTML = '';
      body.innerHTML = '<tr><td colspan="5"><div class="empty" style="margin:16px 0">No holders yet.</div></td></tr>';
      return;
    }
    const total = prints.length;
    const top10 = list.slice(0, 10).reduce((n, h) => n + h.prints.length, 0);
    const stat = (v, k) => `<div><b>${v}</b><span>${k}</span></div>`;
    $('holderStats').innerHTML = stat(list.length.toLocaleString(), 'Holders')
      + stat(`${((list.length / total) * 100).toFixed(0)}%`, 'Unique owners')
      + stat((total / list.length).toFixed(2), 'Avg per wallet')
      + stat(`${((top10 / total) * 100).toFixed(0)}%`, 'Held by top 10');

    const buckets = [['1 print', (n) => n === 1, 'var(--accent)'], ['2 prints', (n) => n === 2, 'var(--holo)'], ['3–5', (n) => n >= 3 && n <= 5, 'var(--gold)'], ['6+', (n) => n >= 6, 'var(--text-2)']]
      .map(([k, f, c]) => ({ k, c, n: list.filter((h) => f(h.prints.length)).length })).filter((x) => x.n);
    $('holderDist').innerHTML = `<div class="t"><span>Wallets by prints held</span><span>${list.length} wallets</span></div>`
      + `<div class="bar">${buckets.map((x) => `<i style="width:${(x.n / list.length) * 100}%;background:${x.c}"></i>`).join('')}</div>`
      + `<div class="keys">${buckets.map((x) => `<span style="--c:${x.c}">${x.k} · ${x.n}</span>`).join('')}</div>`;

    body.replaceChildren(...list.map((h, i) => {
      const tr = document.createElement('tr');
      if (i < 3) tr.className = 'top';
      const n = h.prints.length;
      const you = same(h.addr, account);
      tr.innerHTML = `<td class="num"><span class="rank">${String(i + 1).padStart(2, '0')}</span></td>`
        + `<td><a class="who" href="${walletUrl(h.addr)}"><span class="dot" style="background:linear-gradient(135deg,#${h.addr.slice(2, 8)},#${h.addr.slice(-6)})"></span><span><b>${esc(short(h.addr))}</b><em>${you ? 'You' : 'View prints'}</em></span></a></td>`
        + '<td class="hide-sm"><div class="thumbs"></div></td>'
        + `<td class="num"><span class="held">${n}</span></td>`
        + `<td class="num hide-sm">${((n / total) * 100).toFixed(1)}%<span class="share" style="display:inline-block;margin-left:10px;vertical-align:middle"><span style="display:block;height:100%;background:var(--accent);width:${(n / list[0].prints.length) * 100}%"></span></span></td>`;
      const box = tr.querySelector('.thumbs');
      for (const p of h.prints.slice(0, 5)) box.appendChild(thumb(p));
      if (n > 5) { const more = document.createElement('small'); more.textContent = `+${n - 5}`; box.appendChild(more); }
      return tr;
    }));
  }

  // ------------------------------------------------------------ offers + wallet tools
  function renderOffers() {
    const byId = new Map(prints.map((p) => [p.id, p]));
    const rows = market.offers.filter((o) => !owner || same(o.maker, owner) || (o.tokenId !== null && same(byId.get(o.tokenId)?.owner, owner)));
    $('offersNote').textContent = market.enabled
      ? `Offers are paid in WETH and include ${market.fees.map((f) => `the ${f.bps / 100}% ${f.label.toLowerCase()}`).join(' and ') || 'no fees'}. Owners accept them from the print's page; a collection offer can be accepted with any print.`
      : '';
    const body = $('offersBody');
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="5"><div class="empty" style="margin:16px 0">No offers yet.</div></td></tr>';
      return;
    }
    body.replaceChildren(...rows.map((o) => {
      const p = o.tokenId === null ? null : byId.get(o.tokenId);
      const tr = document.createElement('tr');
      const cell = document.createElement('td');
      if (p) {
        const a = document.createElement('a');
        a.className = 'item';
        a.href = printUrl(p);
        a.append(thumb(p), label(p));
        cell.appendChild(a);
      } else {
        cell.innerHTML = '<b>Any print</b><div class="count" style="margin:0">collection offer</div>';
      }
      tr.appendChild(cell);
      tr.insertAdjacentHTML('beforeend', `<td class="num"><b>${esc(eth(o.price, 'WETH'))}</b></td><td class="hide-sm"><a class="addr" href="${walletUrl(o.maker)}">${esc(who(o.maker))}</a></td>`
        + `<td class="num hide-sm">${new Date(o.endTime * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</td><td class="num"></td>`);
      const act = tr.lastElementChild;
      if (same(o.maker, account)) {
        const b = document.createElement('button');
        b.className = 'act';
        b.type = 'button';
        b.textContent = 'Cancel';
        b.onclick = () => runTx(b, (st) => HPTrade.cancel(market, o, st), 'Offer cancelled.');
        act.appendChild(b);
      } else if (p && same(p.owner, account)) {
        act.innerHTML = `<a class="act" href="${printUrl(p)}">Review</a>`;
      }
      return tr;
    }));
  }

  // Run a wallet action from a small button, showing progress in a toast.
  async function runTx(button, fn, done) {
    button.disabled = true;
    try {
      await fn((t) => HPWallet.toast(t));
      HPWallet.toast(done);
      market = await loadMarket();
      applyMarket();
      renderHeader();
      renderItems();
      renderTab();
    } catch (e) {
      HPWallet.toast(HPTrade.friendly(e), 'error');
    } finally {
      button.disabled = false;
    }
  }

  async function needWallet() {
    if (HPTrade.wallet && HPTrade.wallet.chainId === data.chainId) return true;
    const w = await HPTrade.connect(data.chainId, false);
    if (w) setAccount(w.address);
    return !!w;
  }

  async function openCollectionOffer() {
    if (!(await needWallet())) return;
    const panel = $('panel');
    const msg = HPTrade.el('div', { class: 'msg', role: 'status' });
    const close = () => { panel.classList.add('hidden'); panel.replaceChildren(); };
    const form = HPTrade.priceForm(market, {
      mode: 'offer', submitLabel: 'Make collection offer', onBack: close,
      presets: [
        { label: 'Top offer', wei: market.offers.find((o) => o.tokenId === null)?.price ?? null },
        { label: 'Floor', wei: market.listings[0]?.price ?? null },
      ],
      note: 'Any owner can accept it with any print. Paid in WETH (wrapped ETH); if you don\'t have enough, your wallet wraps the difference first. Signing is free.',
      onSubmit: async ({ wei, days }) => {
        form.setBusy(true);
        try {
          await HPTrade.offer(market, { tokenId: null, amountWei: wei, days, onStatus: (t) => { msg.textContent = t; msg.className = 'msg'; } });
          msg.textContent = 'Collection offer made.';
          msg.className = 'msg good';
          market = await loadMarket();
          applyMarket();
          renderHeader();
          renderCounts();
          if (tab === 'offers') renderOffers();
          setTimeout(close, 2500);
        } catch (e) {
          msg.textContent = HPTrade.friendly(e);
          msg.className = 'msg bad';
        } finally {
          form.setBusy(false);
        }
      },
    });
    panel.replaceChildren(HPTrade.el('h3', {}, 'Make a collection offer'), HPTrade.el('p', {}, `An offer for any ${shape.name} print.`), form, msg);
    panel.classList.remove('hidden');
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // On your own wallet page: WETH balance with unwrap, and cancel every open order at once.
  async function renderWalletTools() {
    const panel = $('panel');
    if (!market.enabled || !owner || !same(owner, account) || !HPTrade.wallet || HPTrade.wallet.chainId !== data.chainId) {
      panel.classList.add('hidden');
      return;
    }
    const { el } = HPTrade;
    let balance = 0n;
    try { balance = await HPTrade.wethBalance(market); } catch {}
    const mineOpen = market.listings.filter((l) => same(l.maker, account)).length + market.offers.filter((o) => same(o.maker, account)).length;
    const unwrap = el('button', { type: 'button' }, 'Unwrap to ETH');
    unwrap.disabled = balance === 0n;
    unwrap.onclick = () => runTx(unwrap, (st) => HPTrade.unwrap(market, balance, st), 'Unwrapped.').then(renderWalletTools);
    const cancelAll = el('button', { type: 'button' }, 'Cancel all');
    cancelAll.disabled = mineOpen === 0;
    cancelAll.onclick = () => {
      if (!confirm('Cancel every listing and offer this wallet has signed on Seaport? This is one transaction, and it also cancels orders made on other Seaport marketplaces.')) return;
      runTx(cancelAll, (st) => HPTrade.cancelAll(market, st), 'All your listings and offers are cancelled.').then(renderWalletTools);
    };
    panel.replaceChildren(
      el('h3', {}, 'Your wallet'),
      el('div', { class: 'row' }, el('span', {}, `WETH: ${eth(balance, 'WETH')}`), unwrap),
      el('div', { class: 'row' }, el('span', {}, `Open listings and offers: ${mineOpen}`), cancelAll));
    panel.classList.remove('hidden');
  }

  function renderCounts() {
    $('offersTab').classList.toggle('hidden', !market.enabled);
    $('nOffers').textContent = String(market.offers.filter((o) => !owner || same(o.maker, owner)).length);
    $('nItems').textContent = scope().length.toLocaleString();
    $('nHolders').textContent = new Set(prints.map((p) => p.owner.toLowerCase())).size.toLocaleString();
    const acts = owner ? data.activity.filter((a) => same(a.from, owner) || same(a.to, owner)).length : data.activityTotal;
    $('nActivity').textContent = acts.toLocaleString();
  }

  function renderTab() {
    for (const b of $('tabs').querySelectorAll('button')) b.classList.toggle('on', b.dataset.tab === tab);
    for (const t of ['items', 'activity', 'offers', 'holders']) $(`tab-${t}`).classList.toggle('hidden', t !== tab);
    if (tab === 'offers') renderOffers();
    if (tab === 'activity') renderActivity();
    if (tab === 'holders') renderHolders();
  }

  function renderAll() {
    renderHeader();
    renderCounts();
    renderFilters();
    renderItems();
    renderTab();
    $('foot').textContent = `Read from ${data.chainId === 1 ? 'Ethereum' : 'Sepolia'} at block ${data.block.toLocaleString()}. Updates every 30 seconds.`;
  }

  // ------------------------------------------------------------ data
  async function load() {
    const res = await fetch(`/api/collection?c=${key}`, { cache: 'no-store' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    return body;
  }

  function adopt(next) {
    const cache = new Map(prints.map((p) => [p.id, p]));
    data = next;
    prints = next.tokens.map((t) => {
      const old = cache.get(t.id);
      const art = old && old.seed === t.seed ? old.art : HP.render(t.seed, t.d);
      const traits = { Status: '', ...art.traits, Run: '' };
      const p = { ...t, art, traits };
      p.traits.Run = runOf(p);
      return p;
    });
    applyMarket();
  }

  // Only listings whose seller still owns the print count (the API checks this too).
  function applyMarket() {
    listed = new Map();
    const owners = new Map(prints.map((p) => [p.id, p.owner]));
    for (const l of market.listings) if (same(owners.get(l.tokenId), l.maker)) listed.set(l.tokenId, l);
    market.listings = market.listings.filter((l) => listed.get(l.tokenId) === l);
    for (const p of prints) p.traits.Status = listed.has(p.id) ? 'Buy now' : 'Not listed';
  }

  async function loadMarket() {
    const r = await fetch(`/api/market?c=${key}`, { cache: 'no-store' }).catch(() => null);
    const body = r && r.ok ? await r.json().catch(() => null) : null;
    return body && body.enabled ? body : { enabled: false, listings: [] };
  }

  async function refresh(first) {
    try {
      const [next, nextMarket] = await Promise.all([load(), loadMarket()]);
      const marketChanged = JSON.stringify(nextMarket.listings.map((l) => l.orderHash)) !== JSON.stringify(market.listings.map((l) => l.orderHash)) || nextMarket.enabled !== market.enabled;
      market = nextMarket;
      if (data && marketChanged) applyMarket();
      $('error').classList.add('hidden');
      if (!next.deployed) {
        $('title').textContent = shape.name;
        $('meta').innerHTML = '<span class="badge off"><i></i>Not deployed</span>';
        $('grid').innerHTML = '<div class="empty" style="grid-column:1/-1"><p>The contract isn\'t deployed yet.</p></div>';
        return;
      }
      const changed = !data || next.block !== data.block || next.total !== data.total || next.activityTotal !== data.activityTotal;
      if (!changed && !marketChanged) return;
      if (changed) adopt(next);
      $('sortPrice').hidden = $('sortPriceDesc').hidden = !market.enabled;
      if (first) {
        renderAll();
      } else {
        renderHeader();
        renderCounts();
        renderFilters();
        renderItems();
        renderTab();
      }
    } catch (e) {
      if (first || !data) {
        $('error').textContent = `Couldn't load the collection: ${e.message}. Retrying…`;
        $('error').classList.remove('hidden');
      }
    }
  }

  // ------------------------------------------------------------ events
  $('tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (!b || !data) return;
    tab = b.dataset.tab;
    const u = new URL(location.href);
    if (tab === 'items') u.searchParams.delete('tab'); else u.searchParams.set('tab', tab);
    history.replaceState(null, '', u);
    renderTab();
  });

  $('filterGroups').addEventListener('change', (e) => {
    const box = e.target;
    if (!box.dataset.trait) return;
    const set = picked.get(box.dataset.trait) || new Set();
    if (box.checked) set.add(box.value); else set.delete(box.value);
    if (set.size) picked.set(box.dataset.trait, set); else picked.delete(box.dataset.trait);
    shown = PAGE;
    renderItems();
  });

  $('chips').addEventListener('click', (e) => {
    const c = e.target.closest('.chip');
    if (!c) return;
    if (c.dataset.clear) picked.clear();
    else {
      const set = picked.get(c.dataset.trait);
      set?.delete(c.dataset.value);
      if (set && !set.size) picked.delete(c.dataset.trait);
    }
    shown = PAGE;
    renderFilters();
    renderItems();
  });

  let searchTimer;
  $('search').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { shown = PAGE; if (data) renderItems(); }, 150);
  });
  $('search').addEventListener('keydown', (e) => {
    const v = $('search').value.trim();
    if (e.key === 'Enter' && /^0x[0-9a-fA-F]{40}$/.test(v)) location.href = walletUrl(v);
  });
  $('sort').addEventListener('change', () => { shown = PAGE; if (data) renderItems(); });
  $('moreBtn').addEventListener('click', () => { shown += PAGE; renderItems(); });
  new IntersectionObserver((entries) => {
    if (entries.some((x) => x.isIntersecting) && !$('moreBtn').classList.contains('hidden')) { shown += PAGE; renderItems(); }
  }, { rootMargin: '600px' }).observe($('moreBtn'));

  const narrow = () => matchMedia('(max-width: 860px)').matches;
  $('filterBtn').addEventListener('click', () => {
    if (narrow()) $('layout').classList.add('showfilters');
    else $('layout').classList.toggle('nofilters');
  });
  $('filtersDone').addEventListener('click', () => $('layout').classList.remove('showfilters'));

  // Wallet: silent reconnect to mark "you", and a shortcut to your own prints.
  function setAccount(a) {
    account = a;
    $('walletBtn').textContent = a ? (same(a, owner) ? short(a) : 'My prints') : 'My prints';
    if (data) { renderHeader(); renderItems(); renderTab(); }
  }
  $('walletBtn').addEventListener('click', async () => {
    if (!account) {
      const w = data ? await HPTrade.connect(data.chainId, false) : await HPWallet.connect();
      if (!w) return;
      setAccount(w.address);
    }
    if (!same(account, owner)) location.href = walletUrl(account);
  });

  for (const id of ['navMint', 'footMint']) $(id).href = withC('mint.html');
  $('navCollection').href = withC('collection.html');
  if (ownerParam) $('search').placeholder = 'Search this wallet by number';

  refresh(true);
  setInterval(() => { if (!document.hidden) refresh(false); }, REFRESH_MS);
  HPTrade.connect(0, true).then((w) => w && setAccount(w.address)).catch(() => {});
})();
