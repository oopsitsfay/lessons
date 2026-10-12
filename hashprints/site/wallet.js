/* Wallet connection shared by the mint, sign-in and admin pages.
 *
 * - Finds every installed wallet via EIP-6963 (falls back to window.ethereum), so multiple
 *   extensions don't fight over the page. One wallet connects straight away; several show a picker.
 * - On a phone browser with no wallet, offers "open this page in <wallet app>" links instead.
 * - Remembers the last wallet and reconnects silently (eth_accounts, no popup) on the next visit.
 * - toast() shows messages next to the action instead of in a log.
 */
(function () {
  const KEY = 'hp.wallet.rdns';
  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const found = new Map();

  window.addEventListener('eip6963:announceProvider', (e) => {
    const { info, provider } = e.detail || {};
    if (info && provider) found.set(info.uuid || info.rdns, { info, provider });
  });

  async function discover() {
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    await new Promise((r) => setTimeout(r, 250));
    const list = [...found.values()];
    if (!list.length && window.ethereum) {
      const name = window.ethereum.isMetaMask ? 'MetaMask' : window.ethereum.isCoinbaseWallet ? 'Coinbase Wallet' : 'Browser wallet';
      list.push({ info: { name, rdns: 'injected', icon: '' }, provider: window.ethereum });
    }
    return list;
  }

  // ------------------------------------------------------------ small UI
  const css = `
    .hpw-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:flex-end;justify-content:center;z-index:1000;padding:16px}
    @media(min-width:600px){.hpw-backdrop{align-items:center}}
    .hpw-sheet{width:100%;max-width:380px;background:var(--paper,#f4f0e6);color:var(--ink,#1b1b1b);border:2px solid var(--ink,#1b1b1b);padding:20px;font:15px/1.5 "Space Grotesk",system-ui,sans-serif}
    .hpw-sheet h3{margin:0 0 4px;font-size:18px}
    .hpw-sheet p{margin:0 0 14px;color:var(--muted,#7a7466);font-size:13px}
    .hpw-opt{display:flex;align-items:center;gap:12px;width:100%;padding:12px;margin:0 0 8px;background:transparent;color:inherit;border:1px solid var(--rule,#d6cfbd);font:700 14px "JetBrains Mono",monospace;cursor:pointer;text-align:left;text-decoration:none}
    .hpw-opt:hover{border-color:var(--accent,#ff48b0)}
    .hpw-opt img,.hpw-opt i{width:28px;height:28px;flex:none;border-radius:6px;background:var(--rule,#d6cfbd)}
    .hpw-cancel{width:100%;padding:10px;background:transparent;border:0;color:var(--muted,#7a7466);font:13px "JetBrains Mono",monospace;cursor:pointer}
    .hpw-toast{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);max-width:calc(100vw - 32px);padding:12px 16px;background:var(--ink,#1b1b1b);color:var(--paper,#f4f0e6);font:13px/1.4 "JetBrains Mono",monospace;z-index:1001;box-shadow:0 6px 24px rgba(0,0,0,.3);transition:opacity .2s}
    .hpw-toast.err{background:#c62828;color:#fff}`;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  let toastTimer;
  function toast(text, kind) {
    let el = document.querySelector('.hpw-toast');
    if (!el) { el = document.createElement('div'); el.className = 'hpw-toast'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
    el.textContent = text;
    el.className = `hpw-toast${kind === 'error' ? ' err' : ''}`;
    el.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.style.opacity = '0'; }, kind === 'error' ? 6000 : 3000);
  }

  function sheet(title, text, options) {
    return new Promise((resolve) => {
      const bd = document.createElement('div');
      bd.className = 'hpw-backdrop';
      const box = document.createElement('div');
      box.className = 'hpw-sheet';
      box.setAttribute('role', 'dialog');
      box.innerHTML = `<h3></h3><p></p>`;
      box.querySelector('h3').textContent = title;
      box.querySelector('p').textContent = text;
      const close = (v) => { bd.remove(); resolve(v); };
      for (const o of options) {
        const el = document.createElement(o.href ? 'a' : 'button');
        el.className = 'hpw-opt';
        if (o.href) el.href = o.href; else el.type = 'button';
        el.innerHTML = o.icon ? `<img alt="" src="${o.icon}">` : '';
        el.append(o.label);
        if (!o.href) el.onclick = () => close(o.value);
        box.appendChild(el);
      }
      const cancel = document.createElement('button');
      cancel.className = 'hpw-cancel';
      cancel.type = 'button';
      cancel.textContent = 'Cancel';
      cancel.onclick = () => close(null);
      box.appendChild(cancel);
      bd.appendChild(box);
      bd.onclick = (e) => { if (e.target === bd) close(null); };
      document.body.appendChild(bd);
    });
  }

  function appLinks() {
    const url = location.href;
    const bare = url.replace(/^https?:\/\//, '');
    return [
      { label: 'Open in MetaMask', href: `https://metamask.app.link/dapp/${bare}` },
      { label: 'Open in Coinbase Wallet', href: `https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(url)}` },
      { label: 'Open in Trust Wallet', href: `https://link.trustwallet.com/open_url?coin_id=60&url=${encodeURIComponent(url)}` },
    ];
  }

  // ------------------------------------------------------------ connect
  function friendly(e) {
    if (e?.code === 4001 || e?.code === 'ACTION_REJECTED') return 'You cancelled the request in your wallet.';
    if (e?.code === -32002) return 'Your wallet already has a request open. Open the wallet to finish it.';
    return e?.shortMessage || e?.message || String(e);
  }

  async function pick() {
    const list = await discover();
    if (!list.length) {
      if (isMobile) {
        await sheet('Open in your wallet app', 'This browser has no wallet. Open this page inside your wallet app to continue.', appLinks());
      } else {
        await sheet('No wallet found', 'Install a browser wallet such as MetaMask, then reload this page.', [
          { label: 'Get MetaMask', href: 'https://metamask.io/download/' },
        ]);
      }
      return null;
    }
    if (list.length === 1) return list[0];
    const last = localStorage.getItem(KEY);
    const ordered = [...list].sort((a, b) => (b.info.rdns === last) - (a.info.rdns === last));
    return sheet('Choose a wallet', 'Pick the wallet to connect.', ordered.map((w) => ({ label: w.info.name, icon: w.info.icon, value: w })));
  }

  async function finish(w, accounts) {
    const chainId = parseInt(await w.provider.request({ method: 'eth_chainId' }), 16);
    try { localStorage.setItem(KEY, w.info.rdns); } catch {}
    w.provider.on?.('accountsChanged', () => location.reload());
    w.provider.on?.('chainChanged', () => location.reload());
    return { provider: w.provider, address: accounts[0].toLowerCase(), chainId, name: w.info.name };
  }

  // Ask the user to connect (shows the wallet popup).
  async function connect() {
    const w = await pick();
    if (!w) return null;
    try {
      const accounts = await w.provider.request({ method: 'eth_requestAccounts' });
      if (!accounts?.length) throw new Error('No account was shared.');
      return await finish(w, accounts);
    } catch (e) {
      toast(friendly(e), 'error');
      return null;
    }
  }

  // Reconnect without a popup if this site was already approved in the last-used wallet.
  async function reconnect() {
    let last;
    try { last = localStorage.getItem(KEY); } catch {}
    if (!last) return null;
    const list = await discover();
    const w = list.find((x) => x.info.rdns === last) || (list.length === 1 ? list[0] : null);
    if (!w) return null;
    try {
      const accounts = await w.provider.request({ method: 'eth_accounts' });
      return accounts?.length ? await finish(w, accounts) : null;
    } catch { return null; }
  }

  async function switchChain(provider, hexId, name) {
    try {
      await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hexId }] });
      return true;
    } catch (e) {
      toast(e?.code === 4001 ? 'Network switch cancelled.' : `Switch your wallet to ${name} and try again.`, 'error');
      return false;
    }
  }

  function forget() { try { localStorage.removeItem(KEY); } catch {} }

  window.HPWallet = { connect, reconnect, switchChain, toast, friendly, forget, isMobile };
})();
