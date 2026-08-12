# Inovelli Switch Studio

Inovelli Switch Studio is a community Home Assistant App (formerly add-on) for discovering, monitoring, and configuring Inovelli Blue Series Zigbee devices through Zigbee2MQTT.

It combines a multi-device dashboard with a full VZM32-SN configuration workspace: live 2D/3D presence radar, visual zone editing, LED-bar previews and notification effects, schema-driven device settings, and clear firmware information from the switch, Inovelli, and Zigbee2MQTT.

> This is a community project, not an official Inovelli, Home Assistant, or Zigbee2MQTT product.

## Highlights

- Discover eligible Inovelli `VZM*` devices from Zigbee2MQTT inventory and monitor them from one dashboard.
- Use confirmed power and brightness quick controls without changing the active device.
- Open the complete six-section VZM32-SN editor for Presence & Zones, Load & Dimming, LED & Notifications, Buttons & Scenes, Power & Device (including firmware), and Advanced settings.
- Track live XYZ targets in a full-size Cartesian 2D radar or an orbitable 3D scene.
- Draw detection, stay, and interference zones in 2D, then inspect their exact volumes in 3D.
- Preview separate On and Off LED defaults, customize all seven physical segments, and animate all-bar or individual notification effects locally before sending them.
- Stage configuration fields safely, validate them, publish them in one MQTT payload, and wait for matching device reports before considering them confirmed.
- Use a responsive Home Assistant Ingress interface with a compact mobile section menu, touch-sized controls, and opt-in 3D interaction that does not trap page scrolling.

## Compatibility

| Device or platform | Support |
|---|---|
| Inovelli Blue Series `VZM32-SN` | Full editor, 2D/3D radar, target telemetry, zone tools, LED editor, configuration, and read-only firmware workspace |
| Other eligible Inovelli `VZM*` models | Dashboard discovery and only the unambiguous writable quick controls exposed by Zigbee2MQTT |
| ZHA | Not supported |
| Home Assistant installation | Home Assistant Operating System on `amd64` or `aarch64` |

Switch Studio ignores inventory entries marked disabled, unsupported, or interview-incomplete. Remaining entries must be identified by Zigbee2MQTT as Inovelli and use a `VZM*` model ID. The full editor is intentionally restricted to the exact `VZM32-SN` model until other models have verified field and command mappings.

## Requirements

