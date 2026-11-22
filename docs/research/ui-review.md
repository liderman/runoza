# Checking UI/UX before step 5

Date: 2026-11-11. All changes are local, no push.

## Changes in changes

- Navigation migrated to Gravity Navigation 8.0.0: PageLayout, PageLayoutAside and MobileHeader. The shared container of the page saves shapes when the width is switched. Icons — Gravity Icons 2.23.1.
- Fixed the cause of the adhesive elements: UIKit 8 expects `gap="spacing-2"`, not `gap="2"`. Boundary check now prohibits such unitless gap values. Rollbacks, sizes and adaptability are given by the properties of Gravity Box/Flex; removed old file card styles and hiding the standard AIKit send button.
- Added signatures, mandatory, localized errors near fields, HelpMark with limited width, section descriptions. EN/RU are supported for all new texts.
- Providers: list and separate form, conditional obligation of the token, saving the old key with an empty editing field, explicit mode without authorization. When you change the endpoint, you need a new key or an explicit authorization disabling. Connection verification is available for saved settings.
- Projects: Tabs of instructions, files and participants; multi-line instruction field with example; independent draft of creation; Explained the purpose of files, manual inclusion in context and limitations of supported formats.
- Attachments are selected in a dialog. Cancel does not apply a modified choice. The file that has already been downloaded remains in storage.
- Exports moved to the account. Unimplemented functions in the admin are not available for inclusion. Corrected log event signatures.

## Checks.

- `npm run check`: formatting, packet boundaries, TypeScript, production build, 7 unit tests and licenses of 569 fixed packages – PASS.
- Integrations: 39 PASS, 1 SKIP, 0 FAIL Missed optional restart RustFS (it has already been tested in step 4; the storage is not changed by this change).
- Added checks of forming the provider and saving the former encrypted key, prohibition of changing the endpoint without a decision on the key, explicit no-auth; checks the compliance of new EN / RU dictionaries.
- Isolated browser stand: saving the provider with a blank key and the connection test; error of the new provider without a key; mandatory name of the project; multi-line instructions and hint; saving the form when changing the width 375 → 1400; mobile menu without horizontal scrolling; light / dark theme; EN / RU; sending and streaming response; downloading the test file, canceling and confirming the selection of the attachment; account, admin and log.
- The test data was only created in a separate database and bucket. Paid models were not used.

Local Compose updated: API and worker healthy, `/health/ready` returns `ok`, protected `/api/v1/projects` without a session returns 401. Migrations completed successfully; no new migrations in this change. Temporary UI stand stopped, test data cleared. Basic user data saved.

## Boundaries of verification

The limitations of the first check (the name of the send button and the protection of transitions between partitions) are closed in the [working interface rebuilding](ui-workspace-redesign.md), which also describes the new navigation, settings and recheck results.
