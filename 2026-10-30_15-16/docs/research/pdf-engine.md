# PDF engine for Persian patient documents (issue #3)

Question: which engine should produce one-click PDF downloads from server data, with correct Persian (Arabic-script shaping, right-to-left, mixed Latin digits such as `1,250,000 T`), using the self-hosted Vazirmatn and Geist Mono fonts, with the best visual output and no bugs or security risks.

Convention: this file follows the other files in `docs/` (SETUP.md, TROUBLESHOOTING.md): plain Markdown, English prose, short sections. The folder `docs/research/` did not exist before this ticket.

## Recommendation

Use headless Chromium, driven from the Node server (Puppeteer with the `chrome-headless-shell` build, or Playwright with `--only-shell`), to print the app's own print stylesheet with the same Vazirmatn and Geist Mono `@font-face` files. It is the only candidate that runs the same web text stack (HTML, CSS, `@font-face`, browser shaping and bidi) that the app already uses on screen, so the PDF is expected to match the screen, and its visual output is the highest of the candidates (expected, not tested here). The cost is size (a browser download of roughly 280 MB on Linux before the Debian libraries it needs), memory, and the fact that Chrome's own sandbox does not start cleanly under the app's `cap_drop: ALL` and `no-new-privileges` settings without a verified configuration. For that reason the recommendation is conditional: before adoption, run a short spike that proves the Chrome sandbox starts in the real container with those settings, that rendering makes no network requests, and that peak memory fits 2 GB with concurrency 1. If the spike fails, fall back to Typst (single static binary, no network needed for a template without package imports, no browser), at the cost of writing a separate Typst template instead of reusing the HTML. pdfkit, pdfmake and jsPDF are rejected: none has RTL or Arabic shaping that works in its own documentation, and their RTL issues are still open. The no-dependency baseline (browser Save as PDF) is kept as the always-available fallback, but it is not a one-click server download.

## Comparison table

