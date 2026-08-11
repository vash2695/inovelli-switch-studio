import json
import os
import unittest
from types import SimpleNamespace
from unittest.mock import patch

os.environ["SWITCH_STUDIO_TEST_MODE"] = "1"

from switch_studio import app as app_module  # noqa: E402


def _make_device(name, topic, model="VZM32-SN", capabilities=None):
    device = {
        "friendly_name": name,
        "topic": topic,
        "manufacturer": "Inovelli",
        "model": model,
        "capabilities": {"state": True, "brightness": True, "presence": True, "zones": True},
        "availability": None,
        "inventory_present": False,
        "interference_zones": [],
        "detection_zones": [],
        "stay_zones": [],
        "zone_config": dict(app_module.DEFAULT_GLOBAL_ZONE_CONFIG),
        "last_config": {},
        "ota_status": app_module.default_ota_status(),
        "last_update": 0,
        "last_seen": 0,
    }
    if capabilities:
        device["capabilities"].update(capabilities)
    return device


def _int16_to_le_bytes(value):
    raw = int(value).to_bytes(2, byteorder="little", signed=True)
    return raw[0], raw[1]


def _raw_zone_packet(command_id, zones):
    payload = {"0": 29, "1": 47, "2": 18, "3": 1, "4": command_id, "5": len(zones)}
    offset = 6
    for zone in zones:
        values = (
            zone.get("x_min", 0), zone.get("x_max", 0),
            zone.get("y_min", 0), zone.get("y_max", 0),
            zone.get("z_min", 0), zone.get("z_max", 0),
        )
        for value in values:
            low, high = _int16_to_le_bytes(value)
            payload[str(offset)] = low
            payload[str(offset + 1)] = high
            offset += 2
    return payload


