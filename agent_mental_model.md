# Agent Mental Model

Last updated: 2026-02-18

## Purpose and Scope
This add-on is a Zigbee2MQTT-backed Home Assistant Ingress app for configuring Inovelli Zigbee switches, currently optimized for Blue series presence-capable devices (`VZM32-SN`).

The practical product shape is:
- Schema-driven switch configuration UI across multiple tabs.
- Live presence/radar visualization and zone editing for mmWave devices.
- Session-safe multi-client usage (each browser session can target a different device).

## Runtime Architecture (Code-Level)

### Backend (`switch_studio/app.py`)
- Flask + Socket.IO app with MQTT bridge.
- Reads add-on options from `/data/options.json` with defaults fallback.
- Loads Zigbee2MQTT model definition through `SchemaService`.
- Maintains in-memory runtime state:
- `device_list` cache (discovered devices + latest config + decoded zone payloads).
- `session_topics` map (Socket.IO sid -> selected device topic).
- `session_reporting_auto_off` map (sid -> bool for target reporting auto-off behavior).

### Frontend
- Main UI is still primarily in `switch_studio/templates/index.html` (large integrated script + styles).
- Supporting modules:
- `switch_studio/static/js/app_state.js`: staged-change queue, dirty bar, apply/discard, generic command feedback.
- `switch_studio/static/js/app_tabs.js`: top tab routing + persistence.
- `switch_studio/static/js/app_zones.js`: zone command lifecycle and target rendering helpers.

## Core Data and Message Model

### Device Cache Shape
Each discovered device in `device_list` stores:
- `friendly_name`, `topic`
- `interference_zones`, `detection_zones`, `stay_zones`
- `zone_config` (primary detection bounds)
- `last_config` (latest merged config payload from MQTT)
- `last_update`, `last_seen`

### WebSocket Events
Primary inbound events from UI:
- `request_devices`, `request_schema`
- `change_device`
- `update_parameter` (staged apply path)
- `set_target_reporting` (immediate)
- `set_basic_control` (immediate on/off + brightness)
- `force_sync`
- `send_command` (zone maintenance commands)

Primary outbound events to UI:
- `device_list`, `schema_model`, `command_result`
- `device_config`, `new_data`
- `zone_config`, `interference_zones`, `detection_zones`, `stay_zones`
- `device_snapshot`

## Discovery and Ingestion Details (Underdocumented)

### Discovery Heuristic
A device is considered relevant when payload keys include:
- `mmWaveVersion`, or
- any key beginning with `mmWave` or `mmwave_`

Implication:
- Standard (non-mmWave) switches are not reliably auto-discovered unless their traffic includes those signatures.

### Raw Packet Detection
Raw mmWave packets are identified by payload bytes:
- `0 == 29`, `1 == 47`, `2 == 18`

Raw command IDs used:
- `1`: live target stream (`new_data`)
- `2`: interference zones
- `3`: detection zones
- `4`: stay zones

Target-frame throttle:
- cmd `1` is processed at ~10 Hz (`>= 0.1s` interval) per device to reduce churn.

### Standard Config Update Behavior
- Non-numeric keys from MQTT payload are treated as config and merged into `last_config`.
- Zone bounds in `zone_config` are updated when `mmWaveWidth/Depth Min/Max` appear.

## Session Isolation Model

The app intentionally routes commands by socket session:
- `change_device` binds the sid to an exact topic.
- Writes use the sid-bound topic, not a global selected device.
- `command_result` is emitted back to the originating sid.

Auto-off target reporting safety:
- On disconnect, auto-disable publishes only when:
- that sid had auto-off enabled,
- sid had a selected topic,
- and no other active sid is still mapped to that same topic.

## UI Interaction Model

### Two Command Paths
1. Staged configuration path:
- Most schema fields queue in pending changes.
- `Apply Changes` emits one `update_parameter` per queued field.
- `Discard` restores controls from last known config.

2. Immediate command path:
- Target reporting toggle and top-bar basic controls publish immediately.
- These are intentionally outside pending-change batching.

### Basic Controls (Top Bar)
- Power toggle + brightness slider/number are immediate writes via `set_basic_control`.
- UI brightness is 0-100%, converted to 0-254 for Zigbee payload.
- If brightness is changed while currently OFF, frontend includes state ON for predictable behavior.
- Backend clamps brightness to valid range.

### Occupancy Gate Behavior
- Live target rendering is suppressed unless occupancy is active.
- When occupancy is clear, targets/history are cleared to prevent stale radar dots.

## Schema System Behavior (Important for Future Expansion)

`SchemaService`:
- Loads definition JSON from configured path list.
- Infers tabs/sections via `_infer_tab` and `_infer_section` keyword logic.
- Validates writes via `validate_update`.

Notable design decision:
- Unknown fields are allowed (forward compatibility), but read-only known fields are blocked.

Implication:
- New firmware fields can often be sent without code changes.
- But label/placement quality still depends on tab/section inference and explicit friendly mapping.

## Persistence and Client-Side Stored State

Known localStorage keys:
- `switchStudio.activeTab`
- `switchStudio.zonesSidebarTab`
- `switchStudio.targetReportAutoOff`
- radar view keys (`vizShow*`, `vizXMin`, `vizXMax`, `vizYMin`, `vizYMax`, etc.)

Behavioral note:
- Stored legacy tab ids are remapped in tab logic (`maintenance` -> `advanced`, older presence/live ids -> current zones mapping logic).

## Operational / Maintenance Notes Not in README

- `switch_studio/templates/index.html` is the highest-coupling file; many behaviors are co-located there.
- Running tests can mutate `switch_studio/__pycache__/app.cpython-310.pyc`; avoid committing that.
- MQTT `/get` responses are intentionally ignored for direct device-topic state updates to avoid false zone writes.
- Device cleanup thread drops stale devices after ~1 hour of inactivity.
- Template fingerprint + tab-enabled flags are logged at startup; this is useful for diagnosing stale image/update issues in Home Assistant.

## Known Fragility Points

- Discovery is mmWave-key biased (future non-mmWave expansion may need broader discovery logic).
- Large inline script in `index.html` increases regression risk for UI refactors.
- A few QA docs still refer to older tab naming/flow and can drift from current implementation.

## Practical Extension Strategy

For adding new switch families with minimal risk:
1. Extend discovery criteria first.
2. Keep schema-driven rendering as default path.
3. Add targeted friendly labels and section placement overrides only where needed.
4. Gate advanced/unsupported fields through conditional section toggles instead of hard-forking templates.
5. Preserve session-topic routing invariants to avoid cross-device writes.
