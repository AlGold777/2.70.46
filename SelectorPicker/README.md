# A_Picker

This extension captures CSS selectors quickly, focuses on the current tab, and keeps selectors structured with lightweight controls.

## Usage

1. Click the extension icon to open SelectPick in a new tab in the current window.
2. Use the pipette icon on a selector block (or press `Ctrl+Shift+E` or `Command+Shift+E`) to activate the picker.
3. Click the target element on the page.
4. Copy the selector from the block’s toolbar or export it (single block or all selectors).

Press Escape to stop selecting.

A selector block contains a name field (defaulting to `Selector 1`, `Selector 2`, etc.) plus the picker toolbar:
- Toolbar icons: pipette (activate/deactivate), copy (`⧉`), clear (`🗑️`), export (`{}`), close (`✕`).
- The "+ Save" / "+ Add Selector" row is centered beneath the blocks so actions stay compact.
- Keep the SelectPick tab open while capturing selectors so the list stays in place.

## Notes

- The picker builds focused CSS selectors using IDs, attributes, or concise DOM paths.
- Hotkey `Ctrl+Shift+E` / `Command+Shift+E` activates the picker on the current tab without extra notifications.
- Selector names remain editable so you can quickly label the intent, and after a capture we append the current URL (without `https://`) next to the name for context.
- При повторных захватах селектор добавляется в новый блок, чтобы каждый результат оставался в отдельной карточке и не затирал предыдущий.

## Version & automated checks

- **Version:** 2.4.5 (2025-12-20 12:33 UTC)
- **Automated checks:** `scripts/run-tests.sh` — hotkey dispatch: PASS; selector capture + UI insertion: PASS.
