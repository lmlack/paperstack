# Third-party components

The MIT grant in `LICENSE` and the CC BY grant in `LICENSE-CC-BY-4.0` cover this
project's own code and writing. The components below are other people's work,
are copied into `vendor/` so the app makes no network requests, and keep their
own terms.

| Component | License | Text |
| --- | --- | --- |
| pdf-lib | MIT | `vendor/pdf-lib.LICENSE.md` |
| PDF.js | Apache-2.0 | `vendor/pdfjs/LICENSE` |
| Atkinson Hyperlegible Next | SIL Open Font License 1.1 | `vendor/fonts/atkinson.LICENSE` |
| Righteous | SIL Open Font License 1.1 | `vendor/fonts/righteous.LICENSE` |

PDF.js also ships the substitutes for the 14 standard PDF fonts under
`vendor/pdfjs/standard_fonts/` and Adobe's character maps under
`vendor/pdfjs/cmaps/`. These are not covered by the Apache-2.0 grant above and
carry their own terms:

| Component | License | Text |
| --- | --- | --- |
| Foxit / PDFium base fonts | BSD-3-Clause | `vendor/pdfjs/standard_fonts/LICENSE_FOXIT` |
| Liberation, Arimo, Tinos, Cousine | SIL Open Font License 1.1 | `vendor/pdfjs/standard_fonts/LICENSE_LIBERATION` |
| Adobe CMap resources | BSD-3-Clause | `vendor/pdfjs/cmaps/LICENSE` |

Both display faces have reserved font names under the OFL: a modified copy has
to be renamed.
