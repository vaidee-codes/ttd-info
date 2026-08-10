# Privacy Policy for TTD Autofill Assistant

**Last Updated:** August 10, 2026

The **TTD Autofill Assistant** ("we", "our", or "us") is a Chrome Extension designed to assist users in autofilling pilgrim, contact, and Srivari Seva forms on the official Tirumala Tirupati Devasthanams (TTD) booking websites. We are committed to protecting your privacy and handling your data with transparency.

## 1. Information We Collect and Store

Your saved booking details stay on your device. The optional paid pass uses an online licence service, described separately below. The licence service does not receive pilgrim, contact, Seva, Srivani, password, OTP, or TTD payment details.

### Local Data Storage

The extension uses your browser's local storage (`chrome.storage.local`) to save the following details for your convenience:

- **Pilgrim Details:** Names, ages, genders, ID proof numbers, and related passport information (country, visa details).
- **Contact Details:** Email addresses, mailing addresses, city, state, and pincodes.
- **Srivari Seva & Srivani Details:** Sevak/devotee names and related information, darshan dates, laddu counts, and group booking entries you enter for Srivari Seva and Srivani booking forms.
- **Preferences:** Your chosen language, interface theme, tab layout, and onboarding state.

This data is stored solely to allow you to reuse it for future bookings without re-entering it, and to remember your preferences between sessions.

## 2. How We Use Your Information

The information you save is used exclusively for autofilling booking forms on the official TTD websites (`tirupatibalaji.ap.gov.in`, `ttdevasthanams.ap.gov.in`, etc.).

- **Autofill:** When you click the "Fill" buttons, the extension reads your locally saved data and populates the fields on the active webpage.
- **No booking-data transmission:** Pilgrim, contact, Seva, Srivani, and booking-draft data is not sent to our servers, analytics platforms, or ad networks.

## 3. Weekly Pass and Payment Data

Pilgrim-booking autofill can be unlocked with an optional seven-day pass. When you activate, verify, refresh, or move a pass, the extension sends the following to our licence API at `ttd-info.vercel.app`:

- the pass licence key;
- a randomly generated installation identifier;
- a short device label such as browser platform;
- the payment provider's activation-instance identifier; and
- a short-lived signed entitlement token.

Our API uses this information only to validate the pass, enforce its device limit, issue a signed entitlement, and release an activation when you choose **Move pass**. It communicates with Dodo Payments for licence and purchase status. Card and billing details are entered on Dodo Payments' checkout and are not available to the extension. The extension contains no advertising or behavioural analytics.

## 4. Third-Party Links

The extension and website link to Dodo Payments checkout, email, and community pages. If you follow those links, the destination's privacy terms apply. We do not control third-party privacy practices.

## 5. Data Sharing and Disclosure

- We do **not** sell or trade your saved booking data.
- We share only the licence and purchase identifiers needed for pass processing with Dodo Payments and the infrastructure providers that operate the licence API.
- We do **not** use your data for creditworthiness, lending, or any other unrelated purposes.

## 6. Your Control Over Data

You retain full ownership and control over your data:

- **View/Edit:** You can view or update your saved data at any time via the extension's popup interface.
- **Delete saved data:** The Trust Center removes saved pilgrims, sets, contact details, Seva/Srivani drafts, legacy backups, and preferences. It deliberately keeps an active pass so its one-device activation is not stranded.
- **Move a pass:** Use **Move pass** in the popup to ask the licence service to release this browser, then activate the pass on another device.
- **Uninstall:** Removing the extension from Chrome deletes its local data. Release an active pass first if you intend to reuse it elsewhere.

## 7. Changes to This Policy

We may update our Privacy Policy from time to time. We will notify you of any changes by posting the new Privacy Policy on this page. You are advised to review this Privacy Policy periodically for any changes.

## 8. Contact Us

If you have any questions about this Privacy Policy, please contact us at **ttdautofill@gmail.com** or via the Chrome Web Store support page.
