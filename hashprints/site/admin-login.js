  (function () {
    const btn = document.getElementById('signIn');
    const msg = document.getElementById('msg');
    const say = (t, err) => { msg.textContent = t; msg.className = err ? 'msg err' : 'msg'; };
    const session = () => fetch('/api/admin/session', { credentials: 'same-origin', cache: 'no-store' }).then((r) => r.json()).catch(() => ({}));
    // Already signed in on this browser? Go straight to the dashboard.
    session().then((s) => { if (s.signedIn) location.replace('/admin.html'); });
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        say('Connecting…');
        const w = await HPWallet.connect();
        if (!w) { say(''); return; }
        const message = [
          'HashPrints admin sign-in',
          `Domain: ${location.host}`,
          `Address: ${w.address}`,
          `Issued: ${new Date().toISOString()}`,
        ].join('\n');
        say(`Connected ${w.address.slice(0, 6)}…${w.address.slice(-4)}. Sign the message in ${w.name}…`);
        const signer = await new ethers.BrowserProvider(w.provider).getSigner(w.address);
        const signature = await signer.signMessage(message);
        say('Checking…');
        const r = await fetch('/api/admin/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ message, signature }),
        });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.error || `Sign-in failed (${r.status})`);
        const check = await session();
        if (!check.signedIn) {
          throw new Error("Signed in, but this browser didn't keep the sign-in cookie. Allow cookies for this site, or open the page in Safari or Chrome.");
        }
        say('Signed in. Opening the dashboard…');
        location.replace('/admin.html');
      } catch (e) {
        say(HPWallet.friendly(e), true);
      } finally {
        btn.disabled = false;
      }
    };
  })();
