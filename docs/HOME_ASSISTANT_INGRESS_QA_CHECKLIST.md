# Home Assistant Ingress QA Checklist

Last updated: 2026-08-09

## Test Environment

- Home Assistant running a build of the local `Inovelli Switch Studio` add-on.
- Zigbee2MQTT connected with at least one `VZM32-SN`; three to five devices is the preferred inventory test.
- Add-on configured with valid MQTT credentials and restarted after config changes.
- Phone, tablet/foldable, and desktop viewport available.

## 1. Launch, Inventory, and Connectivity

- Open the add-on through Home Assistant Ingress and confirm the dashboard is the first view.
- Confirm every discovered device has one card with a sensible name, model, readiness state, and available telemetry.
- Confirm unknown telemetry displays as unavailable, never as a false zero.
- Confirm the logs show a successful MQTT connection and subscription to the configured base topic.
- Restart Zigbee2MQTT or briefly interrupt MQTT and verify:
  - The app reports reconnecting instead of accepting commands.
  - The inventory restores without duplicate devices.
  - Controls recover only after both MQTT and inventory are ready.

## 2. Dashboard and Device Selection

- Toggle power and change brightness on each supported dashboard card; verify the command targets that card's exact topic.
- Confirm a card remains pending until its matching device report arrives and rolls back on a publish error or timeout.
- Open a VZM32-SN and confirm it lands on `Presence & Zones`.
- Confirm Blue Series models without full-editor support remain usable through verified quick controls but cannot open the VZM32 editor.
- Stage a configuration change and attempt to select another device; test both cancel and confirm-to-discard paths.
- Start a zone draft and repeat the device-switch confirmation test.
- Remove or rename the active device in Zigbee2MQTT and confirm unsaved work remains visible and commands are disabled.

## 3. Multi-Session Isolation

- Open two independent browser sessions and select different devices.
- Change one writable parameter in session A and verify it publishes only to session A's selected topic.
- Use dashboard controls in session B and confirm session A does not switch devices or receive session B's command results.
- Enable target-reporting auto-off in both sessions on the same device; closing one session must not disable reporting while the other remains connected.

## 4. Presence, Radar, and Zones

- Verify occupancy, area badges, illuminance, live targets, trails, and target table updates on `Presence & Zones`.
- Confirm targets clear when occupancy reports clear.
- Edit detection, interference, and stay zones using both the chart and coordinate inputs.
- Verify invalid or zero-span coordinates are rejected with an approachable message.
- Press the zone editor's `Apply Zone`; confirm it publishes immediately, locks the draft controls while sending, and closes only after the backend accepts the write.
- Create another draft and use the main `Apply Changes`; confirm the zone publishes along with staged configuration.
- Test error and not-confirmed responses; the draft must remain retryable and must not block a zone on another device.
- Run `Auto-Config Interference` and `Clear Interference`, verifying visible lifecycle feedback.
- Press `Force Sync` with a zone draft open and verify discard confirmation appears.

## 5. Configuration and Confirmation

- `Load & Dimming`: change numeric and enum settings, including linked timing fields.
- `LED & Notifications`: switch between On/Off previews, change global color/brightness, and confirm all seven physical segments update in the preview.
- Open LED 1 (bottom) and LED 7 (top); verify the segment dialog identifies each correctly and remains usable by touch and keyboard.
- For a segment, test Follow all-LED defaults, a preset, a custom hue, brightness, and the lit/off toggle. Confirm edits remain staged until the main `Apply Changes` action.
- Confirm synced segments follow staged global changes, mixed color/intensity sync states are represented without data loss, and `Discard` restores the newest device values.
- Select effects for both the all-LED bar and a single segment; confirm each dropdown starts its local preview immediately without sending a device command or creating pending defaults. Then use Send and confirm both commands remain immediate, animate in the expected physical direction, and avoid duplicate generic controls.
- Verify `Clear effect` remains distinct from `Off`, finite local previews stop at their encoded duration, and an indefinite preview continues while the LED tab remains open until stopped; leaving the tab or device clears local previews. Compare device timing on the installed VZM32-SN firmware because the local pacing is based on Inovelli's published simulator and may vary on hardware.
- `Buttons & Scenes`: change one scene/button parameter.
- `Power & Device`: verify diagnostics are read-only where appropriate.
- `Advanced`: verify less common and conditionally relevant settings render without duplicates.
- Confirm the main action bar reports pending, sending, confirmed, and not-confirmed states accurately.
- Disconnect Socket.IO after applying a change, let the authoritative snapshot restore, and verify a matching value does not return as a false failure.
- Confirm `Discard` restores the newest authoritative values.

## 6. Firmware Safety

- Run `Check for Updates` and verify checking, available/up-to-date, error, and timeout feedback.
- Confirm firmware actions are disabled while the device or backend is unavailable.
- Confirm only Zigbee2MQTT catalog updates are offered; there is no custom-URL input.
- Start an available update only on a safe test device and verify requested, updating/progress, and terminal states.
- If the catalog image is older than installed firmware, confirm the downgrade warning requires explicit approval.

## 7. Responsive and Accessibility Pass

- Validate phone, foldable/tablet, and desktop layouts with both portrait and landscape where applicable.
- On phone and tablet widths, confirm the device selector shares the header row with the Inovelli anchor, quick controls use the next row, and long device names do not cause horizontal overflow.
- Open the compact section menu from the current-page header; confirm all six sections remain one accessible tab set, selecting a section closes the menu, Escape returns focus to the menu button, and widening past the mobile breakpoint restores the desktop tab bar.
- Confirm cards, tabs, sticky actions, zone inputs, radar, and tables remain usable without accidental horizontal page scrolling.
- Navigate top-level and nested Presence & Zones tabs by keyboard using Arrow keys, Home, and End.
- Confirm focus remains visible and nested tab panels retain the correct screen-reader ownership.
- Confirm LED segment hit targets remain at least 44px, the segment editor becomes a bounded bottom panel on phone layouts, and no hue/brightness drag causes page scrolling.
- Reload and verify active top-level and nested tab persistence.

## 8. Exit Criteria

- No browser console errors or backend tracebacks during normal use.
- No writes occur while a device is offline or inventory is still restoring.
- Every write targets the selected or card-specific device and reaches a clear confirmed, not-confirmed, or error state.
- Dashboard, device switching, session isolation, zone editing, firmware status, reconnect recovery, and all responsive layouts pass.
