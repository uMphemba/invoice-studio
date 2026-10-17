# Invoice Studio

A local invoice and quotation application with accounts, multiple business profiles, saved branding, customers, a product catalogue, payments, credit notes, refunds and document history. Records are stored in SQLite; browser storage is used only for interface preferences.

## Start or restart in VS Code

Use **Node.js 24 or newer**. Open this folder in VS Code and choose **Terminal → New Terminal**.

```powershell
node server.js
```

Open `http://localhost:4173`. Keep the terminal running. `npm.cmd start` is an alternative that avoids PowerShell's `npm.ps1` execution-policy error.

After a code update, stop the existing server with **Ctrl+C**, run `node server.js` again, and refresh the browser with **Ctrl+F5**. Save any open draft before refreshing.

The application creates `data/invoice-studio.sqlite` on first start. Existing installations use additive schema setup that preserves accounts and records. The first start of this version saves a database snapshot in `data/backups/` before adding the quotation and accounting tables. Versions are recorded in `schema_migrations`.

## Invoices and quotations

- Create an account and enter your business profile. Add banking details, tax settings, payment terms and a logo under **Business & brand**.
- Use **Invoices** or **Quotations** to start a document. Choose a saved customer or enter a new one. Save reusable customer details directly from the editor.
- Add custom items or select catalogue entries. Quantities support three decimal places. The live preview and server use shared integer calculations, including allocation of invoice discounts before tax without losing rounding differences.
- Drafts do not consume numbers. Issuing assigns a unique number in a SQLite transaction. Invoices, quotations and credit notes have separate sequences.
- Issued documents retain their customer, logo, business and design snapshots. Duplicate an issued document to prepare a revision.
- Quotations have validity dates. Record acceptance or decline, then convert an accepted quotation into an invoice draft. Repeating conversion returns the same invoice.
- Download a PDF, open a full preview, print, record manual sharing, or export filtered document lists to CSV. Long PDF item descriptions can continue onto another page with repeating headings.

## Payments, credit notes and refunds

Record a payment's date, amount, method and reference on an issued invoice. Partial payments reduce the balance; unpaid balances past their due date become overdue.

An unpaid invoice with no financial activity can be cancelled with a reason. For other issued invoices, create a credit note against the remaining value of original items or shipping. Credit notes have their own number, date, reason, tax allocation and PDF. The original invoice is preserved.

Credit against an already paid amount creates a refund due. **Record refund** records a refund already made; it does not initiate a bank transfer. Payments cannot exceed the balance, credits cannot exceed remaining original value, and refunds cannot exceed the refund due.

## Branding and reusable records

Six starting designs provide different colours, fonts, table styles and header layouts. Customise the palette, font size, logo size/alignment/placement, header layout, section titles, margins, row spacing, footer alignment, columns and optional blocks. Save a business default or customise an individual draft.

Logos support PNG and JPG/JPEG up to 2 MB. The browser normalises images for PDF handling and preserves PNG transparency. SVG uploads are disabled. Removing a logo affects future documents; issued documents retain their saved logo.

Customers and products can be searched, edited, archived and restored. Products include a currency, price, SKU, unit and tax treatment. Prices in another currency are not silently converted. Customer invoice history uses the saved customer ID.

The overview supports issue-date range, customer, status and currency filters. It distinguishes gross invoicing, credits, net invoicing, payments less refunds, outstanding balances and refunds due. Upcoming due dates and recent payments are also shown. Different currencies are never added together. Document lists support sorting and pagination.

## Configuration and email

Copy `.env.example` to `.env` and restart after changing settings. No real credentials are included.

- `PORT`: HTTP port, default `4173`.
- `APP_ORIGIN`: allowed browser origin, default `http://localhost:4173`.
- `DATA_DIR`: database folder, default the project's `data` folder.
- `APP_TIMEZONE`: date timezone, default `Africa/Johannesburg`.
- `HOST`: optional bind address; default `127.0.0.1`.
- `HTTPS`: set to `1` behind HTTPS for secure session cookies.
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`: optional email delivery. Port `465` uses TLS; port `587` requires STARTTLS. Certificates are validated.

Email attaches the generated invoice or quotation PDF. Failed attempts are recorded. Success is recorded only after SMTP provider acceptance, which does not confirm inbox delivery. Without configuration, the interface explains setup and offers a PDF for manual sharing. No live SMTP credentials were supplied, so delivery through a real provider remains unverified.

## Backups and recovery

Create a consistent SQLite snapshot, including committed WAL data, with:

```powershell
node backup.js
```

Backups are written under `data/backups/`. Full database backups contain all accounts and should be kept private. To restore, stop the server, preserve the current data folder, and place a backup in a **new empty data directory** named `invoice-studio.sqlite`. Point `DATA_DIR` at the new directory and restart. This avoids mixing the restored database with current WAL files.

**Business & brand → Export my records** downloads only the signed-in account's businesses, logos, customers, products, quotations, invoices and histories. Password hashes and sessions are excluded. This JSON is a portable record export; use a SQLite snapshot for full application recovery.

## Source layout and limits

- `server.js`: HTTP, authentication, profiles and uploads.
- `services.js`: document workflows, numbering, accounting and reports.
- `public/finance.js`: shared calculations and currency rounding.
- `public/document.js`: design, preview and print rendering.
- `pdf.js`, `fonts.js`, `image.js`: PDF layout, installed-font embedding and image parsing.
- `email.js`: SMTP integration.
- `public/app.js`, `editor.js`, `workspace.js`: navigation, editor, designer and management screens.

PDFs embed installed Arial, Georgia, Verdana or Tahoma fonts. Other hosts use DejaVu or Liberation where available, then PDF standard fonts. Character coverage depends on the installed font; complex-script shaping is not provided.

The app is configured for local use. Shared hosting requires appropriate HTTPS and backups. Tax fields and rates are configurable and do not guarantee legal or tax compliance.

No tests or browser verification were run for this update, as requested. Existing test files are retained for optional use by the owner.
