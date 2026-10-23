# Fit Log

A personal, phone-first calorie, food and activity tracker that runs entirely in the browser.

* **No server, no account.** All data is stored on the device in IndexedDB. Nothing personal is in this repo.
* Export / import a JSON backup from **Me → Privacy & backup**.
* Optional PIN lock (salted PBKDF2 hash, privacy screen only).
* **Food:** one list of your foods. Each food is saved once with its usual amount (e.g. *Bread, 35 g, 90 kcal, 3 g protein, 1 g fat*); tap it to log that amount (counter badge, − to remove, Undo), hold it to log different grams or edit it. Meals are assigned by time of day; saved meals and copy-a-day live under **⋯**.
* Targets default to a fixed plan (1,870 kcal, protein 180–190 g, carbs 100–130 g, fat from the rest), editable under **Me**.
* Nutrition-label photos are read on the device with [tesseract.js](https://github.com/naptha/tesseract.js) (eng + nld + nor, vendored in `vendor/`).
* Barcode look-ups use the free [Open Food Facts](https://world.openfoodfacts.org) API (only the barcode number is sent).
* Activity: quick daily entry from Huawei Health, or import the Huawei privacy-centre export JSON / a CSV.
* Works offline as a PWA (add to home screen).

Third-party code: tesseract.js (Apache-2.0), Chart.js (MIT), ZXing (Apache-2.0). Trained data from tesseract-ocr/tessdata (Apache-2.0).
