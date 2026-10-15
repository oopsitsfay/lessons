  (async function () {
    const HP = window.HashPrints;
    const q = new URLSearchParams(location.search);
    const id = Number(q.get('id'));
    let seed = (q.get('seed') || '').toLowerCase();
    let d = Number(q.get('d') || 16);
    const key = q.get('c') === 'test' ? 'test' : 'main';
    const shape = HP.COLLECTIONS[key];
    const withC = (path) => (key === 'test' ? path + (path.includes('?') ? '&' : '?') + 'c=test' : path);
    document.getElementById('navCollection').href = withC('collection.html');
    document.getElementById('navMint').href = withC('mint.html');
    const view = document.getElementById('view');

    // Chain data for this token (owner, minter, history). The page still works without it.
    let chain = null;
    let token = null;
    if (Number.isInteger(id) && id > 0) {
      try {
        const r = await fetch(`/api/collection?c=${key}`);
        if (r.ok) chain = await r.json();
        token = chain?.tokens?.find((t) => t.id === id) || null;
      } catch {}
      if (token && !/^0x[0-9a-f]{64}$/.test(seed)) { seed = token.seed.toLowerCase(); d = token.d; }
    }

    if (!/^0x[0-9a-f]{64}$/.test(seed) || HP.leadingZeroBits(HP.fromHex(seed)) < d) {
      view.innerHTML = '<p class="err">This link doesn\'t point to a valid print. It needs a 64-character seed with enough zero bits.</p>';
      return;
    }
    const art = HP.render(seed, d);
    const title = id >= 1 && id <= shape.artistProofs ? `A/P ${id}` : id ? `#${id}` : '';
    const heading = `${shape.name} ${title}`.trim();
    document.title = heading;
    view.innerHTML = `
      <div class="grid">
        <div class="frame"><canvas id="c"></canvas></div>
        <div>
          <h1>${heading}</h1>
          <div class="pills" id="pills"></div>
          <div class="seedbox"><span>Seed</span><code>${seed}</code></div>
          <div class="trade" id="trade" hidden></div>
          <section class="card" id="ownCard" hidden><h2>Ownership</h2><table id="own"></table></section>
          <section class="card" id="offers" hidden></section>
          <section class="card"><h2>Traits</h2><div class="tgrid" id="t"></div></section>
          <section class="card" id="histWrap" hidden><h2>History</h2><ol class="timeline" id="hist"></ol></section>
          <div class="btns"><button id="png" type="button">PNG</button><button id="svg" type="button">SVG</button><a class="btn" href="${withC('collection.html')}">Collection</a><a class="btn" href="/#art">About the art</a></div>
        </div>
      </div>`;
    const c = document.getElementById('c');
    c.width = c.height = art.size;
    const ctx = c.getContext('2d');
    art.grid.forEach((row, y) => row.forEach((v, x) => { ctx.fillStyle = art.palette[v]; ctx.fillRect(x, y, 1, 1); }));
    const rows = Object.entries(art.traits);
    if (id > shape.artistProofs) rows.push(['Run', Math.floor((id - shape.artistProofs - 1) / shape.runSize) + 1]);
    rows.push(['Difficulty', `${d} bits`]);
    const addRow = (table, k, v, cls) => {
      const tr = table.insertRow();
      const th = document.createElement('th');
      th.textContent = k;
      tr.appendChild(th);
      const td = tr.insertCell();
      if (v instanceof Node) td.appendChild(v); else td.textContent = v;
      if (cls) td.className = cls;
      return td;
    };
    const t = document.getElementById('t');
    for (const [k, v] of rows) {
      const cell = document.createElement('div');
      const kk = document.createElement('span');
      kk.textContent = k;
      const vv = document.createElement('b');
      vv.textContent = v;
      if (k === 'Rarity' && v !== 'Common') vv.className = v === 'Holo Foil' ? 'holo' : 'gold';
      cell.append(kk, vv);
      t.appendChild(cell);
    }
    const pill = (text, cls = '') => `<span class="pill ${cls}"><i></i>${text}</span>`;
    const tr8 = art.traits;
    document.getElementById('pills').innerHTML = (id >= 1 && id <= shape.artistProofs ? pill('Artist proof', 'ap') : '')
      + (tr8.Rarity !== 'Common' ? pill(tr8.Rarity, tr8.Rarity === 'Holo Foil' ? 'holo' : 'gold') : pill('Common'))
      + pill(tr8.Edition) + pill(tr8.Style) + pill(`${d} bits`);

    // Owner, minter and history, when the token is on chain and matches this seed.
    if (token && token.seed.toLowerCase() === seed) {
      const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
      const link = (text, href, external) => {
        const a = document.createElement('a');
        a.textContent = text;
        a.href = href;
        if (external) { a.target = '_blank'; a.rel = 'noopener'; }
        return a;
      };
      const wallet = (a) => {
        const el = link('', withC(`collection.html?owner=${a}`));
        el.className = 'wchip';
        const dot = document.createElement('span');
        dot.className = 'dot';
        dot.style.background = `linear-gradient(135deg,#${a.slice(2, 8)},#${a.slice(-6)})`;
        el.append(dot, short(a));
        return el;
      };
      const when = (sec) => new Date(sec * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
      const own = document.getElementById('own');
      document.getElementById('ownCard').hidden = false;
      addRow(own, 'Owner', wallet(token.owner));
      addRow(own, 'Minted by', wallet(token.minter));
      addRow(own, 'Minted', link(`${when(token.time)} ↗`, `${chain.explorer}/tx/${token.tx}`, true));
      addRow(own, 'Token', link(`${short(chain.address)} / ${id} ↗`, `${chain.explorer}/nft/${chain.address}/${id}`, true));
      const events = chain.activity.filter((a) => a.id === id);
      if (token.lastSale) addRow(own, 'Last sale', HPTrade.eth(token.lastSale.price));
      if (events.length > 1) {
        const hist = document.getElementById('hist');
        document.getElementById('histWrap').hidden = false;
        for (const ev of events) {
          const li = document.createElement('li');
          li.className = ev.kind;
          const head = document.createElement('div');
          head.className = 'th';
          head.innerHTML = `<span class="pill ${ev.kind}"><i></i>${ev.kind === 'mint' ? 'Mint' : ev.kind === 'sale' ? 'Sale' : 'Transfer'}</span>`;
          if (ev.kind === 'sale') {
            const amt = document.createElement('b');
            amt.className = 'amt';
            amt.textContent = HPTrade.eth(ev.price, ev.currency === 'WETH' ? 'WETH' : 'ETH');
            head.appendChild(amt);
          }
          head.appendChild(link(`${when(ev.time)} ↗`, `${chain.explorer}/tx/${ev.tx}`, true));
          const who = document.createElement('div');
          who.className = 'tw';
          if (ev.kind === 'mint') who.append('Minted to ', wallet(ev.to));
          else who.append(wallet(ev.from), ' → ', wallet(ev.to));
          li.append(head, who);
          hist.appendChild(li);
        }
      }
      trade(token, chain).catch(() => {});
    }

    // ---------------------------------------------------------------- buy / sell / offers
    async function trade(token, chain) {
      const box = document.getElementById('trade');
      const offersBox = document.getElementById('offers');
      let market;
      try { market = await HPTrade.load(key); } catch { return; }
      if (!market.enabled) return;
      await HPTrade.connect(market.chainId, true).catch(() => null);
      const { el, eth } = HPTrade;
      const same = HPMarket.same;
      const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
      const ends = (t) => new Date(t * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
      const feeText = market.fees.map((f) => `${f.label.toLowerCase()} ${f.bps / 100}%`).join(' + ') || 'no fees';
      let owner = token.owner;
      let busy = false;
      let mode = null; // null | 'list' | 'reprice' | 'offer' | 'transfer'
      const msg = el('div', { class: 'msg', role: 'status' });
      const say = (text, kind = '') => { msg.textContent = text; msg.className = `msg ${kind}`; };

      async function refresh() { market = await HPTrade.load(key).catch(() => market); }

      async function act(fn, done) {
        if (busy) return;
        busy = true;
        say('');
        render();
        try {
          await fn((t) => say(t));
          await done();
        } catch (e) {
          say(HPTrade.friendly(e), 'bad');
        } finally {
          busy = false;
          render();
        }
      }

      async function connectThen(next) {
        const w = await HPTrade.connect(market.chainId, false);
        if (w) { if (next) next(); render(); }
      }

      const btn = (label, onclick, primary) => {
        const b = el('button', { type: 'button', class: primary ? 'primary' : '', onclick }, label);
        b.disabled = busy;
        return b;
      };

      // Cheapest live listing of any other print, and the best offer this print could take.
      function floorOther() {
        const l = market.listings.find((x) => x.tokenId !== token.id);
        return l ? l.price : null;
      }
      function topOffer() {
        const o = market.offers.find((x) => x.tokenId === token.id || x.tokenId === null);
        return o ? o.price : null;
      }

      function listingNow() {
        return market.listings.find((l) => l.tokenId === token.id && same(l.maker, owner)) || null;
      }

      function priceBox() {
        const me = HPTrade.wallet?.address;
        const mine = same(me, owner);
        const listing = listingNow();
        const kids = [];
        if (listing) {
          kids.push(el('div', { class: 'row1' }, el('span', { class: 'lbl' }, 'For sale'), el('span', { class: 'price' }, eth(listing.price))));
          kids.push(el('div', { class: 'sub' }, `Listed by ${mine ? 'you' : short(listing.maker)} · until ${ends(listing.endTime)} · includes ${feeText}`));
        } else {
          kids.push(el('div', { class: 'row1' }, el('span', { class: 'lbl' }, 'Not for sale'), token.lastSale ? el('span', { class: 'sub' }, `Last sale ${eth(token.lastSale.price)}`) : null));
        }
        const top = market.offers.find((o) => o.tokenId === token.id || o.tokenId === null);
        if (top) kids.push(el('div', { class: 'sub' }, `Best offer ${eth(top.price, 'WETH')}${top.tokenId === null ? ' (collection offer)' : ''}`));

        if (mode === 'list' || mode === 'reprice') {
          const reprice = mode === 'reprice';
          kids.push(HPTrade.priceForm(market, {
            mode: 'list',
            submitLabel: reprice ? 'Cancel old listing and relist' : 'List for sale',
            initial: reprice ? (Number(BigInt(listing.price)) / 1e18).toString() : '',
            note: reprice ? 'Changing the price cancels the current listing on chain (one small transaction), then you sign the new one.' : null,
            presets: [
              { label: 'Floor', wei: floorOther() },
              { label: 'Top offer', wei: topOffer() },
              { label: 'Last sale', wei: token.lastSale && token.lastSale.currency !== 'token' ? token.lastSale.price : null },
            ],
            onBack: () => { mode = null; render(); },
            onSubmit: ({ wei, days }) => act(async (st) => {
              if (reprice) { await HPTrade.cancel(market, listing, (t) => st(`Cancelling the old listing: ${t}`)); }
              await HPTrade.list(market, { tokenId: token.id, priceWei: wei, days, onStatus: st });
            }, async () => { await refresh(); mode = null; say('Listed. Anyone can buy it now.', 'good'); }),
          }));
        } else if (mode === 'offer') {
          kids.push(HPTrade.priceForm(market, {
            mode: 'offer', submitLabel: 'Make offer',
            presets: [{ label: 'Top offer', wei: topOffer() }, { label: 'Floor', wei: floorOther() }],
            note: 'Offers are paid in WETH (wrapped ETH, always worth 1 ETH). If you don\'t have enough, your wallet will first wrap the difference. Signing the offer is free.',
            onBack: () => { mode = null; render(); },
            onSubmit: ({ wei, days }) => act((st) => HPTrade.offer(market, { tokenId: token.id, amountWei: wei, days, onStatus: st }), async () => { await refresh(); mode = null; say('Offer made. The owner can accept it any time before it ends.', 'good'); }),
          }));
        } else if (mode === 'transfer') {
          const to = el('input', { type: 'text', placeholder: '0x…', 'aria-label': 'Send to address', autocomplete: 'off', spellcheck: 'false' });
          kids.push(el('form', { onsubmit: (e) => {
            e.preventDefault();
            const v = to.value.trim();
            if (!ethers.isAddress(v)) return say('That isn\'t a valid address.', 'bad');
            if (same(v, owner)) return say('That\'s the wallet it\'s already in.', 'bad');
            if (!confirm(`Send ${document.title} to ${v}? This can't be undone.`)) return;
            act((st) => HPTrade.transfer(market, token.id, v, st), async () => { owner = ethers.getAddress(v); await refresh(); mode = null; say(`Sent to ${short(v)}.`, 'good'); });
          } },
          el('label', {}, 'Send to', to),
          el('div', { class: 'note' }, listingNow() ? 'Sending it also ends your listing.' : 'Double-check the address. Prints sent to a wrong address can\'t be recovered.'),
          el('div', { class: 'acts' }, el('button', { type: 'submit', class: 'primary' }, 'Send'), btn('Back', () => { mode = null; render(); }))));
        } else {
          const acts = el('div', { class: 'acts' });
          if (!me) {
            if (listing) acts.append(btn('Connect wallet to buy', () => connectThen(), true));
            acts.append(btn(listing ? 'Connect to make an offer' : 'Connect wallet', () => connectThen()));
          } else if (mine) {
            if (listing) {
              acts.append(btn('Change price', () => { mode = 'reprice'; render(); }, true));
              acts.append(btn('Cancel listing', () => act((st) => HPTrade.cancel(market, listing, st), async () => { await refresh(); say('Listing cancelled.', 'good'); })));
            } else {
              acts.append(btn('List for sale', () => { mode = 'list'; render(); }, true));
            }
            acts.append(btn('Transfer', () => { mode = 'transfer'; say(''); render(); }));
          } else {
            if (listing) acts.append(btn(`Buy now for ${eth(listing.price)}`, () => act((st) => HPTrade.buy(market, listing, st), async () => {
              owner = me;
              await refresh();
              say('Bought. It\'s in your wallet now; the page will catch up in a few seconds.', 'good');
              setTimeout(() => location.reload(), 6000);
            }), true));
            acts.append(btn('Make offer', () => { mode = 'offer'; say(''); render(); }, !listing));
          }
          kids.push(acts);
        }
        kids.push(msg);
        return kids;
      }

      function offersTable() {
        const me = HPTrade.wallet?.address;
        const mine = same(me, owner);
        const rows = market.offers.filter((o) => o.tokenId === token.id || o.tokenId === null);
        if (!rows.length) return [el('h2', {}, 'Offers'), el('p', { class: 'none' }, 'No offers yet.')];
        const table = el('table', { class: 'offers' });
        const head = table.insertRow();
        for (const h of ['Offer', 'From', 'Ends', '']) head.appendChild(el('th', {}, h));
        for (const o of rows) {
          const tr = table.insertRow();
          tr.insertCell().append(el('b', { class: 'amt' }, eth(o.price, 'WETH')), o.tokenId === null ? el('div', { class: 'sub' }, 'collection offer') : '');
          const mk = el('a', { class: 'wchip', href: `collection.html?${key === 'test' ? 'c=test&' : ''}owner=${o.maker}` });
          const dot = el('span', { class: 'dot' });
          dot.style.background = `linear-gradient(135deg,#${o.maker.slice(2, 8)},#${o.maker.slice(-6)})`;
          mk.append(dot, same(o.maker, me) ? 'you' : short(o.maker));
          tr.insertCell().append(mk);
          tr.insertCell().append(ends(o.endTime));
          const cell = tr.insertCell();
          if (mine) {
            cell.append(btn('Accept', () => {
              if (!confirm(`Sell ${document.title} for ${eth(o.price, 'WETH')}?\n\nYou receive ${eth(o.net, 'WETH')} after ${feeText}. WETH is wrapped ETH; you can unwrap it from your wallet page.`)) return;
              act((st) => HPTrade.accept(market, o, token.id, st), async () => {
                owner = o.maker;
                await refresh();
                say(`Sold for ${eth(o.price, 'WETH')}. ${eth(o.net, 'WETH')} is in your wallet.`, 'good');
                setTimeout(() => location.reload(), 6000);
              });
            }, true));
            cell.append(el('div', { class: 'sub' }, `you get ${eth(o.net, 'WETH')}`));
          } else if (same(o.maker, me)) {
            cell.append(btn('Cancel', () => act((st) => HPTrade.cancel(market, o, st), async () => { await refresh(); say('Offer cancelled.', 'good'); })));
          }
        }
        return [el('h2', {}, `Offers (${rows.length})`), table];
      }

      function render() {
        box.replaceChildren(...priceBox());
        box.hidden = false;
        offersBox.replaceChildren(...offersTable());
        offersBox.hidden = false;
      }
      render();
    }

    const save = (name, blob) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };
    const name = `hashprint-${id || seed.slice(2, 10)}`;
    document.getElementById('svg').onclick = () => save(name + '.svg', new Blob([HP.toSVG(art, 16)], { type: 'image/svg+xml' }));
    document.getElementById('png').onclick = () => {
      const big = document.createElement('canvas');
      big.width = big.height = art.size * 16;
      const g = big.getContext('2d');
      g.imageSmoothingEnabled = false;
      g.drawImage(c, 0, 0, big.width, big.height);
      big.toBlob((b) => save(name + '.png', b));
    };
  })();
