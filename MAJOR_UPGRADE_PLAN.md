# Major Dependency Upgrade Plan

Generated: 2026-03-09
Audited from: `npm outdated` output after safe patch/minor updates were applied.

---

## Summary of Safe Updates Already Applied

These were applied in the same session (see `package.json`):

| Package | From | To | Type |
|---|---|---|---|
| `@electron/asar` | `^4.0.1` | `^4.1.0` | minor |
| `fs-extra` | `11.3.3` | `11.3.4` | patch (pinned) |
| `sinon` | `^21.0.1` | `^21.0.2` | patch |

---

## Packages Requiring Major Version Upgrades

### 1. `eslint` — 8.57.1 → 10.0.3

**Risk:** HIGH. Two major version jumps. Requires significant config migration.

#### Breaking Changes Summary

**ESLint 9 (flat config becomes default):**
- `.eslintrc` / `.eslintrc.json` config format is no longer supported. Must migrate to `eslint.config.js` (flat config).
- `parserOptions` moves under `languageOptions`.
- Plugins are now imported as JS objects, not referenced by string name.
- `.eslintignore` is dropped; ignore patterns move into `eslint.config.js`.
- `require-jsdoc` and `valid-jsdoc` rules removed.
- `--quiet` flag behavior changed.

**ESLint 10 (additional changes on top of v9):**
- Node.js < 20.19 no longer supported. (Project already targets Node ≥ 22, so fine.)
- `eslint:recommended` adds three new rules: `no-unassigned-vars`, `no-useless-assignment`, `preserve-caught-error`.
- Old `.eslintrc` format support fully removed (already removed in v9, now final).
- Config lookup algorithm changed: now searches from each file's directory upward.
- `eslint-env` inline comments now trigger errors.
- `radix`, `no-shadow-restricted-names`, `func-names`, `no-invalid-regexp` rules have breaking behavior changes.
- Context methods like `getFilename()` removed; replaced by `filename` property.

#### Blocker: `eslint-config-airbnb-base` Compatibility

**Critical blocker.** The project uses `eslint-config-airbnb-base@15.0.0`, which:
- Has not released official ESLint 9/10 support (no release in ~4 years as of early 2026).
- Does not export a flat config format.

This means upgrading ESLint requires one of:
- Replacing `eslint-config-airbnb-base` with a maintained alternative (e.g., `eslint-config-airbnb-extended`, which targets ESLint 9+ flat config).
- Using the community shim `airbnb-eslint9` as a transitional package.
- Waiting for official `airbnb-base` flat config support (PR #3061 in upstream repo).

#### Migration Steps

1. Remove `eslint-config-airbnb-base` and `eslint-plugin-import`.
2. Choose a replacement config (recommend `eslint-config-airbnb-extended` or `airbnb-eslint9`).
3. Rewrite `.eslintrc` → `eslint.config.js` flat config format:
   - Convert `extends: "airbnb-base"` to the new plugin import style.
   - Move `parserOptions.ecmaVersion` and `sourceType` to `languageOptions`.
   - Move `env` definitions to `languageOptions.globals` (use `globals` package).
   - Migrate `globals` (`Meteor`, `WebAppLocalServer`, etc.) to `languageOptions.globals`.
   - Move `settings["import/core-modules"]` to the new plugin config object.
   - Migrate all `rules` entries (verify none rely on removed rules).
4. Migrate `.eslintignore` contents into `eslint.config.js` `ignores` array.
5. Run `eslint .` across all linted directories (`lib plugins scaffold skeleton tests`) and fix any new violations from new rules.
6. Update CI/lint scripts if they pass `--ext` or other deprecated flags.

**Estimated effort:** 2–4 hours of migration + fixing new lint errors across the codebase.

---

### 2. `isbinaryfile` — 5.0.7 → 6.0.0

**Risk:** MEDIUM. One major version jump. API is stable but there is one documented breaking change.

#### Breaking Changes Summary

- **Encoding hints parameter added** — The function signature now accepts an optional options/hints argument. This is listed as a breaking change in the v6 release notes, though the exact form is an additive parameter. Existing call sites using positional args should still work.
- **Bug fixes for buffer boundary handling** — More accurate detection at multibyte UTF-8 boundaries and for protobuf files.
- **Module format** — Verify whether v6 is ESM-only (the project uses `"type": "module"` already so this should not be a blocker).
- **Node.js requirement** — v6 may require Node ≥ 24. Confirm against project's Node ≥ 22 requirement.

#### Current Usage

```js
// lib/binaryModulesDetector.js line 2 & 44
import { isBinaryFileSync } from 'isbinaryfile';
shouldUnpack = isBinaryFileSync(path.join(this.nodeModulesPath, file.name));
```

Single call site. Uses `isBinaryFileSync(filepath)` — the basic synchronous form with a path string.

#### Migration Steps

1. Check v6 Node.js engine requirement (may be `>= 24`). If so, this is a **hard blocker** since the project currently targets `>= 22.22.0`.
2. If Node requirement is acceptable: update `package.json` to `"isbinaryfile": "^6.0.0"` (currently pinned to `5.0.7`).
3. Verify `isBinaryFileSync(filepath)` still accepts a plain string path (no API change needed in `binaryModulesDetector.js` unless signature changed).
4. Run tests and confirm `binaryModulesDetector` behavior is unchanged.

**Estimated effort:** 30 minutes if Node requirement is met; blocked entirely if Node 24 is required before the project targets it.

**Recommendation:** Check the v6 `package.json` `engines` field before attempting the upgrade. If it requires Node 24, defer until the project updates its Node baseline.

---

## Packages Held Back (Not Major, but Noted)

| Package | Current | Latest | Note |
|---|---|---|---|
| `app-builder-lib` | 26.7.0 | 26.8.1 | Peer dependency (`*`). Updated by the consuming project, not this package. No action needed here. |
| `codecov` | 3.8.3 | 3.8.2 | Latest is *older* than current. Possibly a pre-release or retracted version. No action. |

---

## Recommended Upgrade Order

1. **`isbinaryfile` 6.0.0** — Check Node engine requirement first. If it fits, this is a small, low-risk change.
2. **`eslint` 10.0.3** — After resolving the `airbnb-base` blocker. Substantial but well-documented migration path.