class AppBackendTests(unittest.TestCase):
    def setUp(self):
        with app_module.device_list_lock:
            app_module.device_list.clear()
            app_module.device_availability_cache.clear()
            for name in ("device_a", "device_b", "device_shared"):
                topic = f"zigbee2mqtt/{name}"
                app_module.device_list[name] = _make_device(name, topic)
        with app_module.session_topics_lock:
            app_module.session_topics.clear()
        with app_module.session_reporting_auto_off_lock:
            app_module.session_reporting_auto_off.clear()
        with app_module.pending_writes_lock:
            pending_entries = list(app_module.pending_writes.values())
            app_module.pending_writes.clear()
        for entry in pending_entries:
            app_module._cancel_pending_timer(entry)
        with app_module.ota_requests_lock:
            app_module.ota_requests.clear()
        with app_module.mqtt_state_lock:
            app_module.mqtt_state.update({
                "connected": False,
                "broker_connected": False,
                "zigbee2mqtt_connected": None,
                "inventory_ready": False,
                "reason": "Starting",
                "updated_at": 0,
            })
        self.clients = []

    def tearDown(self):
        for client in self.clients:
            try:
                client.disconnect()
            except Exception:
                pass

    def _client(self):
        client = app_module.socketio.test_client(app_module.app)
        self.clients.append(client)
        return client

    @staticmethod
    def _command_results(client, action=None):
        results = [event["args"][0] for event in client.get_received() if event["name"] == "command_result"]
        if action is not None:
            results = [result for result in results if result.get("action") == action]
        return results

    def test_as_int_or_none_parsing(self):
        self.assertEqual(app_module._as_int_or_none(10), 10)
        self.assertEqual(app_module._as_int_or_none(10.9), 10)
        self.assertEqual(app_module._as_int_or_none(" 55 "), 55)
        self.assertEqual(app_module._as_int_or_none("12.7"), 12)
        self.assertIsNone(app_module._as_int_or_none(""))
        self.assertIsNone(app_module._as_int_or_none("nan-value"))

    def test_values_equal_allows_expected_nested_subset(self):
        self.assertTrue(app_module._values_equal(
            {"area1": {"width_min": 10, "width_max": 20}},
            {
                "area1": {"width_min": 10, "width_max": 20, "depth_min": 0, "depth_max": 100},
                "area2": {"width_min": 0, "width_max": 0},
            },
        ))
        self.assertFalse(app_module._values_equal(
            {"area1": {"width_min": 10}},
            {"area1": {"width_min": 11}},
        ))

    def test_mqtt_health_tracks_broker_and_zigbee2mqtt_bridge(self):
        subscribed = []
        fake_client = SimpleNamespace(subscribe=lambda topic: subscribed.append(topic))
        with patch.object(app_module.socketio, "emit"):
            app_module.on_connect(fake_client, None, {}, 0)
            state = app_module.get_mqtt_state()
            self.assertTrue(state["broker_connected"])
            self.assertIsNone(state["zigbee2mqtt_connected"])
            self.assertFalse(state["connected"])
            self.assertEqual(state["reason"], "Waiting for Zigbee2MQTT")
            self.assertEqual(subscribed, ["zigbee2mqtt/#"])

            offline = SimpleNamespace(
                topic="zigbee2mqtt/bridge/state",
                payload=json.dumps({"state": "offline"}).encode("utf-8"),
            )
            app_module.on_message(None, None, offline)
            state = app_module.get_mqtt_state()
            self.assertTrue(state["broker_connected"])
            self.assertFalse(state["zigbee2mqtt_connected"])
            self.assertFalse(state["connected"])

            online = SimpleNamespace(topic="zigbee2mqtt/bridge/state", payload=b"online")
            app_module.on_message(None, None, online)
            state = app_module.get_mqtt_state()
            self.assertTrue(state["zigbee2mqtt_connected"])
            self.assertTrue(state["connected"])

            app_module.on_disconnect(fake_client, None, 1)
            state = app_module.get_mqtt_state()
            self.assertFalse(state["broker_connected"])
            self.assertFalse(state["connected"])

    def test_mqtt_startup_starts_reconnect_loop_even_if_initial_setup_raises(self):
        calls = []

        class FakeClient:
            def reconnect_delay_set(self, min_delay, max_delay):
                calls.append(("delays", min_delay, max_delay))

            def connect_async(self, host, port, keepalive):
                calls.append(("connect", host, port, keepalive))
                raise OSError("broker unavailable")

            def loop_start(self):
                calls.append(("loop_start",))

        app_module.start_mqtt_client(FakeClient())
        self.assertEqual(calls[0], ("delays", 1, 30))
        self.assertEqual(calls[1][0], "connect")
        self.assertEqual(calls[2], ("loop_start",))

    def test_publish_json_uses_non_buffering_qos_zero(self):
        publish_result = SimpleNamespace(rc=app_module.mqtt.MQTT_ERR_SUCCESS)
        with patch.object(app_module.mqtt_client, "publish", return_value=publish_result) as publish_mock:
            ok, rc = app_module.publish_json(
                "zigbee2mqtt/device_a/set",
                {"state": "ON"},
                origin="test",
                sid="test-sid",
            )
        self.assertTrue(ok)
        self.assertEqual(rc, app_module.mqtt.MQTT_ERR_SUCCESS)
        self.assertEqual(publish_mock.call_args.kwargs["qos"], 0)

    def test_build_force_sync_payload_uses_readable_schema_fields(self):
        fake_schema = {
            "fields": [
                {"name": "occupancy", "can_read": True},
                {"name": "mmWaveVersion", "can_read": True},
                {"name": "write_only_field", "can_read": False},
                {"name": None, "can_read": True},
                "invalid",
            ]
        }
        with patch.object(app_module.schema_service, "get_schema", return_value=fake_schema):
            payload = app_module.build_force_sync_payload()
        self.assertEqual(payload, {"occupancy": "", "mmWaveVersion": "", "state": "", "brightness": ""})

    def test_blue_series_capabilities_use_exact_nested_control_exposes(self):
        definition = {
            "exposes": [
                {
                    "type": "light",
                    "features": [
                        {"property": "state", "access": 7},
                        {"property": "brightness", "access": 7},
                    ],
                },
                {"property": "brightnessLevelForDoubleTapUp", "access": 7},
                {"property": "occupancy", "access": 5},
                {"property": "mmWaveTargetInfoReport", "access": 7},
            ],
        }
        capabilities = app_module.infer_blue_series_capabilities(definition, "VZM32-SN")
        self.assertTrue(capabilities["state"])
        self.assertTrue(capabilities["brightness"])
        self.assertTrue(capabilities["presence"])
        self.assertTrue(capabilities["zones"])
        self.assertEqual(capabilities["state_property"], "state")
        self.assertEqual(capabilities["brightness_property"], "brightness")
        self.assertFalse(capabilities["quick_controls_ambiguous"])

        query = app_module.get_initial_control_query({"capabilities": capabilities})
        self.assertEqual(query, {"state": "", "brightness": ""})

    def test_fan_and_multi_load_capabilities_are_conservative(self):
        fan_definition = {
            "exposes": [
                {
                    "type": "fan",
                    "features": [
                        {"property": "fan_state", "access": 7},
                        {"property": "fan_mode", "access": 7},
                    ],
                },
                {"property": "brightnessLevelForDoubleTapUp", "access": 7},
            ],
        }
        fan_capabilities = app_module.infer_blue_series_capabilities(fan_definition, "VZM35-SN")
        self.assertTrue(fan_capabilities["state"])
        self.assertFalse(fan_capabilities["brightness"])
        self.assertEqual(fan_capabilities["state_property"], "fan_state")
        self.assertEqual(
            app_module.get_initial_control_query({"capabilities": fan_capabilities}),
            {"fan_state": ""},
        )

        multi_load_definition = {
            "exposes": [
                {
                    "type": "light",
                    "features": [
                        {"property": "state", "access": 7},
                        {"property": "brightness", "access": 7},
                    ],
                },
                {
                    "type": "fan",
                    "features": [
                        {"property": "fan_state", "access": 7},
                        {"property": "fan_mode", "access": 7},
                    ],
                },
            ],
        }
        multi_capabilities = app_module.infer_blue_series_capabilities(multi_load_definition, "VZM36")
        self.assertTrue(multi_capabilities["quick_controls_ambiguous"])
        self.assertFalse(multi_capabilities["state"])
        self.assertFalse(multi_capabilities["brightness"])
        self.assertEqual(app_module.get_initial_control_query({"capabilities": multi_capabilities}), {})

        multi_topic = "zigbee2mqtt/Blue Canopy"
        with app_module.device_list_lock:
            app_module.device_list["Blue Canopy"] = _make_device(
                "Blue Canopy",
                multi_topic,
                model="VZM36",
                capabilities=multi_capabilities,
            )
        app_module.on_message(
            None,
            None,
            SimpleNamespace(
                topic=multi_topic,
                payload=json.dumps({"state": "ON", "brightness": 120, "fan_state": "ON"}).encode("utf-8"),
            ),
        )
        with app_module.device_list_lock:
            retained_capabilities = app_module.device_list["Blue Canopy"]["capabilities"]
            self.assertFalse(retained_capabilities["state"])
            self.assertFalse(retained_capabilities["brightness"])
        self.assertEqual(
            app_module.get_basic_control_mapping(app_module.get_device_by_topic(multi_topic)),
            {"state": None, "brightness": None},
        )

    def test_read_only_exposes_do_not_enable_quick_controls_or_queries(self):
        capabilities = app_module.infer_blue_series_capabilities(
            {
                "exposes": [
                    {
                        "type": "light",
                        "features": [
                            {"property": "state", "access": 1},
                            {"property": "brightness", "access": 5},
                        ],
                    },
                ],
            },
            "VZM31-SN",
        )
        self.assertFalse(capabilities["state"])
        self.assertFalse(capabilities["brightness"])
        self.assertEqual(app_module.get_initial_control_query({"capabilities": capabilities}), {})

        topic = "zigbee2mqtt/Read Only Blue"
        with app_module.device_list_lock:
            app_module.device_list["Read Only Blue"] = _make_device(
                "Read Only Blue",
                topic,
                model="VZM31-SN",
                capabilities=capabilities,
            )
        app_module.on_message(
            None,
            None,
            SimpleNamespace(
                topic=topic,
                payload=json.dumps({"state": "ON", "brightness": 80}).encode("utf-8"),
            ),
        )
        device = app_module.get_device_by_topic(topic)
        self.assertFalse(device["capabilities"]["state"])
        self.assertFalse(device["capabilities"]["brightness"])
        self.assertEqual(
            app_module.get_basic_control_mapping(device),
            {"state": None, "brightness": None},
        )

    def test_resolve_target_reporting_value_uses_schema_enum(self):
        fake_schema = {
            "fields": [
                {
                    "name": "mmWaveTargetInfoReport",
                    "values": ["Disable (default)", "Enable"],
                }
            ]
        }
        with patch.object(app_module.schema_service, "get_schema", return_value=fake_schema):
            self.assertEqual(app_module.resolve_target_reporting_value(False), "Disable (default)")
            self.assertEqual(app_module.resolve_target_reporting_value(True), "Enable")

    def test_update_parameter_routes_to_each_sessions_selected_topic(self):
        published = []

        def fake_publish(topic, payload, origin, sid=None):
            published.append({"topic": topic, "payload": payload, "origin": origin, "sid": sid})
            return True, 0

        client_a = self._client()
        client_b = self._client()

        client_a.get_received()
        client_b.get_received()

        with patch.object(app_module, "publish_json", side_effect=fake_publish):
            client_a.emit("change_device", "zigbee2mqtt/device_a")
            client_b.emit("change_device", "zigbee2mqtt/device_b")
            client_a.get_received()
            client_b.get_received()

            client_a.emit("update_parameter", {"param": "mmWaveHoldTime", "value": 30, "request_id": "req-a"})
            client_b.emit("update_parameter", {"param": "mmWaveHoldTime", "value": 45, "request_id": "req-b"})

        self.assertEqual(len(published), 2)
        self.assertEqual(published[0]["topic"], "zigbee2mqtt/device_a/set")
        self.assertEqual(published[0]["payload"], {"mmWaveHoldTime": 30})
        self.assertEqual(published[1]["topic"], "zigbee2mqtt/device_b/set")
        self.assertEqual(published[1]["payload"], {"mmWaveHoldTime": 45})

        results_a = [event["args"][0] for event in client_a.get_received() if event["name"] == "command_result"]
        results_b = [event["args"][0] for event in client_b.get_received() if event["name"] == "command_result"]

        self.assertTrue(results_a)
        self.assertTrue(results_b)
        self.assertEqual(results_a[-1]["status"], "sent")
        self.assertEqual(results_a[-1]["topic"], "zigbee2mqtt/device_a")
        self.assertEqual(results_b[-1]["status"], "sent")
        self.assertEqual(results_b[-1]["topic"], "zigbee2mqtt/device_b")

    def test_update_parameter_without_selected_device_returns_error(self):
        client = self._client()
        client.get_received()
        client.emit("update_parameter", {"param": "mmWaveHoldTime", "value": 30, "request_id": "req-no-device"})
        results = [event["args"][0] for event in client.get_received() if event["name"] == "command_result"]
        self.assertTrue(results)
        self.assertEqual(results[-1]["status"], "error")
        self.assertEqual(results[-1]["message"], "No device selected")

    def test_set_target_reporting_publishes_immediately(self):
        published = []

        def fake_publish(topic, payload, origin, sid=None):
            published.append({"topic": topic, "payload": payload, "origin": origin, "sid": sid})
            return True, 0

        client = self._client()
        client.get_received()

        with patch.object(app_module, "publish_json", side_effect=fake_publish):
            client.emit("change_device", "zigbee2mqtt/device_a")
            client.get_received()
            client.emit("set_target_reporting", {"enabled": True, "request_id": "report-on"})

        self.assertEqual(len(published), 1)
        self.assertEqual(published[0]["topic"], "zigbee2mqtt/device_a/set")
        self.assertEqual(published[0]["origin"], "set_target_reporting")
        self.assertIn("mmWaveTargetInfoReport", published[0]["payload"])

        results = [event["args"][0] for event in client.get_received() if event["name"] == "command_result"]
        matching = [result for result in results if result.get("action") == "set_target_reporting"]
        self.assertTrue(matching)
        self.assertEqual(matching[-1]["status"], "sent")
        self.assertEqual(matching[-1]["payload"]["enabled"], True)

        confirmation = SimpleNamespace(
            topic="zigbee2mqtt/device_a",
            payload=json.dumps({"mmWaveTargetInfoReport": "Enable"}).encode("utf-8"),
        )
        app_module.on_message(None, None, confirmation)
        matching = self._command_results(client, "set_target_reporting")
        self.assertEqual(matching[-1]["status"], "confirmed")

    def test_set_target_reporting_publish_failure_clears_confirmation_tracker(self):
        client = self._client()
        client.get_received()
        client.emit("change_device", "zigbee2mqtt/device_a")
        client.get_received()
        with patch.object(app_module, "publish_json", return_value=(False, 4)):
            client.emit("set_target_reporting", {"enabled": True, "request_id": "report-failed"})

        results = self._command_results(client, "set_target_reporting")
        self.assertEqual(results[-1]["status"], "error")
        with app_module.pending_writes_lock:
            self.assertFalse(any(entry["request_id"] == "report-failed" for entry in app_module.pending_writes.values()))

    def test_set_basic_control_publishes_state_and_brightness(self):
        published = []

        def fake_publish(topic, payload, origin, sid=None):
            published.append({"topic": topic, "payload": payload, "origin": origin, "sid": sid})
            return True, 0

        client = self._client()
        client.get_received()

        with patch.object(app_module, "publish_json", side_effect=fake_publish):
            client.emit("change_device", "zigbee2mqtt/device_a")
            client.get_received()
            client.emit(
                "set_basic_control",
                {"state": "ON", "brightness": 130, "request_id": "basic-1"},
            )

        self.assertEqual(len(published), 1)
        self.assertEqual(published[0]["topic"], "zigbee2mqtt/device_a/set")
        self.assertEqual(published[0]["origin"], "set_basic_control")
        self.assertEqual(published[0]["payload"], {"state": "ON", "brightness": 130})

        results = [event["args"][0] for event in client.get_received() if event["name"] == "command_result"]
        matching = [result for result in results if result.get("action") == "set_basic_control"]
        self.assertTrue(matching)
        self.assertEqual(matching[-1]["status"], "sent")
        self.assertEqual(matching[-1]["payload"], {"state": "ON", "brightness": 130})

    def test_set_basic_control_clamps_brightness(self):
        published = []

        def fake_publish(topic, payload, origin, sid=None):
            published.append({"topic": topic, "payload": payload, "origin": origin, "sid": sid})
            return True, 0

        client = self._client()
        client.get_received()

        with patch.object(app_module, "publish_json", side_effect=fake_publish):
            client.emit("change_device", "zigbee2mqtt/device_a")
            client.get_received()
            client.emit("set_basic_control", {"brightness": 999, "request_id": "basic-2"})

        self.assertEqual(len(published), 1)
        self.assertEqual(published[0]["payload"], {"brightness": 254})

        results = [event["args"][0] for event in client.get_received() if event["name"] == "command_result"]
        matching = [result for result in results if result.get("action") == "set_basic_control"]
        self.assertTrue(matching)
        self.assertEqual(matching[-1]["status"], "sent")
        self.assertEqual(matching[-1]["payload"], {"brightness": 254})

    def test_set_basic_control_rejects_unconfirmable_toggle_state(self):
        client = self._client()
        client.get_received()
        client.emit("change_device", "zigbee2mqtt/device_a")
        client.get_received()
        with patch.object(app_module, "publish_json") as publish_mock:
            client.emit("set_basic_control", {"state": "TOGGLE", "request_id": "basic-toggle"})

        publish_mock.assert_not_called()
        results = self._command_results(client, "set_basic_control")
        self.assertEqual(results[-1]["status"], "error")
        self.assertIn("ON, OFF", results[-1]["message"])

    def test_set_basic_control_without_selected_device_returns_error(self):
        client = self._client()
        client.get_received()
        client.emit("set_basic_control", {"state": "ON", "request_id": "basic-no-device"})
        results = [event["args"][0] for event in client.get_received() if event["name"] == "command_result"]
        self.assertTrue(results)
        self.assertEqual(results[-1]["status"], "error")
        self.assertEqual(results[-1]["message"], "No device selected")

    def test_set_basic_control_accepts_discovered_explicit_topic_without_selecting_it(self):
        topic = "zigbee2mqtt/Kitchen Switch"
        with app_module.device_list_lock:
            app_module.device_list["Kitchen Switch"] = _make_device("Kitchen Switch", topic)

        published = []

        def fake_publish(publish_topic, payload, origin, sid=None):
            published.append({"topic": publish_topic, "payload": payload, "origin": origin, "sid": sid})
            return True, 0

        client = self._client()
        client.get_received()
        with patch.object(app_module, "publish_json", side_effect=fake_publish):
            client.emit(
                "set_basic_control",
                {"topic": topic, "state": "ON", "request_id": "dashboard-power-1"},
            )

        self.assertEqual(len(published), 1)
        self.assertEqual(published[0]["topic"], f"{topic}/set")
        self.assertEqual(published[0]["payload"], {"state": "ON"})
        results = self._command_results(client, "set_basic_control")
        self.assertEqual(results[-1]["status"], "sent")
        self.assertEqual(results[-1]["topic"], topic)

        # The explicit dashboard command must not become the full editor's selection.
        client.emit("update_parameter", {"param": "mmWaveHoldTime", "value": 30, "request_id": "no-selection"})
        results = self._command_results(client, "update_parameter")
        self.assertEqual(results[-1]["status"], "error")
        self.assertEqual(results[-1]["message"], "No device selected")

    def test_set_basic_control_rejects_unknown_explicit_topic(self):
        client = self._client()
        client.get_received()
        with patch.object(app_module, "publish_json") as publish_mock:
            client.emit(
                "set_basic_control",
                {"topic": "zigbee2mqtt/not-discovered", "state": "ON", "request_id": "dashboard-unknown"},
            )

        publish_mock.assert_not_called()
        results = self._command_results(client, "set_basic_control")
        self.assertEqual(results[-1]["status"], "error")
        self.assertEqual(results[-1]["message"], "Unknown device topic")

    def test_fan_basic_control_maps_power_and_rejects_brightness(self):
        topic = "zigbee2mqtt/Blue Fan"
        with app_module.device_list_lock:
            app_module.device_list["Blue Fan"] = _make_device(
                "Blue Fan",
                topic,
                model="VZM35-SN",
                capabilities={
                    "state": True,
                    "brightness": False,
                    "full_editor": False,
                    "state_property": "fan_state",
                    "brightness_property": None,
                },
            )

        client = self._client()
        client.get_received()
        with patch.object(app_module, "publish_json", return_value=(True, 0)) as publish_mock:
            client.emit(
                "set_basic_control",
                {"topic": topic, "state": "ON", "request_id": "fan-power"},
            )
        publish_mock.assert_called_once()
        self.assertEqual(publish_mock.call_args.args[0], f"{topic}/set")
        self.assertEqual(publish_mock.call_args.args[1], {"fan_state": "ON"})
        results = self._command_results(client, "set_basic_control")
        self.assertEqual(results[-1]["status"], "sent")
        self.assertEqual(results[-1]["payload"], {"state": "ON"})

        echo = SimpleNamespace(
            topic=topic,
            payload=json.dumps({"fan_state": "ON"}).encode("utf-8"),
        )
        app_module.on_message(None, None, echo)
        results = self._command_results(client, "set_basic_control")
        self.assertEqual(results[-1]["status"], "confirmed")
        with app_module.device_list_lock:
            self.assertEqual(app_module.device_list["Blue Fan"]["last_config"]["state"], "ON")

        with patch.object(app_module, "publish_json") as publish_mock:
            client.emit(
                "set_basic_control",
                {"topic": topic, "brightness": 100, "request_id": "fan-level"},
            )
        publish_mock.assert_not_called()
        results = self._command_results(client, "set_basic_control")
        self.assertEqual(results[-1]["status"], "error")
        self.assertIn("Brightness control is not supported", results[-1]["message"])

        client.emit("change_device", topic)
        results = self._command_results(client, "change_device")
        self.assertEqual(results[-1]["status"], "error")
        self.assertIn("Full configuration", results[-1]["message"])

    def test_change_device_rejects_undiscovered_topic(self):
        client = self._client()
        client.get_received()
        client.emit("change_device", "zigbee2mqtt/bridge")
        results = self._command_results(client, "change_device")
        self.assertEqual(results[-1]["status"], "error")
        self.assertEqual(results[-1]["message"], "Device is not currently available")

        with patch.object(app_module, "publish_json") as publish_mock:
            client.emit("update_parameter", {"param": "mmWaveHoldTime", "value": 30})
        publish_mock.assert_not_called()
        results = self._command_results(client, "update_parameter")
        self.assertEqual(results[-1]["status"], "error")

    def test_apply_parameters_validates_then_publishes_one_atomic_batch(self):
        topic = "zigbee2mqtt/Office Switch"
        with app_module.device_list_lock:
            app_module.device_list["Office Switch"] = _make_device("Office Switch", topic)

        published = []

        def fake_publish(publish_topic, payload, origin, sid=None):
            published.append({"topic": publish_topic, "payload": payload, "origin": origin, "sid": sid})
            return True, 0

        client = self._client()
        client.get_received()
        with patch.object(app_module, "publish_json", side_effect=fake_publish):
            client.emit("change_device", topic)
            client.get_received()
            client.emit(
                "apply_parameters",
                {
                    "request_id": "apply-two-fields",
                    "changes": {"mmWaveHoldTime": 30, "mmWaveDetectSensitivity": "High (default)"},
                },
            )

        self.assertEqual(len(published), 1)
        self.assertEqual(published[0]["topic"], f"{topic}/set")
        self.assertEqual(published[0]["origin"], "apply_parameters")
        self.assertEqual(
            published[0]["payload"],
            {"mmWaveHoldTime": 30, "mmWaveDetectSensitivity": "High (default)"},
        )
        results = self._command_results(client, "apply_parameters")
        self.assertEqual(results[-1]["status"], "sent")
        with app_module.pending_writes_lock:
            matching = [entry for entry in app_module.pending_writes.values() if entry["request_id"] == "apply-two-fields"]
        self.assertEqual(len(matching), 1)

    def test_apply_parameters_invalid_field_publishes_nothing(self):
        topic = "zigbee2mqtt/Office Switch"
        with app_module.device_list_lock:
            app_module.device_list["Office Switch"] = _make_device("Office Switch", topic)

        client = self._client()
        client.get_received()
        client.emit("change_device", topic)
        client.get_received()
        with patch.object(app_module, "publish_json") as publish_mock:
            client.emit(
                "apply_parameters",
                {
                    "request_id": "apply-invalid",
                    "changes": {"mmWaveHoldTime": 30, "mmWaveVersion": 999},
                },
            )

        publish_mock.assert_not_called()
        results = self._command_results(client, "apply_parameters")
        self.assertEqual(results[-1]["status"], "error")
        self.assertIn("read-only", results[-1]["message"])

    def test_apply_parameters_accepts_explicit_discovered_topic_without_session_selection(self):
        topic = "zigbee2mqtt/Office Switch"
        with app_module.device_list_lock:
            app_module.device_list["Office Switch"] = _make_device("Office Switch", topic)

        client = self._client()
        client.get_received()
        with patch.object(app_module, "publish_json", return_value=(True, 0)) as publish_mock:
            client.emit(
                "apply_parameters",
                {"topic": topic, "request_id": "apply-explicit", "changes": {"mmWaveHoldTime": 60}},
            )

        publish_mock.assert_called_once()
        self.assertEqual(publish_mock.call_args.args[0], f"{topic}/set")
        results = self._command_results(client, "apply_parameters")
        self.assertEqual(results[-1]["status"], "sent")

        client.emit("force_sync")
        results = self._command_results(client, "force_sync")
        self.assertEqual(results[-1]["status"], "error")

    def test_apply_parameters_confirms_only_after_all_echoes_arrive(self):
        topic = "zigbee2mqtt/Office Switch"
        with app_module.device_list_lock:
            app_module.device_list["Office Switch"] = _make_device("Office Switch", topic)

        client = self._client()
        client.get_received()
        with patch.object(app_module, "publish_json", return_value=(True, 0)):
            client.emit("change_device", topic)
            client.get_received()
            client.emit(
                "apply_parameters",
                {
                    "request_id": "apply-partial",
                    "changes": {"mmWaveHoldTime": 30, "mmWaveDetectSensitivity": "High (default)"},
                },
            )
        self._command_results(client, "apply_parameters")

        first = SimpleNamespace(
            topic=topic,
            payload=json.dumps({"mmWaveHoldTime": 30}).encode("utf-8"),
        )
        app_module.on_message(None, None, first)
        partial_results = self._command_results(client, "apply_parameters")
        self.assertEqual([result["status"] for result in partial_results], ["sending"])
        self.assertEqual(partial_results[0]["payload"]["confirmed_fields"], ["mmWaveHoldTime"])

        mismatch = SimpleNamespace(
            topic=topic,
            payload=json.dumps({"mmWaveHoldTime": 31}).encode("utf-8"),
        )
        app_module.on_message(None, None, mismatch)
        mismatch_results = self._command_results(client, "apply_parameters")
        self.assertEqual([result["status"] for result in mismatch_results], ["sending"])
        self.assertEqual(mismatch_results[0]["payload"]["confirmed_fields"], [])

        second = SimpleNamespace(
            topic=topic,
            payload=json.dumps({"mmWaveDetectSensitivity": "High (default)"}).encode("utf-8"),
        )
        app_module.on_message(None, None, second)
        second_results = self._command_results(client, "apply_parameters")
        self.assertEqual([result["status"] for result in second_results], ["sending"])
        self.assertEqual(second_results[0]["payload"]["confirmed_fields"], ["mmWaveDetectSensitivity"])

        final = SimpleNamespace(
            topic=topic,
            payload=json.dumps({"mmWaveHoldTime": 30}).encode("utf-8"),
        )
        app_module.on_message(None, None, final)
        completed_results = self._command_results(client, "apply_parameters")
        self.assertEqual([result["status"] for result in completed_results], ["confirmed"])
        with app_module.pending_writes_lock:
            self.assertFalse(any(entry["request_id"] == "apply-partial" for entry in app_module.pending_writes.values()))

    def test_pending_write_ignores_wrong_topic_and_expires_with_details(self):
        expected_topic = "zigbee2mqtt/Office Switch"
        other_topic = "zigbee2mqtt/Hall Switch"
        with app_module.device_list_lock:
            app_module.device_list["Office Switch"] = _make_device("Office Switch", expected_topic)
            app_module.device_list["Hall Switch"] = _make_device("Hall Switch", other_topic)

        client = self._client()
        client.get_received()
        with patch.object(app_module, "publish_json", return_value=(True, 0)):
            client.emit("change_device", expected_topic)
            client.get_received()
            client.emit(
                "apply_parameters",
                {"request_id": "apply-wrong-topic", "changes": {"mmWaveHoldTime": 45}},
            )
        self._command_results(client, "apply_parameters")

        wrong_message = SimpleNamespace(
            topic=other_topic,
            payload=json.dumps({"mmWaveHoldTime": 45}).encode("utf-8"),
        )
        app_module.on_message(None, None, wrong_message)
        self.assertEqual(self._command_results(client, "apply_parameters"), [])

        with app_module.pending_writes_lock:
            entry = next(
                item for item in app_module.pending_writes.values()
                if item["request_id"] == "apply-wrong-topic"
            )
        app_module.expire_pending_write(entry["sid"], entry["request_id"])
        results = self._command_results(client, "apply_parameters")
        self.assertEqual(results[-1]["status"], "not_confirmed")
        self.assertEqual(results[-1]["payload"]["confirmed_fields"], [])
        self.assertEqual(results[-1]["payload"]["unresolved_fields"], ["mmWaveHoldTime"])

    def test_check_firmware_update_publishes_bridge_request(self):
        published = []

        def fake_publish(topic, payload, origin, sid=None):
            published.append({"topic": topic, "payload": payload, "origin": origin, "sid": sid})
            return True, 0

        client = self._client()
        client.get_received()

        with patch.object(app_module, "publish_json", side_effect=fake_publish):
            client.emit("change_device", "zigbee2mqtt/device_a")
            client.get_received()
            client.emit("check_firmware_update", {"request_id": "ota-check-1"})

        self.assertEqual(len(published), 1)
        self.assertEqual(published[0]["topic"], "zigbee2mqtt/bridge/request/device/ota_update/check")
        self.assertEqual(published[0]["payload"]["id"], "device_a")
        self.assertTrue(published[0]["payload"]["transaction"].startswith("switch-studio-"))
        self.assertEqual(published[0]["origin"], "check_firmware_update")

        results = [event["args"][0] for event in client.get_received() if event["name"] == "command_result"]
        matching = [result for result in results if result.get("action") == "check_firmware_update"]
        self.assertTrue(matching)
        self.assertEqual(matching[-1]["status"], "sent")

    def test_start_firmware_update_publishes_bridge_request(self):
        published = []

        def fake_publish(topic, payload, origin, sid=None):
            published.append({"topic": topic, "payload": payload, "origin": origin, "sid": sid})
            return True, 0

        client = self._client()
        client.get_received()

        with patch.object(app_module, "publish_json", side_effect=fake_publish):
            client.emit("change_device", "zigbee2mqtt/device_a")
            client.get_received()
            client.emit("start_firmware_update", {"request_id": "ota-update-1"})

        self.assertEqual(len(published), 1)
        self.assertEqual(published[0]["topic"], "zigbee2mqtt/bridge/request/device/ota_update/update")
        self.assertEqual(published[0]["payload"]["id"], "device_a")
        self.assertTrue(published[0]["payload"]["transaction"].startswith("switch-studio-"))
        self.assertEqual(published[0]["origin"], "start_firmware_update")

        results = [event["args"][0] for event in client.get_received() if event["name"] == "command_result"]
        matching = [result for result in results if result.get("action") == "start_firmware_update"]
        self.assertTrue(matching)
        self.assertEqual(matching[-1]["status"], "sent")

    def test_start_firmware_update_rejects_custom_url(self):
        client = self._client()
        client.get_received()
        client.emit("change_device", "zigbee2mqtt/device_a")
        client.get_received()

        with patch.object(app_module, "publish_json") as publish_mock:
            client.emit(
                "start_firmware_update",
                {"request_id": "ota-custom-url", "url": "https://untrusted.example/firmware.ota"},
            )

        publish_mock.assert_not_called()
        results = self._command_results(client, "start_firmware_update")
        self.assertEqual(results[-1]["status"], "error")
        self.assertEqual(results[-1]["message"], "Custom firmware URLs are not supported")

    def test_ota_error_response_uses_transaction_when_response_data_is_empty(self):
        topic = "zigbee2mqtt/device_a"
        transaction = app_module.register_ota_request(topic, "check_firmware_update")
        client = self._client()
        client.get_received()

        response = SimpleNamespace(
            topic="zigbee2mqtt/bridge/response/device/ota_update/check",
            payload=json.dumps({
                "status": "error",
                "transaction": transaction,
                "data": {},
                "error": "Update check failed",
            }).encode("utf-8"),
        )
        app_module.on_message(None, None, response)

        with app_module.ota_requests_lock:
            self.assertNotIn(transaction, app_module.ota_requests)
        events = [event["args"][0] for event in client.get_received() if event["name"] == "firmware_status"]
        self.assertTrue(events)
        self.assertEqual(events[-1]["topic"], topic)
        self.assertEqual(events[-1]["payload"]["state"], "error")
        self.assertEqual(events[-1]["payload"]["last_error"], "Update check failed")

    def test_successful_ota_update_response_marks_completion_and_new_version(self):
        topic = "zigbee2mqtt/device_a"
        transaction = app_module.register_ota_request(topic, "start_firmware_update")
        client = self._client()
        client.get_received()

        response = SimpleNamespace(
            topic="zigbee2mqtt/bridge/response/device/ota_update/update",
            payload=json.dumps({
                "status": "ok",
                "transaction": transaction,
                "data": {
                    "id": "device_a",
                    "from": {"file_version": 16974080},
                    "to": {"file_version": 16974336},
                },
            }).encode("utf-8"),
        )
        app_module.on_message(None, None, response)

        events = [event["args"][0] for event in client.get_received() if event["name"] == "firmware_status"]
        self.assertTrue(events)
        status = events[-1]["payload"]
        self.assertEqual(status["state"], "completed")
        self.assertEqual(status["progress"], 100)
        self.assertEqual(status["remaining"], None)
        self.assertEqual(status["available"], False)
        self.assertEqual(status["installed_version"], "16974336")
        self.assertEqual(status["latest_version"], "16974336")

    def test_terminal_ota_state_clears_stale_progress_unless_explicitly_reported(self):
        topic = "zigbee2mqtt/device_a"
        app_module.update_device_ota_status(topic, {"state": "updating", "progress": 87})
        completed = app_module.update_device_ota_status(topic, {"state": "completed"})
        self.assertIsNone(completed["progress"])

        explicit = app_module.update_device_ota_status(topic, {"state": "completed", "progress": 100})
        self.assertEqual(explicit["progress"], 100)

    def test_extract_ota_status_ignores_normal_device_and_generic_status_fields(self):
        self.assertIsNone(app_module.extract_ota_status_from_payload({"state": "OFF", "brightness": 80}))
        self.assertIsNone(app_module.extract_ota_status_from_payload({"status": "ok", "message": "done"}))
        self.assertEqual(
            app_module.extract_ota_status_from_payload({"update_available": True, "state": "OFF"}),
            {"available": True},
        )

    def test_extract_ota_status_uses_nested_lifecycle_and_fractional_progress(self):
        result = app_module.extract_ota_status_from_payload({
            "state": "OFF",
            "update": {
                "state": "updating",
                "progress": 13.37,
                "remaining": "42.5",
                "installed_version": 16974080,
                "latest_version": 16973834,
            },
        })
        self.assertEqual(result["state"], "updating")
        self.assertEqual(result["progress"], 13.37)
        self.assertEqual(result["remaining"], 42.5)
        self.assertEqual(result["installed_version"], "16974080")
        self.assertEqual(result["latest_version"], "16973834")

    def test_partial_ota_progress_retains_cached_versions(self):
        topic = "zigbee2mqtt/Bedroom Light Control"
        device = _make_device("Bedroom Light Control", topic)
        device["ota_status"].update({
            "available": True,
            "installed_version": "16974080",
            "latest_version": "16973834",
            "state": "available",
        })
        with app_module.device_list_lock:
            app_module.device_list["Bedroom Light Control"] = device

        msg = SimpleNamespace(
            topic=topic,
            payload=json.dumps({"state": "OFF", "update": {"state": "updating", "progress": 13.37}}).encode("utf-8"),
        )
        app_module.on_message(None, None, msg)

        with app_module.device_list_lock:
            status = dict(app_module.device_list["Bedroom Light Control"]["ota_status"])
        self.assertEqual(status["state"], "updating")
        self.assertEqual(status["progress"], 13.37)
        self.assertEqual(status["installed_version"], "16974080")
        self.assertEqual(status["latest_version"], "16973834")

    def test_auto_off_disconnect_only_when_last_session_on_topic(self):
        published = []

        def fake_publish(topic, payload, origin, sid=None):
            published.append({"topic": topic, "payload": payload, "origin": origin, "sid": sid})
            return True, 0

        client_a = self._client()
        client_b = self._client()
        client_a.get_received()
        client_b.get_received()

        with patch.object(app_module, "publish_json", side_effect=fake_publish):
            client_a.emit("change_device", "zigbee2mqtt/device_shared")
            client_b.emit("change_device", "zigbee2mqtt/device_shared")
            client_a.emit("set_reporting_auto_off", {"enabled": True})
            client_b.emit("set_reporting_auto_off", {"enabled": True})
            client_a.get_received()
            client_b.get_received()

            client_a.disconnect()
            self.assertEqual(len(published), 0)

            client_b.disconnect()
            self.assertEqual(len(published), 1)
            self.assertEqual(published[0]["topic"], "zigbee2mqtt/device_shared/set")
            self.assertEqual(published[0]["origin"], "auto_disable_target_reporting")
            self.assertIn("mmWaveTargetInfoReport", published[0]["payload"])

    def test_index_renders_feature_flag_value(self):
        original_value = app_module.SWITCH_STUDIO_UI
        try:
            app_module.SWITCH_STUDIO_UI = False
            with app_module.app.test_client() as client:
                response = client.get("/")
            self.assertEqual(response.status_code, 200)
            body = response.get_data(as_text=True)
            self.assertIn("const SWITCH_STUDIO_UI_ENABLED = false;", body)
        finally:
            app_module.SWITCH_STUDIO_UI = original_value

    def test_on_message_ignores_get_topic_for_state_update(self):
        topic = "zigbee2mqtt/Bedroom Light Control"
        with app_module.device_list_lock:
            app_module.device_list["Bedroom Light Control"] = _make_device("Bedroom Light Control", topic)
        before_zone = dict(app_module.device_list["Bedroom Light Control"]["zone_config"])

        payload = {
            "mmWaveWidthMin": "",
            "mmWaveWidthMax": "",
            "mmWaveDepthMin": "",
            "mmWaveDepthMax": "",
        }
        msg = SimpleNamespace(topic=f"{topic}/get", payload=json.dumps(payload).encode("utf-8"))
        app_module.on_message(None, None, msg)

        with app_module.device_list_lock:
            after_zone = dict(app_module.device_list["Bedroom Light Control"]["zone_config"])
        self.assertEqual(after_zone, before_zone)

    def test_bridge_devices_cold_start_seeds_and_reconciles_blue_series_inventory(self):
        with app_module.device_list_lock:
            app_module.device_list.clear()
            app_module.device_list["Removed Switch"] = _make_device(
                "Removed Switch",
                "zigbee2mqtt/Removed Switch",
            )

        published = []
        fake_client = SimpleNamespace(
            publish=lambda topic, payload, qos=0: published.append({"topic": topic, "payload": payload, "qos": qos})
        )
        inventory = [
            {
                "friendly_name": "VZM32 Office",
                "supported": True,
                "interview_completed": True,
                "definition": {
                    "vendor": "Inovelli",
                    "model": "VZM32-SN",
                    "exposes": [
                        {
                            "type": "light",
                            "features": [
                                {"property": "state", "access": 7},
                                {"property": "brightness", "access": 7},
                            ],
                        },
                        {"property": "mmWaveTargetInfoReport", "access": 7},
                    ],
                },
            },
            {
                "friendly_name": "Blue Dimmer",
                "supported": True,
                "interview_completed": True,
                "definition": {
                    "vendor": "Inovelli",
                    "model": "VZM31-SN",
                    "exposes": [
                        {
                            "type": "light",
                            "features": [
                                {"property": "state", "access": 7},
                                {"property": "brightness", "access": 7},
                            ],
                        },
                    ],
                },
            },
            {
                "friendly_name": "Disabled Blue",
                "disabled": True,
                "definition": {"vendor": "Inovelli", "model": "VZM31-SN"},
            },
            {
                "friendly_name": "Third Party Radar",
                "definition": {"vendor": "Other", "model": "MMWAVE-1"},
            },
        ]
        msg = SimpleNamespace(
            topic="zigbee2mqtt/bridge/devices",
            payload=json.dumps(inventory).encode("utf-8"),
        )
        app_module.on_message(fake_client, None, msg)

        with app_module.device_list_lock:
            devices = json.loads(json.dumps(app_module.device_list))
        self.assertEqual(set(devices), {"VZM32 Office", "Blue Dimmer"})
        self.assertTrue(devices["VZM32 Office"]["capabilities"]["full_editor"])
        self.assertTrue(devices["VZM32 Office"]["capabilities"]["zones"])
        self.assertFalse(devices["Blue Dimmer"]["capabilities"]["full_editor"])
        self.assertTrue(devices["VZM32 Office"]["inventory_present"])
        self.assertGreater(devices["VZM32 Office"]["last_seen"], 0)
        self.assertEqual(
            {entry["topic"] for entry in published},
            {"zigbee2mqtt/VZM32 Office/get", "zigbee2mqtt/Blue Dimmer/get"},
        )
        self.assertTrue(all(entry["qos"] == 0 for entry in published))
        self.assertTrue(all(
            json.loads(entry["payload"]) == {"state": "", "brightness": ""}
            for entry in published
        ))
        self.assertTrue(app_module.get_mqtt_state()["inventory_ready"])

    def test_availability_before_inventory_and_slash_friendly_name_are_preserved(self):
        with app_module.device_list_lock:
            app_module.device_list.clear()
            app_module.device_availability_cache.clear()

        friendly_name = "kitchen/floor_light"
        topic = f"zigbee2mqtt/{friendly_name}"
        availability = SimpleNamespace(
            topic=f"{topic}/availability",
            payload=b"offline",
        )
        app_module.on_message(None, None, availability)

        inventory = SimpleNamespace(
            topic="zigbee2mqtt/bridge/devices",
            payload=json.dumps([
                {
                    "friendly_name": friendly_name,
                    "supported": True,
                    "interview_completed": True,
                    "definition": {
                        "vendor": "Inovelli",
                        "model": "VZM32-SN",
                        "exposes": [
                            {
                                "type": "light",
                                "features": [
                                    {"property": "state", "access": 7},
                                    {"property": "brightness", "access": 7},
                                ],
                            },
                            {"property": "mmWaveVersion", "access": 5},
                        ],
                    },
                },
            ]).encode("utf-8"),
        )
        app_module.on_message(None, None, inventory)

        state = SimpleNamespace(
            topic=topic,
            payload=json.dumps({
                "state": "OFF",
                "brightness": 80,
                "mmWaveVersion": "1.0",
                "mmWaveTargetInfoReport": "Disable",
            }).encode("utf-8"),
        )
        app_module.on_message(None, None, state)

        with app_module.device_list_lock:
            self.assertEqual(set(app_module.device_list), {friendly_name})
            device = app_module.device_list[friendly_name]
            self.assertEqual(device["topic"], topic)
            self.assertEqual(device["availability"], "offline")
            self.assertEqual(device["last_config"]["brightness"], 80)
        self.assertEqual(app_module.get_device_id_from_topic(topic), friendly_name)
        self.assertEqual(app_module.get_device_topic_from_identifier(friendly_name), topic)

    def test_sparse_vzm32_report_preserves_inventory_control_capabilities(self):
        friendly_name = "VZM32 Office"
        topic = f"zigbee2mqtt/{friendly_name}"
        inventory_capabilities = {
            "state": True,
            "brightness": True,
            "presence": True,
            "zones": True,
            "full_editor": True,
            "state_property": "state",
            "brightness_property": "brightness",
            "readable_state_property": "state",
            "readable_brightness_property": "brightness",
            "quick_controls_ambiguous": False,
        }
        device = _make_device(
            friendly_name,
            topic,
            capabilities=inventory_capabilities,
        )
        device["inventory_present"] = True
        with app_module.device_list_lock:
            app_module.device_list.clear()
            app_module.device_list[friendly_name] = device

        app_module.on_message(
            None,
            None,
            SimpleNamespace(
                topic=topic,
                payload=json.dumps({
                    "occupancy": False,
                    "mmWaveVersion": "1.0",
                    "mmWaveTargetInfoReport": "Disable",
                }).encode("utf-8"),
            ),
        )

        discovered = app_module.get_device_by_topic(topic)
        self.assertEqual(discovered["capabilities"], inventory_capabilities)
        self.assertEqual(
            app_module.get_basic_control_mapping(discovered),
            {"state": "state", "brightness": "brightness"},
        )

    def test_ota_request_preserves_slash_friendly_name(self):
        friendly_name = "kitchen/floor_light"
        topic = f"zigbee2mqtt/{friendly_name}"
        with app_module.device_list_lock:
            app_module.device_list.clear()
            app_module.device_list[friendly_name] = _make_device(friendly_name, topic)

        client = self._client()
        client.get_received()
        with patch.object(app_module, "publish_json", return_value=(True, 0)) as publish_mock:
            client.emit("change_device", topic)
            client.get_received()
            client.emit("check_firmware_update", {"request_id": "slash-ota"})

        publish_mock.assert_called_once()
        self.assertEqual(
            publish_mock.call_args.args[0],
            "zigbee2mqtt/bridge/request/device/ota_update/check",
        )
        self.assertEqual(publish_mock.call_args.args[1]["id"], friendly_name)

    def test_known_device_name_ending_in_availability_is_processed_as_state(self):
        friendly_name = "kitchen/availability"
        topic = f"zigbee2mqtt/{friendly_name}"
        with app_module.device_list_lock:
            app_module.device_list.clear()
            app_module.device_availability_cache.clear()
            app_module.device_list[friendly_name] = _make_device(friendly_name, topic)

        app_module.on_message(
            None,
            None,
            SimpleNamespace(
                topic=topic,
                payload=json.dumps({
                    "state": "OFF",
                    "brightness": 90,
                    "mmWaveVersion": "1.0",
                    "mmWaveTargetInfoReport": "Disable",
                }).encode("utf-8"),
            ),
        )

        with app_module.device_list_lock:
            self.assertEqual(set(app_module.device_list), {friendly_name})
            self.assertEqual(app_module.device_list[friendly_name]["last_config"]["brightness"], 90)
            self.assertEqual(app_module.device_availability_cache, {})

    def test_exact_device_reports_refresh_last_seen_and_availability(self):
        topic = "zigbee2mqtt/device_a"
        with app_module.device_list_lock:
            app_module.device_list["device_a"]["last_seen"] = 1

        state_message = SimpleNamespace(
            topic=topic,
            payload=json.dumps({"state": "OFF", "brightness": 80}).encode("utf-8"),
        )
        app_module.on_message(None, None, state_message)
        with app_module.device_list_lock:
            self.assertGreater(app_module.device_list["device_a"]["last_seen"], 1)

        availability_message = SimpleNamespace(
            topic=f"{topic}/availability",
            payload=b"offline",
        )
        app_module.on_message(None, None, availability_message)
        with app_module.device_list_lock:
            self.assertEqual(app_module.device_list["device_a"]["availability"], "offline")

    def test_on_message_updates_zone_config_for_exact_device_topic(self):
        topic = "zigbee2mqtt/Bedroom Light Control"
        with app_module.device_list_lock:
            app_module.device_list["Bedroom Light Control"] = _make_device("Bedroom Light Control", topic)

        payload = {
            "mmWaveWidthMin": "20",
            "mmWaveWidthMax": "100",
            "mmWaveDepthMin": "10",
            "mmWaveDepthMax": "220",
            "mmWaveHeightMin": "-175",
            "mmWaveHeightMax": "325",
        }
        msg = SimpleNamespace(topic=topic, payload=json.dumps(payload).encode("utf-8"))
        with patch.object(app_module.socketio, "emit") as emit:
            app_module.on_message(None, None, msg)

        with app_module.device_list_lock:
            zone = dict(app_module.device_list["Bedroom Light Control"]["zone_config"])
        expected = {
            "x_min": 20, "x_max": 100,
            "y_min": 10, "y_max": 220,
            "z_min": -175, "z_max": 325,
        }
        self.assertEqual(zone, expected)
        snapshot = app_module.build_device_snapshot(topic)
        self.assertEqual(snapshot["payload"]["zone_config"], expected)
        zone_events = [
            call.args[1]["payload"]
            for call in emit.call_args_list
            if call.args and call.args[0] == "zone_config"
        ]
        self.assertEqual(zone_events, [expected])
        zone_deltas = [
            call.args[1]["payload"]
            for call in emit.call_args_list
            if call.args and call.args[0] == "device_delta"
            and call.args[1].get("kind") == "zone_config"
        ]
        self.assertEqual(zone_deltas, [expected])

        partial = SimpleNamespace(
            topic=topic,
            payload=json.dumps({"mmWaveWidthMax": "120", "mmWaveHeightMin": ""}).encode("utf-8"),
        )
        app_module.on_message(None, None, partial)
        with app_module.device_list_lock:
            updated = dict(app_module.device_list["Bedroom Light Control"]["zone_config"])
        self.assertEqual(updated, {**expected, "x_max": 120})

    def test_default_global_zone_uses_the_full_supported_height_span(self):
        self.assertEqual(app_module.DEFAULT_GLOBAL_ZONE_CONFIG["z_min"], -600)
        self.assertEqual(app_module.DEFAULT_GLOBAL_ZONE_CONFIG["z_max"], 600)

    def test_raw_zone_packets_preserve_slot_identity_and_signed_z_bounds(self):
        topic = "zigbee2mqtt/Bedroom Light Control"
        friendly_name = "Bedroom Light Control"
        with app_module.device_list_lock:
            app_module.device_list[friendly_name] = _make_device(friendly_name, topic)

        active_area1 = {
            "x_min": -120, "x_max": 140,
            "y_min": 15, "y_max": 250,
            "z_min": -345, "z_max": 456,
        }
        empty_area2 = {key: 0 for key in active_area1}
        active_area3 = {
            "x_min": 10, "x_max": 90,
            "y_min": 30, "y_max": 180,
            "z_min": -500, "z_max": -100,
        }
        expected = [
            {"area_id": "area1", "area_index": 1, **active_area1},
            {"area_id": "area3", "area_index": 3, **active_area3},
        ]

        event_and_cache = {
            2: ("interference_zones", "interference_zones"),
            3: ("detection_zones", "detection_zones"),
            4: ("stay_zones", "stay_zones"),
        }
        for command_id, (event_name, cache_name) in event_and_cache.items():
            with self.subTest(command_id=command_id):
                message = SimpleNamespace(
                    topic=topic,
                    payload=json.dumps(_raw_zone_packet(
                        command_id,
                        [active_area1, empty_area2, active_area3],
                    )).encode("utf-8"),
                )
                with patch.object(app_module.socketio, "emit") as emit:
                    app_module.on_message(None, None, message)

                with app_module.device_list_lock:
                    cached = app_module.device_list[friendly_name][cache_name]
                self.assertEqual(cached, expected)
                raw_events = [
                    call.args[1]["payload"]
                    for call in emit.call_args_list
                    if call.args and call.args[0] == event_name
                ]
                self.assertEqual(raw_events, [expected])
                raw_deltas = [
                    call.args[1]["payload"]
                    for call in emit.call_args_list
                    if call.args and call.args[0] == "device_delta"
                    and call.args[1].get("kind") == event_name
                ]
                self.assertEqual(raw_deltas, [expected])

    def test_on_message_updates_ota_status_from_device_payload(self):
        topic = "zigbee2mqtt/Bedroom Light Control"
        with app_module.device_list_lock:
            app_module.device_list["Bedroom Light Control"] = _make_device("Bedroom Light Control", topic)

        client = self._client()
        client.get_received()

        payload = {
            "update_available": True,
            "update": {
                "installed_version": 16974080,
                "latest_version": 16973834,
                "state": "available",
                "progress": 0,
            }
        }
        msg = SimpleNamespace(topic=topic, payload=json.dumps(payload).encode("utf-8"))
        app_module.on_message(None, None, msg)

        firmware_events = [event["args"][0] for event in client.get_received() if event["name"] == "firmware_status"]
        self.assertTrue(firmware_events)
        latest = firmware_events[-1]["payload"]
        self.assertEqual(latest["available"], True)
        self.assertEqual(latest["installed_version"], "16974080")
        self.assertEqual(latest["latest_version"], "16973834")
        self.assertEqual(latest["installed_version_detail"]["display_version"], "1.00")
        self.assertEqual(latest["installed_version_detail"]["raw_hex"], "0x01030100")
        self.assertEqual(latest["latest_version_detail"]["display_version"], "0.10")
        self.assertEqual(latest["latest_version_detail"]["raw_hex"], "0x0103000A")
        self.assertEqual(latest["official_versions"], {})
        self.assertEqual(latest["state"], "available")

    def test_on_message_handles_ota_bridge_response(self):
        topic = "zigbee2mqtt/Bedroom Light Control"
        with app_module.device_list_lock:
            app_module.device_list["Bedroom Light Control"] = _make_device("Bedroom Light Control", topic)

        client = self._client()
        client.get_received()

        payload = {
            "status": "ok",
            "data": {
                "id": "Bedroom Light Control",
                "updateAvailable": True,
                "downgrade": True,
                "update": {
                    "installed_version": 16974080,
                    "latest_version": 16973834,
                    "state": "checked",
                }
            }
        }
        msg = SimpleNamespace(
            topic="zigbee2mqtt/bridge/response/device/ota_update/check",
            payload=json.dumps(payload).encode("utf-8")
        )
        app_module.on_message(None, None, msg)

        firmware_events = [event["args"][0] for event in client.get_received() if event["name"] == "firmware_status"]
        self.assertTrue(firmware_events)
        latest = firmware_events[-1]["payload"]
        self.assertEqual(latest["available"], True)
        self.assertEqual(latest["downgrade"], True)
        self.assertEqual(latest["installed_version"], "16974080")
        self.assertEqual(latest["latest_version"], "16973834")
        self.assertEqual(latest["installed_version_detail"]["display_version"], "1.00")
        self.assertEqual(latest["latest_version_detail"]["display_version"], "0.10")
        self.assertEqual(latest["official_versions"], {})
        self.assertEqual(latest["state"], "checked")

    def test_on_message_parses_detection_zone_raw_packet(self):
        topic = "zigbee2mqtt/Bedroom Light Control"
        with app_module.device_list_lock:
            app_module.device_list["Bedroom Light Control"] = _make_device("Bedroom Light Control", topic)

        zone_values = {
            "x_min": 20,
            "x_max": 111,
            "y_min": 0,
            "y_max": 107,
            "z_min": -11,
            "z_max": 300,
        }

        payload = {
            "0": 29,
            "1": 47,
            "2": 18,
            "3": 1,
            "4": 3,
            "5": 1,
        }
        ordered = ["x_min", "x_max", "y_min", "y_max", "z_min", "z_max"]
        offset = 6
        for key in ordered:
            low, high = _int16_to_le_bytes(zone_values[key])
            payload[str(offset)] = low
            payload[str(offset + 1)] = high
            offset += 2

        msg = SimpleNamespace(topic=topic, payload=json.dumps(payload).encode("utf-8"))
        app_module.on_message(None, None, msg)

        with app_module.device_list_lock:
            zones = list(app_module.device_list["Bedroom Light Control"]["detection_zones"])

        self.assertEqual(len(zones), 1)
        self.assertEqual(zones[0], {"area_id": "area1", "area_index": 1, **zone_values})


if __name__ == "__main__":
    unittest.main()
