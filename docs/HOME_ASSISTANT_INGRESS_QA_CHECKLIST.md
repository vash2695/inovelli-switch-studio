# Home Assistant Ingress QA Checklist

Last updated: 2026-08-12

## Test Environment

- Home Assistant running a build of the local `Inovelli Switch Studio` add-on.
- Zigbee2MQTT connected with at least one `VZM32-SN`; three to five devices is the preferred inventory test.
- Add-on configured with valid MQTT credentials and restarted after config changes.
- Phone, tablet/foldable, and desktop viewport available.

## 1. Launch, Inventory, and Connectivity

- Open the add-on through Home Assistant Ingress and confirm the dashboard is the first view.
- Confirm desktop, mobile-app/WebView, and mobile-browser ingress sessions complete the Socket.IO polling-to-WebSocket upgrade and remain connected after a page reload. Test the real Home Assistant hostname/port; foreign Origin values must be rejected.
- From the App network, verify direct HTTP and Socket.IO access from any peer other than Home Assistant's ingress proxy is rejected, even when it supplies spoofed `X-Forwarded-For`, `X-Real-IP`, `X-Remote-User`, or `X-Ingress-Path` headers. The HTTP rejection must be `403` and non-cacheable.
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
- Burst valid commands from one session until backpressure is reached. Confirm the App returns a retryable `rate_limited` result with a retry delay, publishes nothing for denied actions, creates no pending confirmation, and succeeds again after the delay. Repeat with two sessions to confirm one session's local burst does not immediately exhaust the other; a sufficiently large combined burst must still hit the global bound.
- Trigger `Force Sync` with only one command token available and confirm neither of its two MQTT requests nor cached refresh events are emitted. With two tokens available, both requests should proceed as one atomic budget decision.
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
- Confirm 2D retains the full-size Cartesian radar/editor footprint, then switch to 3D and verify the prepared top-down scene crossfades first and follows with the exact reverse of the 3D-to-2D camera orbit, with no blank frame, projection flash, roll, snap, or canvas-height jump.
- Switch between 2D and 3D repeatedly, including a rapid reversal mid-transition; the final selected mode must win, configured axis ranges must remain intact, and no stale WebGL canvases or context-loss warnings should accumulate.
- In `View`, set a device-specific 3D Height min/max, apply the display range, and verify the floor reference and visible-height FOV update without changing any configured zone coordinates. Reversed values should normalize, blank/equal/out-of-range values should be rejected, and switching A → B → A should restore each switch's own range.
- Use `Apply Height to All Switches` and confirm only Height min/max is copied to every currently discovered full-editor switch; X/Y stay unchanged, later-discovered switches keep their own range, and no MQTT/device command is sent.
- In 3D, verify each live target uses its exact X/Y/Z coordinates, trails remain separated by target ID, and the camera rotates/elevates/zooms around one fixed focus without snapping when orbiting below the sensor or near overhead; the room plane must never roll or flip. Hold an orbit while target and zone updates arrive, then release and confirm the final camera is retained. Leave that camera idle through target, zone, and settings updates for at least 10 seconds and confirm it never returns to an older angle.
- Confirm detection, stay, and interference zones render as complete, correctly bounded translucent cuboids, including a packet where an empty raw area slot precedes an active area. Extend zones past the configured X, Y, and Z display limits and verify the 3D axes and floor lattice expand with padding to show each cuboid in full while saved display limits remain unchanged; the complete Z axis should retain the scene's full physical height.
- Confirm both live modes preserve the nested 120° and 150° horizontal FOV reference envelopes, render them as visible but borderless informational shading distinct from semantic zones, and span the full visible 3D height. Detection, stay, and interference cuboids must retain their exact configured heights.
- In 2D, extend the map beyond the supported range and verify one even borderless mask covers Y below 0, Y beyond 600, and X outside −600..600 without darker overlapping corners. In 3D, confirm passive FOV and zone faces do not produce hover cards over empty-looking space, while target hover remains available.
- Confirm the 3D sensor is represented only by its origin marker at (0, 0, 0), with no vertical reference line, including after changing display bounds or switching devices.
- With the grid enabled, confirm one stable floor-only lattice covers the full rendered X/Y range at every camera angle, includes meaningful zero/major coordinates, and remains visually subordinate to targets, zones, and FOV shading. No camera-selected wall or ceiling grids should appear.
- Store 3D as the preferred view, leave the workspace, then navigate back (and repeat after a full page reload). Confirm the scene initializes at a nonzero size and the first desktop orbit works immediately; on touch, `Explore 3D` must unlock it first.
- Rotate the 3D scene, press `Reset view`, then switch devices; Reset must restore the default camera and a device change must clear targets/trails and intentionally reset the camera.
- Begin a zone edit while 3D is selected. The app must explain and force 2D for editing, disable 3D during the draft, and restore the preferred 3D view after Apply or Cancel without losing the draft.
- Turn off the grid/FOV and each zone category/individual detection-area visibility option; verify both radar modes follow the same settings and hidden volumes leave no ghost traces.
- Edit detection, interference, and stay zones using both the chart and coordinate inputs.
- Verify invalid or zero-span coordinates are rejected with an approachable message.
- Press the zone editor's `Apply Changes`; confirm the lifecycle reads `Sending zone update…`, then `Zone update sent; awaiting device confirmation`, and finally `Zone confirmed`. The controls must lock while sending; the editor may close only after the backend accepts the write.
- Create another draft and use the main `Apply Changes`; confirm the zone publishes along with staged configuration.
- After a sent zone update, force a not-confirmed response; the exact submitted X/Y/Z values and zone selector must reopen for retry without being replaced by the latest authoritative snapshot. Retry it and confirm only the matching device report clears the recovery copy.
- Repeat with an immediate publish error and a Socket.IO disconnect while sending and while awaiting device confirmation. The active device must retain or restore the exact draft, unlock it after reconnecting, and identify the result as not confirmed. A deletion failure must report clearly but must never create or restore an editable draft.
- Send a zone update on switch A, move to switch B before its not-confirmed result, then return to A. Switch B must not show or clear A's draft; A must reopen its own retryable values. A stale result with the wrong topic or an older request ID must have no effect.
- Cancel a restored draft and confirm it is explicitly discarded. Confirming a later successful retry must also clear it; merely receiving `sent`, switching devices, or syncing authoritative state must not.
- Delete a selected zone and verify the confirmation names both the zone and switch. Confirm the status progresses from sending to awaiting the device and then confirmed; canceling the prompt must send nothing.
- For `Clear Interference`, `Reset Detection Zones`, and `Clear Stay Zones`, verify the confirmation names the action and selected switch and explains that it cannot be undone from Switch Studio. Cancel must send nothing; accept must send exactly once. While any maintenance command is pending, all maintenance buttons must remain disabled and an attempted duplicate must be rejected. Disconnect before completion and simulate a missing response; reconnect/timeout must release the lock and allow a deliberate retry. `Auto-Config Interference` should start without a destructive confirmation.
- In the Zone Editor, keyboard-select Detection Area 1, Detection Area 2, Stay Area, and Interference Area entries. Verify the persistent guidance changes without moving focus or sending a socket command; explains Area 1's basic-range mapping, overlap and overall occupancy, stationary-presence use, independent interference masking, and the confirmed Stay Area firmware readback caveat; and updates the community source link for stay guidance.
- At desktop, 700 px, and 390 px widths, verify the zone guidance wraps without horizontal overflow, links are keyboard operable, zone controls remain at least 44 px on touch/coarse-pointer layouts, and the six coordinate inputs have explicit labels and the immediate-write/editing description.
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

