# FeedBlocker publishing assets

Prepared 31 October 2026. Product name: **FeedBlocker**. Filenames use `feedblocker-<purpose>-<size>` in lowercase. The artwork uses the shipped icon, Segoe UI/system typography, flat neutral surfaces, blue `#0060df` and dark-mode cyan `#80ebff`. No gradients, mascots, slogans about productivity, or third-party logos.

## Upload files

| Purpose | File |
| --- | --- |
| Extension ZIP | `../dist/feedblocker-1.0.0.zip` |
| Listing icon | `icons/feedblocker-icon-64.png` (32 px alternative included) |
| Screenshot 1 | `screenshots/feedblocker-01-youtube-light-1280x800.png` |
| Screenshot 2 | `screenshots/feedblocker-02-youtube-options-dark-1280x800.png` |
| Screenshot 3 | `screenshots/feedblocker-03-reddit-light-1280x800.png` |
| Screenshot 4 | `screenshots/feedblocker-04-linkedin-beta-dark-1280x800.png` |
| Listing fields and captions | `amo-listing.txt` |
| Privacy policy | `privacy-policy.txt` |

The 128, 256 and 512 px icons are extra exports. `promotional/` contains an optional 1200 × 630 social image and 1600 × 900 banner; these are not required AMO extension fields. Do not substitute them for the plain UI screenshots. `source/` includes the icon SVG, popup captures and editable promotional HTML.

## What the screenshots show

Screenshots render the actual `popup.html`, `popup.css`, `popup.js` and rule data in headless Edge with fixture WebExtension APIs. The fixture enables YouTube, Reddit and LinkedIn and grants site access for preview. Screenshots contain the complete popup content, including content that normally requires scrolling within Firefox's popup. They are not captures of a loaded Firefox add-on or evidence of live-site compatibility. Captions disclose the sample settings. No website content or accounts are fabricated.

Regenerate with `node tools/marketing.cjs`. This development tool needs `playwright`, `sharp` and installed Microsoft Edge. If packages are installed outside the project, set `NODE_PATH` to their node_modules directory first. These dependencies and fixtures are never included in the extension ZIP.

## Mozilla requirements checked

- Mozilla's listing guide specifies PNG/JPEG icons at 32 × 32 and 64 × 64, recommends 1280 × 800 screenshots (1.6:1), and limits the summary to 250 characters. It recommends keeping explanatory copy in captions rather than overlaying text on screenshots. [Listing guide](https://extensionworkshop.com/documentation/develop/create-an-appealing-listing/)
- The submission flow asks for a ZIP, compatible platforms, listing text, up to two categories, support contacts, a licence and reviewer notes. Its extension flow does not specify a required promotional banner. [Submission guide](https://extensionworkshop.com/documentation/publish/submitting-an-add-on/)
- Unreadable generated or transformed code may require a separate source submission. This project includes readable generated CSS and JS; provide the original rule JSON and `tools/build.js` if requested. [Source submission](https://extensionworkshop.com/documentation/publish/source-code-submission/)

## Publish

1. Run `pwsh -NoProfile -File tools/package.ps1` from the project directory. This rebuilds, tests, checks and packages only runtime files plus the licence. Marketing, development tools and Git files stay outside the ZIP.
2. Before removing the experimental label, load the ZIP's contents through Firefox `about:debugging`, then verify permissions, toggles, pause/resume, Show once and SPA navigation. Check playback, composers and search on each site. Live-site checks are still outstanding. Test Android before selecting it for distribution.
3. Sign in to [AMO Developer Hub](https://addons.mozilla.org/developers/) and submit a new add-on for listing on AMO. Upload the ZIP and resolve any validator findings.
4. Paste fields from `amo-listing.txt`, the privacy policy and reviewer notes. Keep the experimental setting for this initial public beta. Choose supported desktop platforms; Android is untested.
5. Add the 64 px icon and four screenshots in numbered order with their captions. Submit for Mozilla signing/review. The local ZIP is unsigned and is not a permanent-install package.

The manifest ID is `chuumberry@gmail.com`, as requested. An add-on ID is a stable identifier, separate from the listing's support email. Keep it unchanged for future releases of this add-on.
