# SPEC-001.5 — Aurora Visual System

## Status

Implemented and accepted for the manual checks that were performed. Separate measurements at window widths 760px, 880px, and 1280px were not recorded, so those widths are not marked passed individually. Parent specification: [SPEC-000.3-shell.md](SPEC-000.3-shell.md). Mail behavior stays in [SPEC-001.3-gmail-reader.md](SPEC-001.3-gmail-reader.md). SPEC-001.4 is not this document and is not started here.

## Goal

Make Aurora read as a desktop application. Keep the Aurora name, the dark and light palette, and the northern-lights accent. Improve hierarchy, density, typography, and icon coverage without a new UI framework.

## Non-goals

No Gmail write, label change, send, archive, delete, or mark-as-read. No OAuth change and no new scope. No change to Electron sandbox, context isolation, disabled Node integration, web security, the navigation block, denied `window.open`, or either content security policy. No remote font request. No new IPC channel, database, or migration. No shadcn-vue, Reka UI, Pinia, or other component framework. Font Awesome is not added. MIME decoding, HTML sanitization, and snippet text stay in SPEC-001.3.

## Decisions

- Two families only. Outfit is the display face. Inter is the UI and reading face.
- Both families are variable fonts, bundled in the renderer from `@fontsource-variable/outfit` and `@fontsource-variable/inter`. The license is SIL Open Font License 1.1. The files ship with the app. `font-src 'self'` already allows them. `fonts.googleapis.com` is not used.
- Icons stay on `@lucide/vue`, already installed. One stroke width, two sizes, `currentColor`.
- Colors, radii, and the 2px accent focus ring stay as specified in SPEC-000.3. New pairs are measured before they ship. A pair that fails the contrast rules below is not added.
- Dashboard, Integrations, and Settings keep the 720px column. Mail keeps the width of `main`.
- The shared shell padding stays 32px. Mail may not add a second horizontal inset inside that padding.

## Typography

The packaged `@font-face` family names are `Outfit Variable` and `Inter Variable`. `--font-display` is `'Outfit Variable', 'Outfit', sans-serif`. `--font-sans` is `'Inter Variable', 'Inter', system-ui, sans-serif`. The Segoe UI stack is removed. A missing file falls back to the next family. Spanish uses the Latin ranges. Characters outside those ranges use the fallback face for that glyph only. The packages are development dependencies at `5.3.0`, so electron-builder does not copy `node_modules` into `app.asar`.

| Use                       | Family | Size | Weight | Line height | Tracking |
| ------------------------- | ------ | ---- | ------ | ----------- | -------- |
| Wordmark                  | Outfit | 22px | 600    | 1.1         | 0.06em   |
| Page title                | Outfit | 28px | 560    | 1.2         | -0.02em  |
| Open subject              | Inter  | 18px | 600    | 1.35        | 0        |
| Unread sender and subject | Inter  | 14px | 600    | 1.4         | 0        |
| Interface text            | Inter  | 14px | 400    | 1.45        | 0        |
| Email reading             | Inter  | 15px | 400    | 1.6         | 0        |
| Metadata                  | Inter  | 12px | 400    | 1.4         | 0        |

Page titles are Dashboard, Integrations, and Settings. The Mail list may show the title Mail. An open conversation does not show that title.

Outfit is used for the wordmark and page titles only. Inter is used for navigation, forms, inbox rows, metadata, status copy, and email text. Email HTML does not choose its own family. The reading container sets Inter. The sanitizer allowlist is unchanged, so a message still cannot set `style` or a font face.

## Wordmark

The product name remains Aurora. In the 232px sidebar the wordmark sits 20px below the top of the window and 16px from the sidebar's left edge. A 3 by 18px accent bar, with a full radius, sits 8px to the left of the word. The bar is decorative and `aria-hidden`. The word is text, so the accessible name is Aurora.

Below the 880px shell breakpoint the sidebar is the existing 64px rail. The wordmark is visually hidden and stays in the accessibility tree.

## Icons

Lucide is the only icon set. Decorative icons are `aria-hidden`. A control that has no visible text has an accessible name.

