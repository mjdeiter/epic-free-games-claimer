# Epic Free Games Claimer

A Manifest V3 extension for Floorp/Firefox that checks the Epic Games Store weekly free games and claims them using your existing logged-in session.

## How it works

- A background event page polls Epic's public free-games promotions endpoint every 3 hours and on browser startup.
- Each new free game opens in a tab with lang=en-US. A content script checks you are signed in, dismisses age and Device not supported dialogs, clicks Get, then I Accept and Place Order in the checkout frame. It only clicks Get when the button says Get, never Buy Now.
- Claimed offer IDs are stored so nothing is retried. Failures are capped at 3 attempts per game.
- Every check ends in a notification. The last 40 events are kept in `storage.local.log` for debugging.

## Install

Sign it as an unlisted add-on on AMO for a permanent install:

    web-ext sign --channel=unlisted --source-dir . --api-key ... --api-secret ...

Then in about:addons choose Install Add-on From File. For quick testing, load manifest.json from about:debugging as a temporary add-on.

Bump `version` in manifest.json before each re-sign, because AMO rejects repeated versions.

## Notes

- You must already be logged in to Epic in the same browser profile. The extension never stores credentials.
- A captcha or login wall stops the claim and notifies you instead of trying to bypass it. After a login failure it stops auto-retrying for 12 hours; click the toolbar button after logging in to resume.
- Epic's endpoint is unofficial and the checkout selectors can change. They live in the SELECTORS block of content.js.
- Automating purchases may be against Epic's terms. Use on your own account at your own risk.
