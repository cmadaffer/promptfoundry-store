// Adds Subscribe ($99/m), Unlock Pro modal, and gating for library content.
// Works without changing your current markup.
// 1) Define window.API_BASE before including this file.
// 2) Include this file at the end of index.html.

(() => {
  const API = window.API_BASE || "";
  const LS_KEY = "pf_license";
  const PREVIEW_LIMIT = 3; // show first N items until unlocked

  const el = (tag, attrs = {}, html) => {
    const x = document.createElement(tag);
    Object.entries(attrs).forEach(([k, v]) => (x[k] = v));
    if (html) x.innerHTML = html;
    return x;
  };

  async function verify(token) {
    if (!token) return false;
    try {
      const r = await fetch(`${API}/api/license/verify?token=${encodeURIComponent(token)}`);
      const j = await r.json();
      return !!j.ok;
    } catch {
      return false;
    }
  }

  function injectTopCtas() {
    // If buttons already exist with ids, reuse; otherwise inject a floating bar.
    const buy = document.getElementById("buyBtn");
    const unlock = document.getElementById("unlockBtn");

    if (!buy || !unlock) {
      const bar = el("div");
      bar.style.cssText =
        "position:fixed;right:16px;bottom:16px;display:flex;gap:8px;z-index:50;align-items:center";
      const b = el("a", { href: "#", id: "pfBuy", className: "pf-btn" }, "Subscribe $99/m");
      const u = el("button", { id: "pfUnlock", className: "pf-btn-sec" }, "Unlock Pro");
      Object.assign(b.style, {
        background:"#82b1ff", color:"#0b0d12", padding:"10px 14px", borderRadius:"10px", fontWeight:"700", textDecoration:"none"
      });
      Object.assign(u.style, {
        background:"#202737", color:"#e8ebf3", padding:"10px 14px", border:"1px solid #2a3245",
        borderRadius:"10px", fontWeight:"700"
      });
      bar.appendChild(b); bar.appendChild(u);
      document.body.appendChild(bar);
      b.addEventListener("click", (e) => { e.preventDefault(); window.location.href = `${API}/api/checkout`; });
      u.addEventListener("click", openUnlock);
    } else {
      buy.onclick = (e) => { e.preventDefault(); window.location.href = `${API}/api/checkout`; };
      unlock.onclick = openUnlock;
    }
  }

  // Modal
  let modal, keyInput, keyMsg;
  function ensureModal() {
    if (modal) return;
    modal = el("div");
    modal.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.55);display:none;place-items:center;z-index:60";
    modal.innerHTML = `
      <div style="width:min(520px,92vw);background:#0e1320;border:1px solid #1c2230;border-radius:16px;padding:20px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <div style="font-weight:700">Unlock Pro</div>
          <button id="pfClose" style="background:none;border:0;color:#9aa3b2;font-size:18px;cursor:pointer">✕</button>
        </div>
        <p style="color:#9aa3b2;margin:6px 0 10px">Paste your license key to unlock the full library.</p>
        <input id="pfKey" placeholder="XXXXXXXXXXXX-XXXXXXXX" style="width:100%;padding:12px;border-radius:10px;border:1px solid #2a3245;background:#0b0f1a;color:#e8ebf3"/>
        <div style="display:flex;gap:8px;margin-top:12px">
          <button id="pfApply" style="background:#82b1ff;color:#0b0d12;border:0;border-radius:10px;padding:10px 14px;font-weight:700">Unlock</button>
          <span id="pfMsg" style="color:#9aa3b2;align-self:center"></span>
        </div>
      </div>`;
    document.body.appendChild(modal);
    keyInput = modal.querySelector("#pfKey");
    keyMsg = modal.querySelector("#pfMsg");
    modal.querySelector("#pfApply").onclick = applyKey;
    modal.querySelector("#pfClose").onclick = () => (modal.style.display = "none");
    modal.addEventListener("click", (e) => { if (e.target === modal) modal.style.display = "none"; });
  }
  function openUnlock() { ensureModal(); keyMsg.textContent=""; keyInput.value=""; modal.style.display = "grid"; keyInput.focus(); }

  async function applyKey() {
    const key = keyInput.value.trim();
    keyMsg.textContent = "Verifying…";
    const ok = await verify(key);
    if (ok) {
      localStorage.setItem(LS_KEY, key);
      keyMsg.textContent = "Unlocked!";
      modal.style.display = "none";
      unlockUI();
    } else {
      keyMsg.textContent = "Invalid or inactive key.";
    }
  }

  function lockUI() {
    // Try to limit library previews to first N items by collapsing the rest.
    // We target common structures: cards/grids with repeated children.
    const grid = document.querySelector("#grid") || document.querySelector(".grid");
    if (grid) {
      const items = Array.from(grid.children);
      items.forEach((el, i) => {
        const body = el.querySelector("pre, .snippet, .prompt, .body, .content") || el;
        if (i >= PREVIEW_LIMIT) {
          el.style.display = "none";
        } else {
          body.style.filter = "blur(5px)";
          body.style.userSelect = "none";
        }
      });
      const pill = document.getElementById("statusPill") || document.getElementById("lockPill");
      if (pill) pill.textContent = "Locked";
    }
  }

  function unlockUI() {
    const grid = document.querySelector("#grid") || document.querySelector(".grid");
    if (grid) {
      const items = Array.from(grid.children);
      items.forEach((el) => {
        const body = el.querySelector("pre, .snippet, .prompt, .body, .content") || el;
        el.style.display = "";
        body.style.filter = "";
        body.style.userSelect = "";
      });
      const pill = document.getElementById("statusPill") || document.getElementById("lockPill");
      if (pill) pill.textContent = "Unlocked";
    }
  }

  async function boot() {
    injectTopCtas();
    const saved = localStorage.getItem(LS_KEY);
    if (await verify(saved)) {
      unlockUI();
    } else {
      lockUI();
    }
  }

  window.addEventListener("DOMContentLoaded", boot);
})();
