# :sparkles: Inovelli Switch Studio

A modern Home Assistant add-on for monitoring and configuring Inovelli Zigbee devices through Zigbee2MQTT.

## :pray: Original Project Credit

This project is built on the original `mmwave_vis` foundation by **Nick D**.

Huge thanks for creating the initial tooling that made this expanded Switch Studio experience possible.

## :rocket: What We Added Since `mmwave_vis`

- Expanded from a radar visualizer into a broader configuration studio
- Added a polished multi-tab workflow (`Presence & Zones`, `Load & Dimming`, `LED & Notifications`, `Buttons & Scenes`, `Power & Device`, `Advanced`)
- Added an all-device dashboard with live status plus immediate power and dimming controls
- Added schema-driven configuration rendering with friendlier naming and grouping
- Added a confirmation-aware pending-changes workflow with explicit `Apply Changes` and `Discard`
- Added session-scoped device selection so multiple sessions can safely monitor different devices
- Added reconnect-safe device inventory, availability, and command recovery
- Added stronger mobile responsiveness for Home Assistant app usage
- Added richer Presence & Zones tooling (zone editor, inline zone status, live target telemetry)
- Added an interactive VZM32-SN LED-bar editor with a product preview, segment controls, and custom hue selection
- Added in-strip `Target Reporting` control with optional auto-off on disconnect
- Added Zigbee2MQTT OTA status, update checks, and catalog-only installation controls

## Current UI
<img width="3516" height="1986" alt="image" src="https://github.com/user-attachments/assets/8cac3ba6-b850-4cf6-8b25-5f9fef140c5c" />

## :dart: Current Scope

Primary full-editor target today:
- Inovelli Blue Series `VZM32-SN` (mmWave presence model)

Other discovered Blue Series devices use conservative, expose-derived dashboard controls. Models without a verified full-editor mapping remain quick-controls only.

## :jigsaw: Core Capabilities

- Inventory-driven discovery from Zigbee2MQTT, with a conservative traffic fallback for VZM32-SN
- Dashboard cards for every discovered device, including availability and supported quick controls
- Session-scoped device selection per browser session
- Live Presence & Zones workflow with radar map editing, zone status, and target telemetry
- Tabbed configuration for frequent-use and advanced settings
- Visual VZM32-SN LED defaults editor with On/Off previews, global controls, and seven individually selectable segments
- Conditional section support for model-specific parameters (for example, shared fan-related fields)
- Sticky pending-changes action bar that appears only when changes exist
- Exact device-echo confirmation for writes, with retry-safe timeout and reconnect behavior

## :white_check_mark: Requirements

- Home Assistant OS or Home Assistant Supervised
- Zigbee2MQTT (ZHA is not currently supported by this add-on)
- Inovelli Zigbee switch(es)
- For radar/zone presence features: `VZM32-SN`

## :hammer_and_wrench: Installation

1. In Home Assistant, open `Settings -> Add-ons`.
2. Open the Add-on Store.
3. Add this repository URL under `Repositories`: `https://github.com/vash2695/inovelli-switch-studio`.
4. Install `Inovelli Switch Studio`.

## :gear: Add-on Options

| Option | Description | Default |
|---|---|---|
| `mqtt_broker` | MQTT broker hostname | `core-mosquitto` |
| `mqtt_port` | MQTT broker port | `1883` |
| `mqtt_username` | MQTT username (if required) | `""` |
| `mqtt_password` | MQTT password (if required) | `""` |
| `mqtt_base_topic` | Zigbee2MQTT base topic | `"zigbee2mqtt"` |
| `switch_studio_ui` | Enables the modern tabbed UI (`false` keeps legacy fallback behavior) | `true` |

## :satellite: Zigbee2MQTT Notes for VZM32-SN

For live target coordinates and radar updates:

1. Bind `manuSpecificInovelliMMWave` on source endpoint `1` in Zigbee2MQTT.
2. Use the in-app `Target Reporting` control when live target streaming is needed.

## :desktop_computer: UI Overview

### Presence & Zones

- Top live strip for packet/telemetry status, illuminance, and target-reporting state
- Radar map with zone overlays and editor interactions
- Zone status row directly below the map (optimized for desktop and mobile)
- Right panel views: `Controls & Zones`, `Configuration`, and `View`

### Other Tabs

- `Load & Dimming`: daily dimming/load behavior
- `LED & Notifications`: interactive LED-bar defaults, custom colors, effects, and notification controls
- `Buttons & Scenes`: scene and paddle behavior
- `Power & Device`: device-level power and operational settings
- `Advanced`: lower-frequency settings plus conditional model-specific sections

## :arrows_counterclockwise: Change Handling Model

- Field edits are staged locally as pending changes
- `Apply Changes` sends one atomic batch and waits for the device echo
- `Discard` reverts staged edits to latest known device state
- Zone edits have their own immediate `Apply Zone` action and also participate in the main apply action
- Switching devices prompts before discarding staged configuration or a zone draft
- Dashboard power/dimming, target reporting, and zone maintenance commands apply immediately
- `Target Reporting` from the live strip applies immediately for fast troubleshooting

## :world_map: Roadmap

- Add a height-aware 3D radar visualization alongside the existing 2D editor
- Add a local firmware-upload workflow for internet-independent updates
- Expand verified full-editor coverage to additional Inovelli Blue Series models
- Continue improving parameter presentation (naming, grouping, contextual guidance, and clarity)
- Add more conditional UI behavior as model-specific capabilities are introduced

## :test_tube: Development and Validation

Backend tests:

```powershell
python -m unittest discover -s tests/python -p "test_*.py" -v
```

Frontend tests:

```powershell
node --test tests/frontend/*.test.js
```

Manual QA checklist:

- `docs/HOME_ASSISTANT_INGRESS_QA_CHECKLIST.md`

## :page_facing_up: License

GNU General Public License v3.0
