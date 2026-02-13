# :sparkles: Inovelli Switch Studio

A modern Home Assistant add-on for monitoring and configuring Inovelli Zigbee devices through Zigbee2MQTT.

## :pray: Original Project Credit

This project is built on the original `mmwave_vis` foundation by **Nick D**.

Huge thanks for creating the initial tooling that made this expanded Switch Studio experience possible.

## :rocket: What We Added Since `mmwave_vis`

- Expanded from a radar visualizer into a broader configuration studio
- Added a polished multi-tab workflow (`Presence & Zones`, `Load & Dimming`, `LED & Notifications`, `Buttons & Scenes`, `Power & Device`, `Advanced`)
- Added schema-driven configuration rendering with friendlier naming and grouping
- Added a pending-changes workflow with explicit `Apply Changes` and `Discard`
- Added session-scoped device selection so multiple sessions can safely monitor different devices
- Added stronger mobile responsiveness for Home Assistant app usage
- Added richer Presence & Zones tooling (zone editor, inline zone status, live target telemetry)
- Added in-strip `Target Reporting` control with optional auto-off on disconnect

## Current UI
<img width="3516" height="1986" alt="image" src="https://github.com/user-attachments/assets/8cac3ba6-b850-4cf6-8b25-5f9fef140c5c" />

## :dart: Current Scope

Primary target today:
- Inovelli Blue Series `VZM32-SN` (mmWave presence model)

## :jigsaw: Core Capabilities

- Auto-discovery of compatible devices from MQTT traffic
- Session-scoped device selection per browser session
- Live Presence & Zones workflow with radar map editing, zone status, and target telemetry
- Tabbed configuration for frequent-use and advanced settings
- Conditional section support for model-specific parameters (for example, shared fan-related fields)
- Sticky pending-changes action bar that appears only when changes exist

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
- `LED & Notifications`: LED presets, effects, and notification controls
- `Buttons & Scenes`: scene and paddle behavior
- `Power & Device`: device-level power and operational settings
- `Advanced`: lower-frequency settings plus conditional model-specific sections

## :arrows_counterclockwise: Change Handling Model

- Field edits are staged locally as pending changes
- `Apply Changes` sends a batched update
- `Discard` reverts staged edits to latest known device state
- `Target Reporting` from the live strip applies immediately for fast troubleshooting

## :world_map: Roadmap

- Expand coverage to additional Inovelli switch models
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