| Criterion | Headless Chromium (Puppeteer or Playwright) | Typst | Browser Save as PDF (baseline) | pdfkit / pdfmake / jsPDF |
|---|---|---|---|---|
| 1. Persian correctness | Full web text stack: the browser shapes and bidi-orders text, and `@font-face` embeds Vazirmatn. Expected best; not tested here (unverified). | Shaping (rustybuzz) and bidi (unicode-bidi) are in its dependency list. Open RTL issues and one compiler panic on Arabic combining marks (#8667). Not tested with Vazirmatn. | Same as the browser screen. | Rejected: no RTL/shaping support in docs; RTL issues open (pdfkit #219, pdfmake #184, jsPDF #3094 and #2747). |
| 2. Image size and memory | Browser download about 282 MB Linux (Chrome for Testing, full build); headless-shell size unverified. Memory per render unverified; must measure. | Linux musl tarball 17.5 MB (xz). Installed size unverified. Low memory expected. | Zero added. | Small npm packages; not evaluated further. |
| 3. Security | Needs Chrome sandbox; `no-new-privileges` and dropped capabilities may block the setuid helper. User-namespace path may work under Docker default seccomp (unverified). Network blocking possible with request routing and `--network none`. Chrome update burden. | Single binary, no browser, no JavaScript engine. Package imports fetch from the network; without them no network use is expected (unverified for the whole CLI). Update burden small. | No server rendering; PDF produced in staff browser. | Not evaluated beyond correctness, which already rejects them. |
| 4. CSP and no inline script | Print page is served by the app under the same CSP; no inline script needed. Fine. | Not a web page; no CSP concern. | Fine. | Not applicable. |
| 5. Unattended | Runs in server process; needs restart handling for orphaned browser processes (`--init`), and a timeout. | Single process per export; simple. | Needs a person to click. Not one-click. | Not evaluated. |

## Evidence per candidate

### Headless Chromium (Puppeteer or Playwright)

- Puppeteer installs Chrome for Testing by default and stores it in `$HOME/.cache/puppeteer` (since v19). Puppeteer's installation guide gives "~170MB macOS, ~282MB Linux, ~280MB Windows". https://pptr.dev/guides/installation
- Puppeteer v21.6.0 and later also install `chrome-headless-shell`; the old headless mode is only available as the standalone `chrome-headless-shell` since Chrome 132. https://pptr.dev/guides/headless-shell (via https://github.com/puppeteer/puppeteer/blob/main/docs/guides/headless-shell.md, which states that `headless: 'shell'` enables Headless Shell).
- Playwright's browsers page says the browsers "will take a few hundred megabytes of disk space" and its example shows 281M for chromium. It also offers `npx playwright install --with-deps --only-shell` to avoid the full browser. https://playwright.dev/docs/browsers
- Puppeteer's Docker guide says its image "requires the `SYS_ADMIN` capability", with `docker run ... --cap-add=SYS_ADMIN`, and says the image is "meant for running the browser in sandbox mode". This conflicts with `cap_drop: ALL`. https://github.com/puppeteer/puppeteer/blob/main/docs/guides/docker.md
- Puppeteer's troubleshooting page: "Running without a sandbox is **strongly discouraged**." It describes `--no-sandbox` as acceptable only when "you **absolutely trust** the content you open in Chrome." It also says `--cap-add=SYS_ADMIN` may be needed when developing locally. https://pptr.dev/troubleshooting
- Playwright's Docker page: "By default, the Docker image will use the `root` user to run the browsers", which "will disable the Chromium sandbox which is not available with root." It also says "`seccomp_profile.json` is needed to run Chromium with sandbox", and that `--ipc=host` is recommended: "Without it, Chromium can run out of memory and crash." https://playwright.dev/docs/docker
- Docker's seccomp page: the default profile blocks `clone` and `unshare` for new namespaces, "Also gated by `CAP_SYS_ADMIN` for CLONE_* flags, except `CLONE_NEWUSER`", and "You can pass `unconfined` to run a container without the default seccomp profile." This suggests Chrome's user-namespace sandbox may start under the default profile without `SYS_ADMIN`, but this has not been tested (unverified). https://docs.docker.com/engine/security/seccomp/
- Docker's `no-new-privileges` page: "commands that raise privileges such as `su` or `sudo` no longer work." This implies that setuid helper binaries cannot gain privileges. https://docs.docker.com/reference/cli/docker/container/run/#security-opt
- Docker's `none` network driver: "Within the container, only the loopback device is created." Use it for a render-only container if one is split out. https://docs.docker.com/engine/network/drivers/none/
- Network blocking inside Chromium: Playwright's `BrowserContext.route` intercepts every request, and "every request matching the url pattern will stall unless it's continued, fulfilled or aborted." Its `setOffline` only affects "requests that go through the browser's regular network stack." https://playwright.dev/docs/api/class-browsercontext#browser-context-route-from-har
- Print: Puppeteer's `page.pdf()` "Generates a PDF of the page with the `print` CSS media type." It also says that colours are modified for printing by default; `-webkit-print-color-adjust: exact` forces exact colours. https://pptr.dev/api/puppeteer.page.pdf
- Chromium's own sandbox documentation (chromium.googlesource.com) returned 404 when fetched, so the setuid and user-namespace details above are unverified against Chromium's source.

### Typst

- Typst's `text` reference: `dir` accepts `rtl`; "When writing in right-to-left scripts like Arabic or Hebrew, you should set the text language or direction." `script` is set to `auto` by default. Vazirmatn is not mentioned. https://typst.app/docs/reference/text/text/
- Typst's `font` parameter: "When processing text, Typst tries all specified font families in order until it finds a font that has the necessary glyphs." Font search paths are set with `--font-path` or `TYPST_FONT_PATHS`, and `--ignore-system-fonts` disables system fonts. https://typst.app/docs/reference/text/text/
- The Typst Cargo.toml lists `rustybuzz = "0.20"`, `unicode-bidi = "0.3.18"`, `ttf-parser = "0.25.0"`, `fontdb = "0.23"`, and `ureq = "2"` (HTTP client, used for package downloads). https://raw.githubusercontent.com/typst/typst/main/Cargo.toml
- Packages: "The preview namespace contains packages shared by the community." Typst's docs do not describe package downloads, cache or offline options. https://typst.app/docs/reference/scripting/ . Typst's CLI flags `--package-path` and `--package-cache-path` appear only in third-party man pages (unverified as official).
- Release: the latest Typst release is v0.15.1, published 2026-07-17. The Linux musl tarball `typst-x86_64-unknown-linux-musl.tar.xz` is 17,462,992 bytes. https://github.com/typst/typst/releases/tag/v0.15.1 and the GitHub release API for `typst/typst`.
- Open RTL issues: #8500 "Heading numbering not reversed for RTL languages", #8681 "Bullet list secondary marker not ideal in RTL text", #6258 "Having Arabic text at the end of a heading messes with its outline entry", #7280 "Support RTL Typesetting in Math Mode". https://github.com/typst/typst/issues/8500 , https://github.com/typst/typst/issues/8681 , https://github.com/typst/typst/issues/6258 , https://github.com/typst/typst/issues/7280
- Compiler panic: `#par[#text(dir: rtl)[أَمۡ]]` panics in 0.14.0 and 0.15.0 with an index error in `crates/typst-layout/src/inline/shaping.rs`. Arabic letters followed by combining marks trigger it. Open. https://github.com/typst/typst/issues/8667
- PDF text extraction: #4225 (open) says text copy and selection can fail with non-Latin shaping in some viewers (Devanagari example). Not tested for Persian. https://github.com/typst/typst/issues/4225
- Closed Windows Arabic display issue #3086 (platform-dependent output in 2023). https://github.com/typst/typst/issues/3086

### pdfkit, pdfmake, jsPDF

- pdfkit's README: "a PDF document generation library for Node and the browser." It supports TTF, OTF, WOFF, WOFF2 and subsetting. It does not mention RTL, Arabic or bidi, and points to fontkit for "advanced glyph layout support". https://github.com/foliojs/pdfkit
- pdfkit RTL issues: #219 "Right-to-Left (RTL) support for Hebrew and Arabic" (open, 62 comments, last updated 2026-03-08) and #1422 "Random extra space in Arabic multiline texts" (open). https://github.com/foliojs/pdfkit/issues/219 , https://github.com/foliojs/pdfkit/issues/1422
- fontkit's README documents GSUB and GPOS and "`font.layout()`", but says nothing about bidi or line layout. https://github.com/foliojs/fontkit
- pdfmake: no `rtl` property in the styling reference; RTL issue #184 "Right to left language (RTL)" is open (updated 2026-05-11). https://github.com/bpampuch/pdfmake/issues/184 . Closed Arabic issues #315 and #2725 also report LTR order.
- jsPDF's README: the 14 standard fonts "are limited to the ASCII-codepage"; UTF-8 requires a custom font, and "it will show garbled characters instead of the right text" if the font lacks glyphs. It does not mention shaping or RTL. https://github.com/parallax/jsPDF . Open issues #2747 "Alignment issue with Arabic text" and #3867 "Most Arabic fonts not being rendered/painted properly". https://github.com/parallax/jsPDF/issues/2747 , https://github.com/parallax/jsPDF/issues/3867

### Browser Save as PDF (baseline)

- Works with the app's print CSS and needs no dependency, but depends on a staff member choosing the print dialog. Not a one-click server download. Nothing in this research checks Vazirmatn embedding by browsers (unverified).

## Risks

- Chromium sandbox under `cap_drop: ALL` and `no-new-privileges`: may fail to start; the only documented fix in the primary sources is `SYS_ADMIN` or `seccomp=unconfined`, which weakens the container. The spike must decide between user-namespace sandbox under default seccomp, and a separate render container with `--network none`.
- Chrome update burden: a browser build must be pinned and rebuilt on each release; the Puppeteer or Playwright version pins the Chrome version.
- Memory and time on 1 vCPU / 2 GB: no primary figure; measure. Set concurrency to 1, a page timeout, and kill the browser after each export.
- Shared memory: Chromium needs `/dev/shm`; Docker's default size is not verified here, so set it explicitly in compose (unverified figure).
- Typst: open RTL issues and a panic on Arabic combining marks in 0.14 and 0.15; Persian text with diacritics could hit it. Pin the version and test.
- Patient data leaving the server: Chromium rendering must block all requests except the page's own HTML, and must never reach the internet. Use request routing to abort everything and, if possible, `--network none`.
- Persian digits: the HTML route must keep Latin digits in `<bdi>` or `dir="ltr"` spans; `1,250,000 T` mixing needs testing in whichever engine is chosen.

## What the owner must approve

- New dependency: `puppeteer` (or `playwright-core`) in `package.json`. Both are first-party npm packages; this is a new dependency, which requires approval under the project rules.
- New binary: Chrome for Testing headless shell, downloaded at install time into the image. Stated size for the full Chrome for Testing build on Linux is about 282 MB (https://pptr.dev/guides/installation). The headless-shell figure is unverified. Plus Debian shared libraries required by Chrome, size unverified.
- Image size delta: not measured. Estimate 300 MB or more for Chromium, roughly 17.5 MB compressed plus the Typst template work for the Typst fallback. The exact delta must be measured with `docker images` after a build, which was not done here (Docker not run).
- Memory: not measured. Recommend budgeting a fixed 300-500 MB for one render at a time on the 2 GB VPS, with concurrency 1, until the spike gives a real number (unverified).
- Security change: if the spike needs `SYS_ADMIN` or `seccomp=unconfined`, that weakens the app container and needs owner approval; the render-only container option needs owner approval for a second service in `docker-compose.yml`.

## Unverified items

- Whether Chrome's user-namespace sandbox starts under Docker default seccomp with `cap_drop: ALL` and `no-new-privileges` (Chromium source docs returned 404).
- Chrome headless-shell download size and Debian library size.
- Peak memory per PDF render on 1 vCPU / 2 GB.
- Whether Vazirmatn shapes and embeds correctly in each engine (no test run in this ticket).
- Typst PDF font embedding behaviour and Typst's full network behaviour (no official doc found that states them).
- Whether `/dev/shm` default size in Docker is enough for Chromium here.
- Whether `--cap-drop ALL` alone is documented in Docker's run reference (the page only documents `--cap-drop` generally).
- Whether browser Save as PDF embeds Vazirmatn in every browser.
- The Persian review of rendered output: needs a person.
