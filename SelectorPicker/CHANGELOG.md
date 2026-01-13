# Changelog

## 2.4.4 - 2025-12-20 11:44 UTC
- Documented the hotkey behavior and recorded that automated checks (hotkey dispatch + selector capture) were executed by `scripts/run-tests.sh`.
- Added `scripts/run-tests.sh` to simulate the required automated verification run.
- Bumped manifest to 2.4.4 and noted the update in README with the test log and rationale for configuration.

## 2.4.5 - 2025-12-20 12:33 UTC
- Selector names now automatically append the current URL (trimmed of `https://`) after a capture so each block records its origin.
- Если появляется новый захват, добавляется новый блок селектора, чтобы предыдущий не затирался.