| Place                                      | Size | Stroke |
| ------------------------------------------ | ---- | ------ |
| Navigation, folders, rows, buttons, fields | 16px | 1.75   |
| Empty, loading, and error status           | 20px | 1.75   |

Color is `currentColor`, aligned to the text cap height, with no extra optical gap beyond the existing 12px row gap.

| Control                                              | Icon                                                              |
| ---------------------------------------------------- | ----------------------------------------------------------------- |
| Dashboard, Mail, Integrations, Settings              | `LayoutDashboard`, `Mail`, `Blocks`, `Settings`                   |
| Inbox, Sent, Drafts, Spam, Trash, Starred, Important | `Inbox`, `Send`, `File`, `AlertOctagon`, `Trash2`, `Star`, `Flag` |
| User label                                           | `Tag`                                                             |
| Search                                               | `Search`, inside the field                                        |
| Back                                                 | `ChevronLeft`                                                     |
| Account select                                       | `ChevronsUpDown`                                                  |
| Attachment                                           | `Paperclip`                                                       |
| Loading, empty, error                                | `LoaderCircle`, `Inbox`, `CircleAlert`                            |

`LoaderCircle` does not animate. Status icons do not replace the existing `role` and `aria-busy` behavior of `StatusPanel`.

## Tokens

Spacing for shell, mail, and status layout uses 4, 8, 12, 16, 24, and 32px. Radii stay 6, 10, and 14px. Control height stays 40px. Inbox row height is 56px, including a 1px bottom border. The reading measure is at most 680px. The folder column is 200px.

Controls share classes in `tokens.css`: `.nav-link`, `.control`, `.control-accent`, `.control-danger`, `.field`, `.field-text`, `.field-select`, `.text-link`, and `.choice`. Height stays 40px and radius stays 10px. The focus ring is a 2px solid accent outline with a 2px offset, on `:focus-visible` only. A clickable control uses `cursor: pointer` and a visible hover. A selected navigation item (`.router-link-exact-active`) and a selected folder (`aria-pressed="true"`) keep the accent fill after the pointer leaves, including on hover and active. A disabled control uses `cursor: default` and does not use the pointer. A control with `aria-busy="true"` uses `cursor: progress`. Hover is not the only sign of interactivity. Non-interactive panels, headings, and the search field do not use the pointer. The account select stays enabled while Mail is loading so a newer account selection can supersede the in-flight list. Search and folder buttons are disabled during that load.

`StatusPanel` remains the only loading, empty, and error surface. It gains a 20px icon and keeps its border, title, and message. Dashboard, Integrations, Settings, and Mail all use it.

## Mail layout

The account select, search field, and Search button stay on one 40px row at every width in this specification. Search submits on Enter, as it does now.

System folders are listed in the SPEC-001.3 order, then user labels. Each folder is a button with an icon, the label name, and the unread count when SPEC-001.3 provides one. The active folder uses the accent fill. Long names truncate. The count is metadata size.

The folder column is 200px and sits in `main` only when `main` is at least 960px wide. `main` is the area to the right of the Aurora sidebar, before the 32px shell padding. Below 960px the folders are one horizontal row, 40px tall, `flex-nowrap`, with horizontal scrolling. They do not wrap onto a second line.

Inbox cards are removed. A row is 56px, full width, with a 1px border on the bottom and no separate card radius. The columns are an 8px unread marker, a 180px sender, one shared line for subject and snippet, and a 112px date aligned to the end. Subject and snippet are separated on that line. Truncation is single-line. Hover uses the surface color. The row remains a button.

Unread is font weight 600 on the sender and the subject, plus the 8px filled circle. The circle may use the accent color, and the row's accessible name includes Unread. A read row is weight 400, has no circle, and does not say Unread. Weight and the accessible name still convey the state when color is removed.

Opening a conversation hides the account select, the search row, and the folders. The conversation header is 48px: a Back button with `ChevronLeft` and the accessible name Back, the subject at 18px, and the date. Message metadata is one line: From, and To when present. Cc and Bcc stay on that line when present. The line can be expanded. It does not become a stack of paragraphs. Messages in the conversation keep their current order and security rules.

## Email reading