## 6. Firmware Information and Connector Handoff

- Open `Power & Device` and verify the firmware workspace contains no check, schedule, install, downgrade, abort, custom-URL, or upload control. Watching the panel and switching devices must never publish an OTA request from Switch Studio.
- Confirm the cards distinguish `Installed switch firmware`, `Inovelli Production`, `Inovelli Beta`, and `Zigbee2MQTT catalog`. Exact Inovelli matches and versions derived from raw builds must be labeled differently, and an unavailable value must never display as zero or imply that the switch is up to date.
- Confirm the panel clearly distinguishes the switch's Zigbee firmware from the read-only `mmWave Firmware Version` for the sensor module.
- Verify the handoff says to open Zigbee2MQTT's OTA page and locate the selected switch. The external link must use the generic official Zigbee2MQTT OTA guide, open safely in a new tab, and must not guess or construct a local Zigbee2MQTT/Ingress URL.
- Start an availability check in Zigbee2MQTT and confirm Switch Studio passively displays checking, catalog available/no catalog update, and connector error states. Start an update only on a safe test device through Zigbee2MQTT and verify scheduled/requested, progress and remaining time, completed, and error states without exposing a Switch Studio update action.
- While an external update is progressing, deliver an older same-device snapshot after a newer firmware event. The installed/catalog values, lifecycle state, progress, and error must not roll back. A newer independent release-reference generation must still update the Inovelli cards without changing live OTA progress.
- Switch A → B while firmware events continue and verify versions, progress, errors, and source freshness never leak between topics. Return to A and confirm its latest accepted state remains intact.
- Verify fresh, refreshing-with-cache, refreshing-without-cache, partial, stale, and unavailable release-reference states. Saved values should remain visible on refresh failure, raw network exception strings should not appear in the panel, and device/Zigbee2MQTT values should remain usable when Inovelli references are unavailable.
- Take the device or connector offline and confirm cached device information remains clearly marked as potentially cached. Restoring connectivity must not briefly replace a newer state with an older snapshot.
- With a screen reader, verify firmware status and reference freshness announce politely, the progress bar reports its value and remaining time, the card groups have meaningful terms/descriptions, and the external link identifies that it opens a new tab.