- [Home Assistant Operating System](https://www.home-assistant.io/installation/)
- [Zigbee2MQTT](https://www.zigbee2mqtt.io/) and its MQTT broker
- At least one eligible Inovelli Blue Series Zigbee device
- A browser able to open the App through Home Assistant Ingress
- Outbound browser access to the currently CDN-hosted Socket.IO, Plotly, and DM Sans assets
- Outbound internet access from the App for firmware-reference lookup and from Zigbee2MQTT for OTA downloads

Switch Studio and Zigbee2MQTT must connect to the same MQTT broker. Zigbee2MQTT must publish its normal device inventory at `<mqtt_base_topic>/bridge/devices`; `core-mosquitto` is only the default broker hostname, and blank credentials work only when the broker permits them.

## Installation

Home Assistant renamed add-ons to **Apps** in 2026.2. Apps are available on Home Assistant Operating System under **Settings → Apps**.

### Choose a channel

| Channel | Repository URL | Intended use |
|---|---|---|
| Stable | `https://github.com/vash2695/inovelli-switch-studio` | Recommended for normal use; follows `main` |
| Development | `https://github.com/vash2695/inovelli-switch-studio#dev` | Preview and QA builds; may change quickly |

Feature descriptions follow the branch you are reading, so `dev` may be ahead of the stable App. Install only the channel you intend to use; both repositories expose an App with the same display name.

### Add and start the App

1. In Home Assistant, open **Settings → Apps → Install app**.
2. Open the three-dot menu, choose **Repositories**, and add the repository URL for your chosen channel.
3. Select **Inovelli Switch Studio** and choose **Install**.
4. Open the App's **Configuration** tab and enter the MQTT settings described below.
5. Save, then start or restart the App.
6. Choose **Open Web UI**. Optionally enable **Show in sidebar**.

The web interface is exposed only through Home Assistant Ingress; the App does not publish a separate host port. Direct HTTP and Socket.IO clients are rejected unless they are the Home Assistant ingress proxy. Configuration options are read when the App starts, so restart it after changing them.

## App configuration

| Option | Description | Default |
|---|---|---|
| `mqtt_broker` | MQTT broker hostname reachable from the App | `core-mosquitto` |
| `mqtt_port` | MQTT broker port | `1883` |
| `mqtt_username` | MQTT username, if required | `""` |
| `mqtt_password` | MQTT password, if required | `""` |
| `mqtt_base_topic` | Zigbee2MQTT base topic | `zigbee2mqtt` |
| `switch_studio_ui` | Enable the modern dashboard and tabbed workspace; `false` keeps the limited legacy layout | `true` |

If discovery remains empty, confirm the broker credentials, base topic, Zigbee2MQTT bridge status, and App logs before changing device settings.

## VZM32-SN target reporting

Current Zigbee2MQTT normally creates the endpoint-1 `manuSpecificInovelliMMWave` binding while configuring a VZM32-SN. To receive live coordinates:

1. Pair or reconfigure the switch with a current Zigbee2MQTT release and confirm its interview completed.
2. Open the switch in Switch Studio.
3. Enable **Target Reporting** in the live status strip.

If occupancy arrives but target coordinates do not, reconfigure the device in Zigbee2MQTT or verify that endpoint 1 is bound to `manuSpecificInovelliMMWave`, then try Target Reporting again.

Target reports can add substantial Zigbee traffic while a target is present. Disable reporting when it is not needed, or enable **Auto-off reporting on disconnect** in the View panel. Auto-off is opt-in and waits until the last Switch Studio session using that device disconnects.

## Using Switch Studio

### Dashboard and device selection

The dashboard is the first view and keeps one stable card per eligible device. Cards show availability and known telemetry, use `—` rather than false zeroes for unknown values, and expose only controls that Zigbee2MQTT identifies unambiguously.

Power and brightness commands target the card's exact MQTT topic. Each browser session keeps its own selected device, so separate sessions can monitor different switches without changing one another's workspace.

### Presence, radar, and zones

- **2D is the canonical editor.** It shows the top-down Cartesian map, live target trails, reference shading outside Zigbee2MQTT's currently documented X ±600 cm and forward Y 0–600 cm write range, and draggable zone geometry. Reported targets and configured zones remain visible beyond that reference range.
- **3D is visualization-only.** It renders exact target XYZ positions and authored detection, stay, and interference cuboids. Starting a zone draft temporarily returns to 2D and restores the preferred view afterward.
- **The transition is reversible.** The selected radar mode is remembered in the browser, and the 3D camera orbits, changes elevation, and zooms around a fixed focus while keeping world Z upright.
- **Zones are never visually truncated.** The rendered axes expand with padding when necessary to show complete configured cuboids beyond the saved display envelope; the underlying coordinates are not stretched or rewritten.
- **The FOV is a reference, not a zone.** In 3D, borderless 120° and 150° horizontal envelopes show the sensor's forward reference area and span the visible height. They do not imply a vertical beam angle or replace the switch's authored zone limits.
- **The grid is deterministic.** 3D uses one subdued floor-only lattice across the rendered X/Y area, with no camera-selected wall or ceiling grids. The switch itself remains the origin at `(0, 0, 0)`.

Zone types have distinct jobs:

- **Detection Areas 1–4** are independently reported active-presence regions and may overlap. Area 1 is also controlled by the switch's basic X/Y/Z range fields; it is not a separate global or fifth zone. Overall occupancy is active when any configured detection area is occupied.
- **Stay Areas** complement detection areas where someone may remain nearly still, such as a desk, sofa, bed, or toilet. They are normally placed inside or overlapping an active detection area and do not have separate occupancy badges.
- **Interference Areas** are independent exclusion masks. Targets inside them do not report presence, even when the mask overlaps a detection area; their numbers are storage slots rather than pairings with detection-area numbers.

Switch Studio shows selection-aware guidance and links to Inovelli's [official advanced configuration guide](https://help.inovelli.com/en/articles/12773613-blue-series-mmwave-presence-dimmer-switch-advanced-mmwave-configuration) and the community's [area configuration discussion](https://community.inovelli.com/t/presence-area-configuration-best-practice/20933). [Inovelli has confirmed](https://community.inovelli.com/t/having-trouble-understanding-blue-mmwave-vzm32-sn-stay-settings-parameters/21585/4) a switch-firmware bug can return Stay Area X coordinates mirrored or with min/max swapped, so verify the reported zone position after applying a stay-area change.

The View panel controls zone visibility and the radar display envelope. X/Y display bounds affect both views. Z display bounds affect 3D, are stored per device in the current browser, and do not change the switch configuration. **Apply Height to All Switches** copies only the current Z display bounds to compatible switches already discovered in that browser; it sends no MQTT command and does not become a default for future devices.

### Configuration sections

- **Presence & Zones** — live telemetry, target reporting, zone editing, presence behavior, room configuration, and maintenance commands
- **Load & Dimming** — dimming levels, ramp timing, paddle response, and linked timing controls
- **LED & Notifications** — persistent LED defaults, per-segment customization, and notification effects
- **Buttons & Scenes** — tap, scene, and paddle behavior
- **Power & Device** — read-only firmware and OTA status, electrical reporting, protection, and device operation
- **Advanced** — lower-frequency fields and conditionally relevant model settings

The controls are schema-driven, with friendlier names and grouping layered over the Zigbee2MQTT definition. Read-only diagnostics stay read-only, and unsupported or ambiguous device controls are not guessed.

### LED defaults and notification effects

The VZM32-SN visual editor owns the switch's all-LED defaults and seven physical segments:

- Preview separate **On** and **Off** states.
- Choose a preset or custom hue and set brightness for the full bar.
- Let a segment follow the all-LED defaults, or customize its color, brightness, and lit state.
- See adjacent segment colors blend across the rendered diffuser.
- Select an all-bar or individual effect to start a local preview immediately, even when physical commands are unavailable.
- Use **Send effect** for the immediate device command. Selecting or previewing an effect does not stage persistent defaults or send on its own.
- Treat **Clear effect** and **Off** as distinct device actions.

Persistent LED defaults follow the normal staged-change workflow. Notification effects are immediate commands. Local animations follow Inovelli's published simulator patterns and physical LED direction; exact pacing can vary with installed firmware.

### Firmware information

The Power & Device section presents the switch firmware reported by Zigbee2MQTT, Inovelli's published Production and Beta releases, Zigbee2MQTT's last catalog result, source freshness, and any passive OTA progress or error state. Exact source matches and versions derived from raw build numbers are identified separately.

Switch Studio does not check, schedule, install, downgrade, or abort firmware. Manage those operations in Zigbee2MQTT's OTA page; Switch Studio continues to display progress reported by Zigbee2MQTT when an update is initiated there. See the [official Zigbee2MQTT OTA guide](https://www.zigbee2mqtt.io/information/ota_updates.html) for update behavior and precautions.

The switch's Zigbee firmware and the mmWave sensor module firmware are separate. The firmware workspace describes the switch firmware; **mmWave Firmware Version** remains a distinct read-only diagnostic and can legitimately show a different version.

## Change and command safety

Switch Studio deliberately separates staged configuration from immediate actions:

- Configuration fields and persistent LED defaults are staged in the current page until **Apply Changes**.
- Apply validates the staged fields and publishes them together in one MQTT `/set` payload.
- Publish success is not treated as device confirmation. Requested fields stay in flight until matching device reports confirm every value; failures and timeouts return values to a retryable state.
- **Discard** removes unsent staged values and zone drafts and restores the latest authoritative device snapshot. It cannot cancel a write that was already published.
- The zone editor panel's **Apply Changes** sends that zone immediately. The bottom action bar's **Apply Changes** can also submit an active zone draft, but the zone remains a separate write from the configuration payload.
- Dashboard controls, Target Reporting, maintenance commands, and notification effects are immediate operations. Firmware management is intentionally delegated to Zigbee2MQTT.
- Controls disable while Socket.IO, MQTT, inventory, or the target device is unavailable. There is no durable offline command queue or delayed replay.

Pending edits live only in page memory and are lost on reload. Browser preferences such as the active section, radar mode, per-device display height, and reporting auto-off are local UI state rather than device configuration.

## Mobile and accessibility behavior

- The device selector stays in the header; quick controls move to a second row when space is tight.
- A hamburger disclosure replaces the desktop tab strip while preserving one keyboard-accessible six-section tab set.
- Touch targets remain usable at phone and coarse-pointer tablet sizes.
- On touch devices, **Explore 3D** unlocks orbit/zoom and **Done** restores normal page scrolling.
- The target table remains the textual equivalent of the radar canvas.
- Reduced-motion preferences skip camera animation while preserving the same final state.

## Known limitations

- Full-editor and radar support are currently verified only for `VZM32-SN`.
- ZHA is not supported; Switch Studio communicates through Zigbee2MQTT and MQTT.
- The 3D scene is for inspection only; zone drawing and editing remain in 2D.
- Pending edits are not persisted across page reloads.
- The UI currently loads Socket.IO, Plotly, and DM Sans from public CDNs, so it is not fully offline even when MQTT is local.
- Firmware information depends on device reports, Zigbee2MQTT catalog state, and periodically refreshed Inovelli references; each can be temporarily unavailable or cached independently.
- LED preview timing is simulator-based and may differ slightly from device firmware.

## Roadmap

- Expand verified full-editor support to additional Inovelli Blue Series models.
- Continue improving model-aware naming, grouping, contextual guidance, and conditional controls.

## Development and validation

### Python environment

Create a virtual environment and install the App's runtime dependencies before running backend tests:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r switch_studio/requirements.txt
python -m unittest discover -s tests/python -p "test_*.py" -v
```

Production traffic is restricted to Home Assistant's ingress proxy. For deliberate local browser QA, start the process with `SWITCH_STUDIO_ALLOW_LOCAL_DIRECT=true`; this permits loopback clients only and prints a startup warning. Never enable that override in the Home Assistant App.

MQTT-producing browser commands also have bounded per-session and global throughput. A burst may return a retryable `rate_limited` or `server_busy` result; the UI should leave the requested action ready to retry rather than treating it as device confirmation.

### Frontend tests

The frontend tests use Node's built-in test runner and do not require an npm install:

```powershell
node --test tests/frontend/*.test.js
```

Manual release validation is tracked in the [Home Assistant Ingress QA checklist](docs/HOME_ASSISTANT_INGRESS_QA_CHECKLIST.md).

The App version advertised by a branch is defined in [`switch_studio/config.yaml`](switch_studio/config.yaml). Home Assistant repository channels are branch-driven rather than release-tag-driven.

## Acknowledgments

Switch Studio grew from Nick D's original [`mmwave_vis`](https://github.com/nickduvall921/mmwave_vis) project. Many thanks for the live-radar and zone-visualization foundation that made this broader configuration studio possible.

## License

GNU General Public License v3.0.