Sanitized HTML is painted inside one container class. The rules are descendants of that class. They set the family, 15px size, 1.6 line height, and text color on the container. Paragraphs that are not inside a table get `0.75em` vertical margin. Links use the accent color and stay underlined. The container uses `overflow-x: auto`.

The reading CSS does not set `display`, `width`, `max-width`, `table-layout`, or `border-collapse` on `table`, `thead`, `tbody`, `tr`, `th`, or `td`. It does not remove empty cells. A wide table scrolls inside the container. The 680px measure limits the text column, not a table that is wider than that measure. The sanitizer continues to drop `style`, `width`, and `src`. This specification does not change that allowlist.

## Available width

The sidebar widths are unchanged: 64px below 880px window width, 232px at 880px and above. The minimum window is 760 by 560. The default window is 1120 by 740.

| Window width | Sidebar | `main` width | Folder presentation  |
| ------------ | ------- | ------------ | -------------------- |
| 760px        | 64px    | 696px        | One non-wrapping row |
| 880px        | 232px   | 648px        | One non-wrapping row |
| 1280px       | 232px   | 1048px       | 200px column         |

At 760px and 880px, `main` is below 960px, so a 200px column is not shown. At 1280px, `main` is 1048px, so the column is shown and the list uses the remaining width. Shell padding of 32px on each side still applies. The row's sender, subject, and date stay on one line at all three widths. The sender column may shrink below 180px only when the padded content width is below 520px. At these three widths it stays 180px.

## Contrast, focus, and names

Normal text remains at least 4.5:1. The focus ring and any non-text indicator, including the unread circle, remain at least 3:1 against the adjacent surface. The SPEC-000.3 pairs stay valid because the palette is unchanged. The unread circle is the existing accent on canvas or on surface. Ratios below use the WCAG relative-luminance formula. No new palette color was added.

| Pair                         | Colors                 | Ratio   |
| ---------------------------- | ---------------------- | ------- |
| Accent on canvas, light      | `#1f4d45` on `#f6f5f3` | 8.74:1  |
| Accent on surface, light     | `#1f4d45` on `#fffcf8` | 9.31:1  |
| Accent on canvas, dark       | `#8fbfb3` on `#141513` | 8.96:1  |
| Accent on surface, dark      | `#8fbfb3` on `#1c1d1a` | 8.28:1  |
| Accent text on accent, light | `#f7f6f3` on `#1f4d45` | 8.81:1  |
| Accent text on accent, dark  | `#10211d` on `#8fbfb3` | 8.17:1  |
| Text on canvas, light        | `#1c1b19` on `#f6f5f3` | 15.80:1 |
| Muted on canvas, light       | `#6b6760` on `#f6f5f3` | 5.16:1  |
| Text on canvas, dark         | `#eceae4` on `#141513` | 15.23:1 |
| Muted on canvas, dark        | `#a39e94` on `#141513` | 6.87:1  |

Tab order is the browser order. There is no arrow-key roving tabindex. Folder buttons, inbox rows, Back, Search, and the account select show the 2px focus ring. Icon-only controls expose a name to assistive technology. Visible text and the icon's accessible name are not duplicated into two announcements.

## Acceptance

Measured at window widths 760px, 880px, and 1280px, with a window height of 800px unless a criterion names another height.

