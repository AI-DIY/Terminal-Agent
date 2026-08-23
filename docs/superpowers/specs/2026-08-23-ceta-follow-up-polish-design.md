# CETA Follow-up Polish Design

## Context

The follow-up CETA review requests three focused corrections while preserving the current product layout and all existing SSH, Shell, AI workspace, model routing, and protected-storage behavior:

1. remove the duplicated Terminal-Agent icon/title treatment at the top of the Windows window;
2. replace file-based API key import with direct editing in the model connection form;
3. remove the VLM-to-LLM API key reference feature.

The implementation will be developed on `codex/ceta-current-polish` and released as version `1.0.8`. It will not redesign the workbench or model architecture.

## Selected Approach

Use Electron's hidden title bar with a native title-bar overlay. The standalone Windows title-bar row and its duplicate icon disappear, while the native minimize, maximize/restore, and close controls remain in the upper-right corner. The existing application header becomes the only branded top row.

API keys become transient editable form values. The renderer necessarily holds the value while the user types and sends it through the context-isolated preload API, but the main process remains the only persistence owner. It validates the value and stores it through the existing Windows protected secret store. No plaintext key is written to a profile document, returned in a renderer DTO, or restored into an edit form.

The alternatives were rejected for these reasons:

- retaining the native title bar and removing only the in-app mark would still repeat the product name and leave the application header visually unbalanced;
- a completely frameless window with custom controls would require reimplementing native window state, snapping, system behavior, and accessibility, which is disproportionate to this polish request.

## Window Chrome and Layout

The main `BrowserWindow` uses `titleBarStyle: 'hidden'` with `titleBarOverlay`; it does not use `frame: false`. Electron and Windows continue to own the minimize, maximize/restore, and close buttons, including their native hover behavior, accessibility, system snapping, and maximized state.

The overlay height matches the workbench application header. The application header and Settings header reserve a stable right inset for the window controls at supported desktop and constrained sizes. Product-owned buttons, inputs, links, menus, splitters, and other interactive elements are explicitly non-draggable. The remaining blank header surface and brand area are draggable. The layout must not place Settings, current-task text, or any other action under the native controls.

The overlay palette follows the saved pearl or graphite theme. Initial window creation uses the persisted theme, and saving a new appearance updates the overlay color and symbol color through the main process without recreating the window. The header background and overlay background must read as one continuous row.

The existing `TA + Terminal-Agent` in-app brand remains the sole brand mark. Workbench columns, sidebar dimensions, Shell sizing, navigation, and content hierarchy do not otherwise change.

## Direct API Key Editing

Both LLM and VLM connection editors use the same credential behavior:

- new profiles expose an editable password input;
- existing profiles return only `hasApiKey`, never the key itself;
- an existing key produces the placeholder `已配置密钥，留空则保留`;
- leaving the field empty omits the key from save and test requests, preserving or resolving the stored key;
- entering a value replaces the stored key on save;
- the visibility icon toggles only the current transient field value;
- after save or test completes, the component clears the transient value;
- a separate clear action removes the protected key after confirmation.

Connection testing accepts an unsaved transient key. For an existing profile with an empty field, testing resolves its stored key in the main process. For a new non-Ollama profile without a key, the existing actionable validation error remains. Testing never persists a transient key; saving does.

Clearing a key from an active non-Ollama profile also deactivates that route and records the existing explicit no-route choice, because an active profile must not remain apparently usable without its required credential. Ollama profiles may remain active without a key. The UI refreshes the profile status after clearing.

The preload and IPC boundary validates a maximum 4096-byte credential and accepts it only on model save or connection-test requests. Error messages and provider failures continue to redact credentials. Central renderer stores never retain the plaintext key; it lives in component-local state only for the active request.

The file picker, `导入密钥` buttons and copy, file-import service, and `settings:models:key:import` channel are removed.

## Removing API Key References

`apiKeyProfileId` is removed from current public input types, renderer DTOs, profile validation, current persisted profile records, delete guards, credential resolution, and the model editor. Every LLM and VLM profile owns at most one protected credential under its existing profile-specific secret key.

Existing version-1 profile documents remain compatible. Repository migration creates a version-2 document, removes `apiKeyProfileId` from profile records, and records only the pending source-to-target copy pairs in migration metadata. The service then processes those pairs serially:

1. if the VLM already has its own key, keep it;
2. otherwise load and validate the referenced LLM key;
3. when valid, save a copy under the VLM profile's protected key;
4. when missing or invalid, leave the VLM profile present but report `hasApiKey: false`;
5. if such a non-Ollama VLM was active but has no resulting key, clear the active VLM route;
6. durably clear the pending migration metadata after all copies have been handled.

The ordering is crash-safe and idempotent: protected target keys are saved before migration metadata is cleared, so a restart can repeat without losing credentials. The source LLM credential is not removed because its owning LLM profile still uses it.

New version-2 documents cannot contain a key reference. Deleting an LLM no longer checks for VLM dependants after migration.

## Component Boundaries

- `src/main/main.ts`: native hidden-title-bar overlay creation, initial theme palette, and window wiring.
- workbench appearance settings handler/service boundary: update the overlay palette after a theme save.
- `WorkbenchShell.vue` and `SettingsView.vue`: drag regions, non-drag controls, and stable window-control insets.
- `ModelProfileManager.vue`: component-local credential input, visibility toggle, replace/clear actions, and removal of import/reference UI.
- renderer model profile store and preload API: forward transient save/test credentials without retaining them, and expose clear-key behavior.
- shared validation/contracts: accept transient credential input while keeping output DTOs secret-free; remove current reference fields.
- settings IPC handlers: replace import IPC with validated save/test and clear behavior from a trusted renderer.
- model profile repository/service: version-2 reference migration, profile-owned secret resolution, clearing, and rollback behavior.
- obsolete file-import service: removed with its tests and main-process construction.

## Error Handling and Security

- A failed key validation does not modify the profile document or protected secret.
- A failed profile save restores the prior protected key.
- A failed clear operation restores the prior document or secret so profile state and credential state do not diverge.
- A failed reference migration remains retryable until the pending metadata can be durably cleared.
- Provider errors, logs, renderer DTOs, persisted JSON, and test artifacts must not contain entered credentials.
- The renderer sender check, context isolation, sandbox, and disabled Node integration remain unchanged.
- Window chrome changes must not obstruct native controls, application actions, keyboard navigation, or pointer interaction.

## Testing and Verification

Implementation follows test-driven development.

1. Add failing unit contracts for hidden-title-bar overlay options, preserved native controls, drag/no-drag regions, right-side control insets, and theme palette updates.
2. Add failing UI/store/preload/IPC tests for direct key entry, password visibility, empty-value preservation, unsaved-key testing, replacement, clearing, and absence of import/reference behavior.
3. Add failing repository/service migration tests for successful reference copying, pre-existing VLM keys, missing/invalid source keys, active-route correction, idempotent retry, and secret-free DTOs/documents.
4. Implement the minimum production changes required by those tests.
5. Run focused suites, then `npm test`, `npm run lint`, `npm run build`, `npm run test:e2e`, and `npm run test:integration`.
6. Exercise a fake local provider through the real Electron UI to prove direct entry, test-without-save, save, edit-without-echo, replacement, and clear behavior.
7. Capture and inspect workbench and Settings screenshots at desktop and constrained sizes in pearl and graphite themes. Verify one brand mark, visible native window controls, correct drag regions, no overlap, and no clipped credential controls.
8. Update release metadata to `1.0.8`, build the Windows installer and cleanup archive, smoke-test the packaged executable, and record the installer path, size, and SHA-256 checksum.

## Acceptance Criteria

- Only one Terminal-Agent icon/title treatment is visible in the application chrome.
- Native minimize, maximize/restore, and close buttons remain visible and functional.
- The workbench and Settings layouts remain balanced and unobstructed at supported window sizes.
- LLM and VLM API keys can be entered and replaced directly in their connection forms.
- Stored credentials are never returned to or displayed by the renderer.
- File-based key import and all API key reference UI/runtime behavior are absent.
- Existing referenced VLM credentials migrate to profile-owned protected storage when available, without deleting the source LLM credential.
- Existing model profiles, activation choices, routing, SSH behavior, Shell history, and AI workspace behavior remain available.
- All automated and visual verification passes, and a testable `1.0.8` Windows installer is produced.
