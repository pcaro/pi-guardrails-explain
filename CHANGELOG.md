# Changelog

## [0.2.0]

### Added

- Added `/guardrails-explain [enable|disable]` to enable, disable, or toggle Bash command explanations in the current session without reloading.
- Added `CHANGELOG.md` and `pi.changelogPath` package metadata so Pi displays release notes under **Extension Updates** after an update.

## [0.1.0]

### Added

- Added the `explain-bash` Guardrails decision delegate that summarizes flagged Bash commands in one line before the confirmation prompt while keeping the allow or deny decision with the user.
- Added `guardrailsExplain.models` candidate fallback order with the active session model as the last resort, plus `guardrailsExplain.language` response language configuration.
- Added an in-memory per-session explanation cache for up to 64 commands, cleared on session shutdown.