## 7. Responsive and Accessibility Pass

- Validate phone, foldable/tablet, and desktop layouts with both portrait and landscape where applicable.
- On phone and tablet widths, confirm the device selector shares the header row with the Inovelli anchor, quick controls use the next row, and long device names do not cause horizontal overflow.
- Open the compact section menu from the current-page header; confirm all six sections remain one accessible tab set, selecting a section closes the menu, Escape returns focus to the menu button, and widening past the mobile breakpoint restores the desktop tab bar.
- Confirm cards, tabs, sticky actions, zone inputs, radar, and tables remain usable without accidental horizontal page scrolling.
- At 320/390px phone, landscape phone, foldable/tablet, exact 700/701px, and desktop sizes, verify both radar modes share a useful stable canvas height, the 2D/3D and Reset controls remain at least 44px, locked touch interaction does not trap page scrolling, and rotating/resizing preserves the perspective camera.
- Navigate top-level and nested Presence & Zones tabs by keyboard using Arrow keys, Home, and End.
- Confirm focus remains visible and nested tab panels retain the correct screen-reader ownership.
- Confirm the LED switch remains centered in its preview pane on desktop, tablet/foldable, and phone widths. Segment hit targets must remain at least 44px; the tablet editor should stack below without covering the switch, the phone editor should become a bounded bottom panel, and no hue/brightness drag should cause page scrolling.
- Reload and verify active top-level and nested tab persistence.

## 8. Exit Criteria

- No browser console errors or backend tracebacks during normal use.
- No writes occur while a device is offline or inventory is still restoring.
- Every write targets the selected or card-specific device and reaches a clear confirmed, not-confirmed, or error state.
- Dashboard, device switching, session isolation, zone editing, firmware status, reconnect recovery, and all responsive layouts pass.
