# SwapLabs design and functional QA

**Final result: passed**  
Checked: 2026-10-10  
Visual reference: [relayskills.com](https://relayskills.com/)  
Local implementation: `http://localhost:8000/`

## Visual comparison

- Desktop home, 1440 × 900 CSS pixels: `audits/source-captures/index-desktop.png` compared with `audits/local-captures/home-desktop.png`.
- Mobile home, 390 × 844 CSS pixels: `audits/source-captures/index-mobile.png` compared with `audits/local-captures/home-mobile.png`.
- Supporting mobile views: `audits/local-captures/browse-skills-mobile.png` and `audits/local-captures/login-mobile.png`.
- The header, navigation, hero, typography, spacing, artwork, content sections, and footer adapt selected layout patterns from the RelaySkills site for SwapLabs. The SwapLabs name, supplied logo, and SwapLabs wording remain in place. The live totals reflect the local database. RelaySkills was created after the Design Championship competition.
- The original SwapLabs `logo.jpg`, `credits.html`, `site-credits.html`, and `styles/pages/site-credits.css` match the original files byte for byte.

## Checks performed

- The local health endpoint confirms loopback-only mode with SQLite, local media storage, and local study-room services.
- The smoke check passes for all 76 HTML pages, page assets, stylesheet resources, and same-site links and fragments.
- No page automatically loads remote scripts, stylesheets, fonts, images, or icons.
- A 390-pixel mobile scan found no horizontal overflow across the 76 routes. Browser console error count was zero.
- In the browser, the mobile navigation opens, skill search returns matching cards, category filtering works, and Reset restores the unfiltered list.
- The logo and protected credits/acknowledgement file hashes are also checked by `tests/local_functional.py`.

## Local-only feature limits

Google sign-in and outbound email are disabled. Password recovery displays its code in the local page. Calls use direct local or peer-to-peer connections; calling between devices on separate networks may require a TURN relay, which is not configured here.

The original development folder contains a copy of local account data and uploaded files and must stay private. That private data is excluded from the public source package.
