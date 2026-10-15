# Brand images

| File | Size | Use |
|---|---|---|
| `hashprints-pfp-print.png` | 1000×1000 | Profile picture (A/P 2, Gold Leaf). Circle-crop safe. |
| `hashprints-pfp-mark.png` | 1000×1000 | Profile picture, H/P monogram. Also the marketplace collection logo. |
| `hashprints-x-header.png` | 1500×500 | X / Twitter header. Text sits clear of the profile picture (bottom left). |
| `hashprints-banner-marketplace.png` | 2800×700 | OpenSea, Magic Eden and similar collection banners (shown at 1400×350). |
| `hashprints-featured.png` | 1200×800 | Marketplace featured / collection card image. |
| `hashprints-og.png` | 1200×630 | Link previews. Also served by the site as `/og.png`. |
| `hashprints-discord-banner.png` | 960×540 | Discord server banner and invite background. |

All art is real HashPrints output: the three artist proofs plus prints drawn from sample seeds with the same renderer as the site.

Rebuild: in `src/`, `npm i @fontsource/jetbrains-mono@5 @fontsource/space-grotesk@5`, copy `site/hashprints.js` next to `brand.html`, then `node render.js` (needs Playwright). Images land in `src/out/`.
