# Expense tracker with receipt photos

Track what your shop (or household) spends. Snap a photo of each receipt and **AI reads it for you**: the shop
name, date, total, VAT, category and payment method are filled in, and you just check and save.
Monthly budgets, monthly bills (rent, electricity), charts, and an export for your accountant **with all the receipt
photos**. In English (the default), Thai and Sinhala.

Receipt reading works **for free** on your device, or more accurately with Claude AI if you add an API key.

## What it does

- **📷 Snap a receipt** with the phone camera, or choose photos/PDFs, drag them onto the window, or paste a screenshot.
  Several pages per expense are fine. Photos are shrunk to save space; tap one to zoom, rotate or download it.
- **📝 Free receipt reading** works with no key and no server. Text is read on your device (English + Thai) and simple rules pick out
  the shop, date, total, VAT and payment method. It is less accurate than Claude, works on photos only (not PDFs), and the
  first use downloads a few MB that the browser then keeps. Clear, straight photos work best.
- **✨ Read receipt (Claude AI)** fills in the form from the photo. Filled fields turn purple so you know what to check,
  along with how confident the AI is. It never saves by itself, and it won't overwrite anything you've typed.
  It understands Thai receipts with Buddhist-year dates (2569 → 2026).
- **Quick manual entry**: amount, date, category, who you paid, how you paid (cash, card, transfer, PromptPay),
  VAT (one tap works out the 7% included), and a note. The app remembers the usual category for each shop.
- **Duplicate warning** when the same shop, amount and date is entered twice
- **📊 Overview** for each month: total vs last month, budget used, spending by category (with budget marks), by day,
  the last 6 months, biggest expenses, and how many expenses still have **no receipt photo**
- **Budgets** per category per month, with warnings when you go over
- **Monthly bills**: on the due day the Overview asks "Add rent ฿15,000?" (change the amount first if it's different, or skip this month)
- **🧾 Expenses** list: filter by month, category or payment method, search, or show only expenses without a receipt
- **Export**: CSV for Excel, or a **ZIP with the CSV plus every receipt**, named like `2026-11-08_1284_Makro_1.jpg`. That's ready for your accountant or tax filing.
- **Backup** (ZIP with all photos) and **Restore**, **PIN** lock

## Start

### Without AI (simplest)
Open `index.html` in Chrome or Edge. Everything works, including 📝 free receipt reading.

### With Claude AI receipt reading (more accurate, paid)
1. Install [Node.js](https://nodejs.org) 20.12 or newer.
2. In this folder:
   ```
   npm install
   copy .env.example .env
   ```
3. Put your Anthropic API key in `.env` after `ANTHROPIC_API_KEY=` (from https://console.anthropic.com).
4. Run `npm start` and open **http://localhost:8788**.

Reading one receipt costs roughly ฿0.3–1 in API fees (less with `EXPENSES_MODEL=claude-haiku-5-5` in `.env`).
To keep using the free reader even with a key, choose **Settings → Receipt reading → Always free**. The server only listens on this computer and refuses
requests from other websites, so nobody else can use your key.

Data is stored per address: what you enter at `http://localhost:8788` is separate from what you enter when opening
`index.html` directly. Pick one and stick with it (or move data with Backup → Restore).

## Using it on your phone

The camera button works best on a phone. Two options:
- **Easiest, free reading**: put this folder on GitHub Pages (Settings → Pages) and open that address on the phone.
  The data stays on the phone.
- **With AI on the shop's Wi-Fi**: run the server with `HOST=0.0.0.0` in `.env` and open `http://<computer's IP>:8788` on the phone.
  Only do this on a private network you trust, because anyone on that Wi-Fi could then use your API key through the app.

## Your data

- Expenses and receipt photos stay **in this browser on this device**. The free reader never sends photos anywhere.
  With Claude AI, only the photo you read is sent to Anthropic to be read, and it isn't stored in the app's server.
- **Make a backup every month** (Settings → Backup). It includes all photos. Clearing the browser's site data deletes everything.
- The app asks the browser to keep its storage permanently, and Settings shows how much space the photos use.
- The PIN keeps casual eyes out; it is not encryption.

## Files

| File | What it does |
|---|---|
| `index.html`, `app.js`, `style.css` | The app |
| `core.js` | Rules: saving, budgets, monthly bills, summaries, CSV |
| `store.js` | Receipt photos in the browser (IndexedDB) |
| `server.mjs` | Local web server + AI receipt reading (Claude, structured JSON output) |
| `i18n.js` | Texts in English, Thai and Sinhala |