- The wordmark is 22px Outfit, 20px from the top and 16px from the left, when the sidebar is 232px. At 760px the sidebar is 64px and the name remains available to assistive technology.
- Page titles on Dashboard, Integrations, and Settings are 28px Outfit. Navigation, forms, rows, and metadata are Inter.
- With the network disabled, both families still load from the app bundle. The document requests no font from another origin.
- Every primary navigation item, folder, search field, Back button, and account control has a visible Lucide icon of the size in the table above. Decorative icons are hidden from assistive technology. Icon-only controls have a name.
- Inbox rows are 56px. At all three widths, with an 800px window height, at least 10 full rows are visible without scrolling the list. Subject, sender, date, and snippet each have one line. At a window height of 560px the list scrolls inside `main` and a row does not grow past 56px.
- Unread rows use weight 600, the circle, and an accessible name that includes Unread. Read rows do not. A grayscale capture still distinguishes the two states by weight and by the circle's presence.
- At 760px and 880px the folders occupy one 40px row and do not wrap. At 1280px they occupy a 200px column. The account and search controls remain one row at all three widths.
- An open conversation hides the account select, search, and folders. Back, the subject, and the date share the 48px header. The reading column is at most 680px.
- A message whose HTML contains a real table still renders `table`, `tr`, and `td` as table elements. A table wider than the column scrolls horizontally. Paragraphs outside the table use the 0.75em margin. The message does not load a remote image and does not set its own font.
- Keyboard focus is visible on the folder, the row, Back, and Search. Contrast for text and for the unread circle meets the ratios above in light and dark.
- `StatusPanel` on Dashboard, Integrations, Settings, and Mail shows the 20px status icon and keeps its loading, empty, and error roles.
- No Gmail write request is added. The OAuth scopes and the content security policy text are unchanged.

## Stages

1. Add the two variable fonts, the tokens, and the wordmark.
2. Replace inbox cards with 56px rows and the unread treatment.
3. Add the folder column and the narrow single-row fallback from the `main` width.
4. Add the conversation header and the scoped reading styles.
5. Add the remaining Lucide icons and the `StatusPanel` icon.
6. Run the quality commands and record contrast. Manual visual acceptance uses the criteria above.

## Risks

Variable font files increase the renderer bundle. The implementation records the CSS and font asset sizes. A unicode range that is not bundled falls back to `system-ui` for those glyphs.

Email tables that depended on stripped `style` attributes already lose that presentation in SPEC-001.3. Reading CSS must not take further layout control away from those tables.

At 760px the folder row scrolls. A keyboard user can reach each folder by Tab. The row does not trap focus.

The unread circle uses the accent color and also weight and an accessible name. Color is not the only signal.

## Verification

Host: Windows, Node `v22.13.0`, pnpm `12.11.2`. Electron `44.7.2` embeds Node `24.21.0`.

`pnpm lint` (exit 0).

`pnpm format:check` (exit 0) after this section was written.

`pnpm typecheck` (exit 0).

`pnpm test` (exit 0): Node `158` tests, `34` suites, `0` failures; Vitest `19` tests, `8` files, `0` failures. The added Node file is `src/renderer/src/styles/visual-system.test.ts`. The added Vitest cases cover row activation, folder selection, and a sanitized table.

`pnpm test:coverage` (exit 0). Aggregate result: lines `96.52`, branches `82.60`, functions `95.84`. Thresholds remain lines 90, branches 80, functions 90. Vue single-file components and CSS are outside the coverage include list.

`pnpm build` (exit 0): main `510.89 kB`, preload `17.04 kB`, renderer CSS `26.25 kB` (`index-z5PPMLgR.css`), renderer JS `309.23 kB` (`index-c7Irh7xM.js`). Local font assets, with no `fonts.googleapis.com` or `fonts.gstatic.com` reference in `out/renderer`: Inter Vietnamese `10.25 kB`, Inter Greek extended `11.23 kB`, Outfit Latin extended `14.80 kB`, Inter Cyrillic `18.74 kB`, Inter Greek `18.99 kB`, Inter Cyrillic extended `25.96 kB`, Outfit Latin `32.29 kB`, Inter Latin `48.25 kB`, Inter Latin extended `85.06 kB`. The earlier SPEC-001.3 package, installer `109938505` bytes, does not contain this UI.

`pnpm check:build` (exit 0): `build output verified`.

`pnpm package` (exit 0): electron-builder `26.17.0`, `npmRebuild` false, signing skipped, `--publish never`. Installer `release/Aurora-Setup-0.0.0.exe`, `110207006` bytes. Unpacked tree `386100636` bytes.

`pnpm check:package` (exit 0): `packaging verification passed`. `app.asar` contains `package.json` and `out/` only, including the nine `woff2` files listed above.

The manual checks that were performed confirmed the visual system. Separate results at 760px, 880px, and 1280px were not recorded. Component tests and `visual-system.test.ts` cover the folder container query at 960px, the 56px row, unread text, keyboard activation, and the reading CSS limits.
