/* ============================================================
   SEMBLANCE
   Duplicate & near-duplicate image detection via perceptual hashing.
   Runs entirely in the browser. Nothing is uploaded anywhere.
   ============================================================ */
(() => {
  "use strict";

  /* ---------- state ---------- */
  const store = [];
  let algo = "p";           // 'a' | 'd' | 'p'
  let threshold = 85;
  let flipAware = true;     // also match horizontal mirrors
  let nextId = 1;
  let lastPairs = null;

  /* ---------- refs ---------- */
  const $ = (id) => document.getElementById(id);
  const fileInput    = $("file-input");
  const dropzone     = $("dropzone");
  const libraryGrid  = $("library-grid");
  const libraryEmpty = $("library-empty");
  const libCount     = $("lib-count");
  const selectAllBtn = $("select-all");
  const resultsList  = $("results-list");
  const resultsEmpty = $("results-empty");
  const resultsEmptyText = $("results-empty-text");
  const resCount     = $("res-count");
  const addBtn       = $("add");
  const clearBtn     = $("clear");
  const flipToggle   = $("flip-toggle");
  const thresholdIn  = $("threshold");
  const thresholdVal = $("threshold-val");

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  /* ============================================================
     Hashing core (verified against a reference DCT)
     ============================================================ */
  // Draw the image (optionally horizontally mirrored) and return Rec.601 luma.
  function toGray(img, w, h, mirror) {
    canvas.width = w; canvas.height = h;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (mirror) { ctx.translate(w, 0); ctx.scale(-1, 1); }
    ctx.drawImage(img, 0, 0, w, h);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const data = ctx.getImageData(0, 0, w, h).data;
    const gray = new Float64Array(w * h);
    for (let i = 0; i < w * h; i++) {
      gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    }
    return gray;
  }

  function aHash(img, mirror) {
    const g = toGray(img, 8, 8, mirror);
    let avg = 0; for (let i = 0; i < 64; i++) avg += g[i]; avg /= 64;
    let bits = ""; for (let i = 0; i < 64; i++) bits += g[i] > avg ? "1" : "0";
    return bits;
  }

  function dHash(img, mirror) {
    const g = toGray(img, 9, 8, mirror);
    let bits = "";
    for (let row = 0; row < 8; row++)
      for (let col = 0; col < 8; col++)
        bits += g[row * 9 + col] > g[row * 9 + col + 1] ? "1" : "0";
    return bits;
  }

  const N = 32;
  const cosTable = (() => {
    const t = new Array(N);
    for (let u = 0; u < N; u++) {
      t[u] = new Float64Array(N);
      for (let x = 0; x < N; x++) t[u][x] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * N));
    }
    return t;
  })();

  function dctTopLeft(pixels) {
    const tmp = new Float64Array(N * 8);
    for (let x = 0; x < N; x++)
      for (let v = 0; v < 8; v++) {
        let sum = 0; const row = x * N;
        for (let y = 0; y < N; y++) sum += pixels[row + y] * cosTable[v][y];
        tmp[x * 8 + v] = sum;
      }
    const out = new Float64Array(64);
    for (let u = 0; u < 8; u++)
      for (let v = 0; v < 8; v++) {
        let sum = 0;
        for (let x = 0; x < N; x++) sum += tmp[x * 8 + v] * cosTable[u][x];
        const cu = u === 0 ? Math.SQRT1_2 : 1;
        const cv = v === 0 ? Math.SQRT1_2 : 1;
        out[u * 8 + v] = 0.25 * cu * cv * sum;
      }
    return out;
  }

  function pHash(img, mirror) {
    const g = toGray(img, N, N, mirror);
    const dct = dctTopLeft(g);
    const sorted = Array.from(dct.slice(1)).sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    let bits = "";
    for (let i = 0; i < 64; i++) bits += dct[i] > median ? "1" : "0";
    return bits;
  }

  function hamming(a, b) { let d = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++; return d; }
  function similarity(a, b) { return (1 - hamming(a, b) / a.length) * 100; }

  /* ============================================================
     Loading
     ============================================================ */

  // Fast content fingerprint of the raw file bytes (FNV-1a + length).
  // Two images are the *same file* only if these match — this is what
  // distinguishes a true exact duplicate from a mere perceptual match.
  function byteSignature(buffer) {
    const bytes = new Uint8Array(buffer);
    let h = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) {
      h ^= bytes[i];
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16) + ":" + bytes.length;
  }

  async function loadImage(file) {
    const buffer = await file.arrayBuffer();
    const byteHash = byteSignature(buffer);
    const url = URL.createObjectURL(file);
    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => { URL.revokeObjectURL(url); reject(new Error("bad image")); };
      im.src = url;
    });
    return {
      id: nextId++, name: file.name || "pasted-image", size: file.size || 0,
      selected: true,
      w: img.naturalWidth, h: img.naturalHeight, url, byteHash,
      hashes:  { a: aHash(img),       d: dHash(img),       p: pHash(img) },
      hashesM: { a: aHash(img, true), d: dHash(img, true), p: pHash(img, true) },
    };
  }

  async function ingest(fileList) {
    const images = Array.from(fileList).filter((f) => f.type.startsWith("image/"));
    if (!images.length) return;
    for (const file of images) {
      try { store.push(await loadImage(file)); } catch { /* skip unreadable */ }
    }
    render();
    autoMatch();
  }

  /* ============================================================
     Matching
     ============================================================ */
  function computeMatches() {
    const active = store.filter((s) => s.selected);
    const pairs = [];
    for (let i = 0; i < active.length; i++)
      for (let j = i + 1; j < active.length; j++) {
        const A = active[i], B = active[j];
        let sim = similarity(A.hashes[algo], B.hashes[algo]);
        let mirrored = false;
        // A perceptual hash isn't flip-invariant, so compare A against B's
        // mirrored fingerprint too and keep whichever orientation fits best.
        if (flipAware) {
          const simFlip = similarity(A.hashes[algo], B.hashesM[algo]);
          if (simFlip > sim) { sim = simFlip; mirrored = true; }
        }
        if (sim >= threshold) pairs.push({ A, B, sim, mirrored });
      }
    pairs.sort((x, y) => y.sim - x.sim);
    return pairs;
  }

  function selectedCount() { return store.reduce((n, s) => n + (s.selected ? 1 : 0), 0); }

  function autoMatch() {
    if (selectedCount() < 2) { lastPairs = null; renderResults(null); return; }
    lastPairs = computeMatches();
    renderResults(lastPairs);
  }

  /* ============================================================
     Rendering
     ============================================================ */
  function fmtSize(b) {
    if (!b) return "—";
    if (b < 1024) return b + " B";
    if (b < 1048576) return (b / 1024).toFixed(0) + " KB";
    return (b / 1048576).toFixed(1) + " MB";
  }

  function hashGrid(bits, large, diffAgainst) {
    const grid = document.createElement("div");
    grid.className = "hashgrid" + (large ? " hashgrid--lg" : "");
    for (let i = 0; i < 64; i++) {
      const cell = document.createElement("i");
      if (diffAgainst && bits[i] !== diffAgainst[i]) cell.className = "diff";
      else if (bits[i] === "1") cell.className = "on";
      grid.appendChild(cell);
    }
    return grid;
  }

  // Classify a pair. A true "Exact duplicate" requires identical file bytes;
  // an identical *fingerprint* on differing files is a resized/re-encoded copy.
  // Below ~80% on a 64-bit hash the signal is weak (unrelated images already
  // agree on ~50% of bits by chance), so those are flagged rather than trusted.
  function classify(A, B, sim) {
    if (A.byteHash === B.byteHash) return { name: "Exact duplicate", key: "exact" };
    if (sim >= 99.95)             return { name: "Identical look", key: "exact" };
    if (sim >= 92)                return { name: "Near-identical", key: "high" };
    if (sim >= 84)                return { name: "Very similar", key: "mid" };
    if (sim >= 80)                return { name: "Similar", key: "low" };
    return { name: "Weak — likely unrelated", key: "weak" };
  }

  function renderLibrary() {
    libraryGrid.replaceChildren();
    libraryEmpty.hidden = store.length > 0;
    for (const item of store) {
      const card = document.createElement("div");
      card.className = "card" + (item.selected ? "" : " is-deselected");

      const thumb = document.createElement("div");
      thumb.className = "card__thumb";
      const img = document.createElement("img");
      img.src = item.url; img.alt = item.name; img.loading = "lazy";
      thumb.appendChild(img);

      const pick = document.createElement("label");
      pick.className = "card__pick";
      pick.title = "Include this image when finding matches";
      const cb = document.createElement("input");
      cb.type = "checkbox"; cb.checked = item.selected;
      cb.setAttribute("aria-label", "Include " + item.name + " in matching");
      cb.addEventListener("change", () => {
        item.selected = cb.checked;
        render(); autoMatch();
      });
      const box = document.createElement("span");
      box.className = "card__pick-box"; box.setAttribute("aria-hidden", "true");
      pick.append(cb, box);
      thumb.appendChild(pick);

      const remove = document.createElement("button");
      remove.className = "card__remove"; remove.type = "button";
      remove.setAttribute("aria-label", "Remove " + item.name);
      remove.textContent = "×";
      remove.addEventListener("click", () => {
        URL.revokeObjectURL(item.url);
        const idx = store.findIndex((s) => s.id === item.id);
        if (idx > -1) store.splice(idx, 1);
        render(); autoMatch();
      });
      thumb.appendChild(remove);

      const body = document.createElement("div");
      body.className = "card__body";
      body.appendChild(hashGrid(item.hashes[algo], false));
      const label = document.createElement("div");
      label.style.minWidth = "0"; label.style.flex = "1";
      const name = document.createElement("div");
      name.className = "card__name"; name.textContent = item.name; name.title = item.name;
      const meta = document.createElement("div");
      meta.className = "card__meta"; meta.textContent = `${item.w}×${item.h} · ${fmtSize(item.size)}`;
      label.append(name, meta);
      body.appendChild(label);

      card.append(thumb, body);
      libraryGrid.appendChild(card);
    }
    const n = store.length;
    const sel = selectedCount();
    libCount.textContent = n === 0
      ? "no images yet"
      : `${sel} of ${n} selected`;
    clearBtn.disabled = n === 0;
    if (selectAllBtn) {
      selectAllBtn.hidden = n === 0;
      const allOn = sel === n;
      selectAllBtn.textContent = allOn ? "Deselect all" : "Select all";
      selectAllBtn.setAttribute("aria-pressed", String(allOn));
    }
  }

  function pairSide(item, right) {
    const side = document.createElement("div");
    side.className = "pair__img" + (right ? " pair__img--right" : "");
    const thumb = document.createElement("img");
    thumb.className = "pair__thumb"; thumb.src = item.url; thumb.alt = item.name; thumb.loading = "lazy";
    const label = document.createElement("div");
    label.className = "pair__label";
    const fn = document.createElement("div");
    fn.className = "pair__filename"; fn.textContent = item.name; fn.title = item.name;
    const fd = document.createElement("div");
    fd.className = "pair__filedata"; fd.textContent = `${item.w}×${item.h} · ${fmtSize(item.size)}`;
    label.append(fn, fd);
    side.append(thumb, label);
    return side;
  }

  function renderResults(pairs) {
    resultsList.replaceChildren();

    if (!pairs) {
      resultsEmpty.hidden = false;
      resultsEmptyText.textContent = selectedCount() < 2
        ? "Select at least two images and matches will show up here automatically."
        : "Matches will appear here as you add images.";
      resCount.textContent = selectedCount() < 2 ? "—" : "0 matches";
      return;
    }

    const exact = pairs.filter((p) => p.A.byteHash === p.B.byteHash).length;
    const method = algo === "p" ? "pHash" : algo === "d" ? "dHash" : "aHash";
    resCount.textContent = `${pairs.length} match${pairs.length === 1 ? "" : "es"} · ${exact} exact · ${method}`;

    if (!pairs.length) {
      resultsEmpty.hidden = false;
      resultsEmptyText.textContent =
        "No pairs cross the " + threshold + "% threshold. Lower it, or switch fingerprint methods.";
      return;
    }
    resultsEmpty.hidden = true;

    for (const { A, B, sim, mirrored } of pairs) {
      // For a mirrored match, compare against B's flipped fingerprint so the
      // score, bit count and diff grid all describe the same orientation.
      const bHash = mirrored ? B.hashesM[algo] : B.hashes[algo];
      const t = classify(A, B, sim);
      const pair = document.createElement("div");
      pair.className = "pair";

      pair.appendChild(pairSide(A, false));

      const center = document.createElement("div");
      center.className = "pair__center";
      const score = document.createElement("div");
      score.className = "pair__score tone-" + t.key;
      score.textContent = sim.toFixed(1) + "%";
      const badge = document.createElement("div");
      badge.className = "pair__badge tone-" + t.key + "-bg";
      badge.textContent = t.name;
      let flag = null;
      if (mirrored) {
        flag = document.createElement("div");
        flag.className = "pair__flag";
        flag.textContent = "⇄ Mirrored";
      }
      const bar = document.createElement("div");
      bar.className = "pair__bar";
      const fill = document.createElement("span");
      fill.className = "tone-" + t.key + "-fill";
      fill.style.width = "0%";
      requestAnimationFrame(() => { fill.style.width = sim.toFixed(1) + "%"; });
      bar.appendChild(fill);
      center.append(score, badge, ...(flag ? [flag] : []), bar);
      pair.appendChild(center);

      pair.appendChild(pairSide(B, true));

      const diff = document.createElement("div");
      diff.className = "pair__diff";
      const bitsDiff = hamming(A.hashes[algo], bHash);
      diff.appendChild(hashGrid(A.hashes[algo], true, bHash));
      const cap = document.createElement("div");
      cap.className = "pair__diff-cap";
      if (A.byteHash === B.byteHash) {
        cap.innerHTML = "same file — <b>byte-for-byte identical</b>";
      } else if (bitsDiff === 0) {
        cap.innerHTML = mirrored
          ? "identical <b>mirror-image</b> fingerprint"
          : "identical fingerprint — a <b>resized or re-encoded</b> copy";
      } else {
        cap.innerHTML = `<b>${bitsDiff} / 64</b> bits differ${mirrored ? " (mirrored)" : ""}`;
      }
      diff.appendChild(cap);
      diff.appendChild(hashGrid(bHash, true, A.hashes[algo]));
      pair.appendChild(diff);

      resultsList.appendChild(pair);
    }
  }

  function render() {
    renderLibrary();
    if (lastPairs) renderResults(lastPairs);
  }

  /* ============================================================
     Events
     ============================================================ */

  // --- upload (single, reliable trigger) ---
  dropzone.addEventListener("click", () => fileInput.click());
  dropzone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); }
  });
  fileInput.addEventListener("change", (e) => {
    const files = Array.from(e.target.files || []); // capture before clearing
    fileInput.value = "";
    ingest(files);
  });

  ["dragenter", "dragover"].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add("is-drag"); }));
  ["dragleave", "drop"].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      if (ev === "dragleave" && dropzone.contains(e.relatedTarget)) return;
      dropzone.classList.remove("is-drag");
    }));
  dropzone.addEventListener("drop", (e) => {
    if (e.dataTransfer?.files?.length) ingest(e.dataTransfer.files);
  });

  window.addEventListener("paste", (e) => {
    const files = Array.from(e.clipboardData?.files || []);
    if (files.length) ingest(files);
  });

  // --- algorithm switch ---
  document.querySelectorAll(".segmented__opt").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".segmented__opt").forEach((b) => {
        b.classList.remove("is-active"); b.setAttribute("aria-checked", "false");
      });
      btn.classList.add("is-active"); btn.setAttribute("aria-checked", "true");
      algo = btn.dataset.algo;
      render(); autoMatch();
    });
  });

  // --- threshold ---
  thresholdIn.addEventListener("input", () => {
    threshold = Number(thresholdIn.value);
    thresholdVal.textContent = threshold + "%";
  });
  thresholdIn.addEventListener("change", autoMatch);

  // --- flip-aware toggle ---
  flipToggle.addEventListener("click", () => {
    flipAware = !flipAware;
    flipToggle.classList.toggle("is-on", flipAware);
    flipToggle.setAttribute("aria-checked", String(flipAware));
    autoMatch();
  });

  // --- buttons ---
  addBtn.addEventListener("click", () => fileInput.click());
  clearBtn.addEventListener("click", () => {
    store.forEach((s) => URL.revokeObjectURL(s.url));
    store.length = 0; lastPairs = null;
    render(); renderResults(null);
  });

  // --- select / deselect all ---
  selectAllBtn.addEventListener("click", () => {
    const turnOn = selectedCount() < store.length; // any off → select all, else deselect all
    store.forEach((s) => { s.selected = turnOn; });
    render(); autoMatch();
  });

  // --- how-it-works modal ---
  const howModal = $("how-modal");
  const openModal = () => { howModal.hidden = false; $("how-close").focus(); };
  const closeModal = () => { howModal.hidden = true; $("how-open").focus(); };
  $("how-open").addEventListener("click", openModal);
  $("how-close").addEventListener("click", closeModal);
  howModal.querySelector("[data-close]").addEventListener("click", closeModal);
  window.addEventListener("keydown", (e) => { if (e.key === "Escape" && !howModal.hidden) closeModal(); });

  // initial paint
  render();
  renderResults(null);
})();