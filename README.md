# Semblance

**Find the images that are secretly twins.** Semblance detects duplicate and visually
similar images using perceptual image hashing. Everything runs in the browser — no
server, no upload, no dependencies.

Drop in a set of images and Semblance fingerprints each one, compares every pair, and
shows the matches with a similarity percentage and a bit-level view of *why* they match.

---

## Project structure

```
semblance/
├── index.html      # markup + layout
├── styles.css      # light, colorful theme (design tokens at the top)
├── script.js       # hashing engine + UI logic (no libraries)
└── README.md
```

Four plain files. No build step, no `npm install`, nothing to bundle.

---

## Run it

Open `index.html` in any modern browser. That's it.

For clean local serving (avoids any file:// quirks):

```bash
# from inside the semblance/ folder
python -m http.server 8000
# then visit http://localhost:8000
```

## Deploy to GitHub Pages

1. Push these files to the repo root (or a `/docs` folder).
2. Settings → Pages → Build from branch → `main` / root.
3. Done — it's a static site with zero server requirements.

---

## How the matching works

Each image is reduced to a tiny grayscale thumbnail and turned into a **64-bit
perceptual fingerprint**. Two fingerprints are compared with **Hamming distance**
(how many of the 64 bits differ). Similarity is `(1 − distance / 64) × 100%`.

Three hashing methods are selectable in the UI:

| Method | Grid | Idea | Strength |
|--------|------|------|----------|
| **Average (aHash)** | 8×8 | Each pixel brighter/darker than the mean | Fast; exact & lightly edited copies |
| **Difference (dHash)** | 9×8 | Each pixel vs. its right neighbour | Ignores exposure / lighting shifts |
| **Perceptual (pHash)** | 32×32 → DCT | Low-frequency DCT coefficients vs. their median | Most robust; survives resize & recompression |

Because the fingerprint captures structure rather than raw pixels, a resized or
re-saved image still matches its original at or near 100%.

The signature UI element is the fingerprint grid itself: every image shows its 8×8
hash, and each match shows both grids with the **differing bits highlighted in pink** —
so the similarity score is directly visible, not just asserted.

## Controls

- **Fingerprint** — switch between pHash / dHash / aHash (results update live).
- **Match threshold** — minimum similarity to count as a match (default 85%).
- **Flip-aware** — also match horizontal mirrors of an image (on by default); such
  pairs are tagged **⇄ Mirrored** in the results.
- **Add images** — the toolbar button, drag & drop, click the dropzone, or paste from clipboard.

---

## Implementation notes

- pHash uses a **separable 2D DCT-II** over a 32×32 luma grid, keeping only the
  top-left 8×8 low-frequency block; the median is taken with the DC term excluded.
- Perceptual hashes aren't flip-invariant, so each image is fingerprinted twice
  (normal + mirrored). A pair is compared in both orientations and the better one
  wins, which is what lets **Flip-aware** catch horizontally-mirrored copies.
- Grayscale uses Rec. 601 luma (`0.299R + 0.587G + 0.114B`).
- All hashing runs off a single reused `<canvas>`; all three hashes are precomputed
  once per image on load, so switching methods and thresholds is instant.
- Fully client-side: images are read via object URLs and never leave the device.
- Accessible: keyboard-operable dropzone, visible focus states, `prefers-reduced-motion`
  respected, responsive down to mobile.

**Tech:** HTML, CSS, vanilla JavaScript, Canvas 2D API, perceptual hashing (aHash, dHash, pHash), 2D DCT, Hamming distance