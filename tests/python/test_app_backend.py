import json
import os
import threading
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


def _make_reference_snapshot(generation=7, status="ready"):
    return {
        "generation": generation,
        "reference_status": status,
        "reference_stale": status == "stale",
        "reference_error": None,
        "fetched_at": 1_786_539_000,
        "last_attempt_at": 1_786_539_000,
        "retry_at": 1_786_560_600,
        "current_versions": {"Production": "1.00", "Beta": "1.01"},
        "entries": {
            16974080: {
                "build": "16974080",
                "raw_hex": "0x01030100",
                "display_version": "1.00",
                "track": "Production",
                "file_name": "VZM32-SN_1.00.ota",
                "source_name": "Inovelli firmware file",
                "source_url": "https://example.test/VZM32-SN_1.00.ota",
                "match_kind": "exact",
                "exact_match": True,
                "alias_versions": [],
            },
            16974081: {
                "build": "16974081",
                "raw_hex": "0x01030101",
                "display_version": "1.01",
                "track": "Beta",
                "file_name": "VZM32-SN_1.01.ota",
                "source_name": "Inovelli firmware file",
                "source_url": "https://example.test/VZM32-SN_1.01.ota",
                "match_kind": "exact",
                "exact_match": True,
                "alias_versions": [],
            },
        },
        "sources": {"inovelli_repo": "ok", "inovelli_help": "ok"},
    }


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
        app_module.reset_command_rate_limits()
        with app_module.pending_writes_lock:
            pending_entries = list(app_module.pending_writes.values())
            app_module.pending_writes.clear()
        for entry in pending_entries:
            app_module._cancel_pending_timer(entry)
        with app_module.mqtt_state_lock:
            app_module.mqtt_state.update({
                "connected": True,
                "broker_connected": True,
                "zigbee2mqtt_connected": True,
                "inventory_ready": True,
                "reason": "Connected",
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
        return self._client_from_peer("127.0.0.1")

    def _client_from_peer(self, remote_addr, headers=None):
        flask_client = app_module.app.test_client()
        flask_client.environ_base["REMOTE_ADDR"] = remote_addr
        client = app_module.socketio.test_client(
            app_module.app,
            headers=headers,
            flask_test_client=flask_client,
        )
        self.clients.append(client)
        return client

    @staticmethod
    def _server_sid(client):
        return app_module.socketio.server.manager.sid_from_eio_sid(client.eio_sid, "/")

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

    def test_trusted_ingress_peer_accepts_only_supervisor_and_explicit_dev_loopback(self):
        self.assertEqual(app_module.TRUSTED_INGRESS_PEERS, {"172.30.32.2"})
        self.assertEqual(str(app_module.normalize_peer_address("172.30.32.2")), "172.30.32.2")
        self.assertEqual(str(app_module.normalize_peer_address("::ffff:172.30.32.2")), "172.30.32.2")
        self.assertTrue(app_module.is_trusted_ingress_peer("172.30.32.2", test_mode=False))
        self.assertTrue(app_module.is_trusted_ingress_peer("::ffff:172.30.32.2", test_mode=False))

        for loopback in ("127.0.0.1", "::1", "::ffff:127.0.0.1"):
            with self.subTest(loopback=loopback):
                self.assertTrue(app_module.is_trusted_ingress_peer(loopback, test_mode=True))
                self.assertFalse(app_module.is_trusted_ingress_peer(loopback, test_mode=False))

        for foreign in ("172.30.32.3", "192.168.1.25", "203.0.113.8", "not-an-address", None):
            with self.subTest(foreign=foreign):
                self.assertFalse(app_module.is_trusted_ingress_peer(foreign, test_mode=False))
                self.assertFalse(app_module.is_trusted_ingress_peer(foreign, test_mode=True))

    def test_http_boundary_uses_actual_ingress_peer_and_rejects_spoofed_headers(self):
        with app_module.app.test_client() as client:
            for remote_addr in ("172.30.32.2", "::ffff:172.30.32.2"):
                with self.subTest(remote_addr=remote_addr):
                    response = client.get(
                        "/",
                        environ_overrides={"REMOTE_ADDR": remote_addr},
                    )
                    self.assertEqual(response.status_code, 200)

            response = client.get(
                "/",
                environ_overrides={"REMOTE_ADDR": "203.0.113.8"},
                headers={
                    "X-Forwarded-For": "172.30.32.2",
                    "X-Real-IP": "172.30.32.2",
                    "X-Remote-User": "owner@example.test",
                    "X-Ingress-Path": "/api/hassio_ingress/spoofed",
                },
            )

        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.headers.get("Cache-Control"), "no-store")
        self.assertIn("Home Assistant Ingress", response.get_data(as_text=True))

    def test_engineio_polling_handshake_is_rejected_before_foreign_session_allocation(self):
        handshake_path = "/socket.io/?EIO=4&transport=polling"
        engineio_server = app_module.socketio.server.eio
        sockets_before = set(engineio_server.sockets)

        with app_module.app.test_client() as client:
            foreign = client.get(
                handshake_path,
                environ_overrides={"REMOTE_ADDR": "203.0.113.8"},
                headers={
                    "X-Forwarded-For": "172.30.32.2",
                    "X-Real-IP": "172.30.32.2",
                    "X-Remote-User": "owner@example.test",
                    "X-Ingress-Path": "/api/hassio_ingress/spoofed",
                },
            )
            self.assertEqual(foreign.status_code, 403)
            self.assertEqual(foreign.headers.get("Cache-Control"), "no-store")
            self.assertFalse(foreign.get_data(as_text=True).startswith("0{"))
            self.assertEqual(set(engineio_server.sockets), sockets_before)

            trusted = client.get(
                handshake_path,
                environ_overrides={"REMOTE_ADDR": "172.30.32.2"},
            )

        self.assertEqual(trusted.status_code, 200)
        open_frame = trusted.get_data(as_text=True)
        self.assertTrue(open_frame.startswith("0{"))
        open_payload = json.loads(open_frame[1:])
        trusted_sid = open_payload["sid"]
        self.assertIn(trusted_sid, engineio_server.sockets)

        # This test exercises only the raw Engine.IO opening request, so clean
        # up the intentionally half-open polling session without a Socket.IO
        # test client owning its lifecycle.
        trusted_socket = engineio_server.sockets.pop(trusted_sid)
        trusted_socket.close(wait=False, abort=True)

    def test_socket_origin_matches_effective_external_origin(self):
        ingress_environ = {
            "wsgi.url_scheme": "http",
            "HTTP_HOST": "172.30.32.1:8099",
            "HTTP_X_FORWARDED_PROTO": " https, http ",
            "HTTP_X_FORWARDED_HOST": " HA.Example:8123, supervisor ",
        }
        self.assertTrue(app_module.is_allowed_socket_origin("https://ha.example:8123", ingress_environ))
        self.assertTrue(app_module.is_allowed_socket_origin("https://HA.EXAMPLE:8123/", ingress_environ))

        direct_environ = {"wsgi.url_scheme": "http", "HTTP_HOST": "localhost:5000"}
        self.assertTrue(app_module.is_allowed_socket_origin("http://LOCALHOST:5000", direct_environ))

        default_port_environ = {
            "wsgi.url_scheme": "http",
            "HTTP_HOST": "upstream:5000",
            "HTTP_X_FORWARDED_PROTO": "https",
            "HTTP_X_FORWARDED_HOST": "ha.example",
        }
        self.assertTrue(app_module.is_allowed_socket_origin("https://ha.example:443", default_port_environ))

        for origin in (
            "https://evil.example:8123",
            "http://ha.example:8123",
            "https://ha.example:443",
            "http://172.30.32.1:8099",
        ):
            with self.subTest(origin=origin):
                self.assertFalse(app_module.is_allowed_socket_origin(origin, ingress_environ))

    def test_socket_origin_rejects_ambiguous_or_malformed_values(self):
        environ = {
            "wsgi.url_scheme": "http",
            "HTTP_HOST": "upstream:5000",
            "HTTP_X_FORWARDED_PROTO": "https",
            "HTTP_X_FORWARDED_HOST": "ha.example:8123",
        }

        # Missing Origin is retained for trusted non-browser/proxy clients. The
        # connect handler must apply the canonical peer check before this rule.
        self.assertTrue(app_module.is_allowed_socket_origin(None, environ))
        self.assertTrue(app_module.is_allowed_socket_origin("   ", environ))

        invalid_origins = (
            "null",
            "https://ha.example:8123, https://evil.example",
            "https://user:password@ha.example:8123",
            "https://ha.example:8123/path",
            "https://ha.example:8123/#fragment",
            "ws://ha.example:8123",
            "not a URL",
        )
        for origin in invalid_origins:
            with self.subTest(origin=origin):
                self.assertFalse(app_module.is_allowed_socket_origin(origin, environ))

    def test_socket_connect_trusts_actual_peer_not_spoofable_forwarding_headers(self):
        ingress_headers = {
            "Origin": "https://ha.example:8123",
            "X-Forwarded-Proto": "https",
            "X-Forwarded-Host": "ha.example:8123",
        }
        trusted = self._client_from_peer("172.30.32.2", ingress_headers)
        self.assertTrue(trusted.is_connected())

        mapped = self._client_from_peer("::ffff:172.30.32.2", ingress_headers)
        self.assertTrue(mapped.is_connected())

        spoofed_headers = {
            **ingress_headers,
            "X-Forwarded-For": "172.30.32.2",
            "X-Real-IP": "172.30.32.2",
            "X-Remote-User": "owner@example.test",
            "X-Ingress-Path": "/api/hassio_ingress/spoofed",
        }
        foreign = self._client_from_peer("203.0.113.8", spoofed_headers)
        self.assertFalse(foreign.is_connected())

    def test_socket_connect_rejects_foreign_origin_even_from_trusted_peer(self):
        client = self._client_from_peer(
            "172.30.32.2",
            {
                "Origin": "https://evil.example:8123",
                "X-Forwarded-Proto": "https",
                "X-Forwarded-Host": "ha.example:8123",
            },
        )
        self.assertFalse(client.is_connected())

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
                {"name": "occupancy", "can_get": True},
                {"name": "mmWaveVersion", "access": 5},
                {"name": "write_only_field", "can_get": False},
                {"name": "state_only_field", "access": 1},
                {
                    "name": "light",
                    "features": [
                        {"property": "state", "can_get": True},
                        {"property": "brightness", "access": 7},
                    ],
                },
                {"name": None, "can_get": True},
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

    def test_firmware_management_events_are_unregistered_and_never_publish(self):
        handlers = app_module.socketio.server.handlers.get("/", {})
        self.assertNotIn("check_firmware_update", handlers)
        self.assertNotIn("start_firmware_update", handlers)

        client = self._client()
        client.get_received()
        with patch.object(app_module, "publish_json") as publish_mock:
            client.emit("check_firmware_update", {"request_id": "legacy-check"})
            client.emit("start_firmware_update", {"request_id": "legacy-update"})
        publish_mock.assert_not_called()
        self.assertEqual(self._command_results(client, "check_firmware_update"), [])
        self.assertEqual(self._command_results(client, "start_firmware_update"), [])

    def test_bridge_ota_responses_are_ignored_without_request_correlation(self):
        topic = "zigbee2mqtt/device_a"
        with app_module.device_list_lock:
            live = app_module.device_list["device_a"]["ota_status"]
            live.update({
                "revision": 4,
                "installed_version": "16974080",
                "latest_version": "16974081",
                "state": "available",
                "progress": None,
            })
            before = dict(live)

        for response_topic in (
            "zigbee2mqtt/bridge/response/device/ota_update/check",
            "zigbee2mqtt/bridge/response/device/ota_update/update",
        ):
            response = SimpleNamespace(
                topic=response_topic,
                payload=json.dumps({
                    "status": "ok",
                    "transaction": "external-z2m-action",
                    "data": {
                        "id": "device_a",
                        "updateAvailable": False,
                        "update": {"state": "completed", "progress": 100},
                    },
                }).encode("utf-8"),
            )
            with patch.object(app_module.socketio, "emit") as emit_mock:
                app_module.on_message(None, None, response)
            self.assertFalse(any(
                call.args and call.args[0] == "firmware_status"
                for call in emit_mock.call_args_list
            ))

        with app_module.device_list_lock:
            self.assertEqual(app_module.device_list["device_a"]["ota_status"], before)

    def test_live_firmware_revision_increments_atomically(self):
        topic = "zigbee2mqtt/device_a"
        worker_count = 12
        barrier = threading.Barrier(worker_count + 1)
        revisions = []
        failures = []
        result_lock = threading.Lock()

        def update_progress(index):
            try:
                barrier.wait()
                result = app_module.update_device_ota_status(
                    topic,
                    {"state": "updating", "progress": index},
                )
                with result_lock:
                    revisions.append(result["revision"])
            except Exception as error:  # pragma: no cover - asserted below
                with result_lock:
                    failures.append(error)

        with (
            patch.object(app_module.socketio, "emit"),
            patch.object(app_module, "emit_device_delta"),
            patch.object(app_module, "get_firmware_reference_snapshot", return_value={}),
            patch.object(app_module, "schedule_firmware_reference_refresh", return_value=False),
        ):
            workers = [
                threading.Thread(target=update_progress, args=(index,))
                for index in range(worker_count)
            ]
            for worker in workers:
                worker.start()
            barrier.wait()
            for worker in workers:
                worker.join(timeout=5)

        self.assertEqual(failures, [])
        self.assertEqual(sorted(revisions), list(range(1, worker_count + 1)))
        with app_module.device_list_lock:
            stored = dict(app_module.device_list["device_a"]["ota_status"])
        self.assertEqual(stored["revision"], worker_count)
        self.assertEqual(stored["observed_source"], "zigbee2mqtt")
        self.assertIsNotNone(stored["observed_at"])

    def test_firmware_snapshots_and_events_compose_without_mutating_live_state(self):
        topic = "zigbee2mqtt/device_a"
        reference = _make_reference_snapshot(generation=11)
        with app_module.device_list_lock:
            live = app_module.device_list["device_a"]["ota_status"]
            live.update({
                "revision": 3,
                "observed_at": 1_786_540_000,
                "installed_version": "16974080",
                "latest_version": "16974081",
                "available": True,
                "state": "available",
            })
            before = dict(live)

        with (
            patch.object(app_module, "get_firmware_reference_snapshot", return_value=reference),
            patch.object(app_module, "schedule_firmware_reference_refresh", return_value=False),
        ):
            snapshot = app_module.build_device_snapshot(topic)
            with patch.object(app_module.socketio, "emit") as emit_mock:
                app_module.emit_firmware_status(topic, room="one-browser")

        composed = snapshot["payload"]["ota_status"]
        self.assertEqual(composed["schema_version"], 1)
        self.assertEqual(composed["topic"], topic)
        self.assertEqual(composed["live"]["revision"], 3)
        self.assertEqual(composed["live"]["installed_version"], "16974080")
        self.assertEqual(composed["reference"]["generation"], 11)
        self.assertEqual(composed["reference"]["status"], "fresh")
        self.assertEqual(
            composed["reference"]["installed_version_detail"]["display_version"],
            "1.00",
        )
        self.assertEqual(composed["management"], {"owner": "zigbee2mqtt", "local_actions": False})

        emitted = next(
            call.args[1]
            for call in emit_mock.call_args_list
            if call.args and call.args[0] == "firmware_status"
        )
        self.assertEqual(emitted["payload"]["live"], composed["live"])
        self.assertEqual(emitted["payload"]["reference"]["generation"], 11)
        self.assertEqual(emit_mock.call_args.kwargs.get("room"), "one-browser")

        with app_module.device_list_lock:
            stored = app_module.device_list["device_a"]["ota_status"]
            self.assertEqual(stored, before)
            self.assertNotIn("installed_version_detail", stored)
            self.assertNotIn("latest_version_detail", stored)
            self.assertNotIn("official_versions", stored)
            self.assertNotIn("reference", stored)

    def test_compose_exposes_the_new_refresh_start_generation(self):
        topic = "zigbee2mqtt/device_a"
        terminal = _make_reference_snapshot(generation=40, status="ready")
        started = _make_reference_snapshot(generation=41, status="refreshing")
        started["reference_refreshing"] = True

        with (
            patch.object(
                app_module,
                "get_firmware_reference_snapshot",
                return_value=terminal,
            ),
            patch.object(
                app_module,
                "schedule_firmware_reference_refresh",
                return_value=started,
            ),
        ):
            composed = app_module.compose_firmware_status(topic, app_module.default_ota_status())

        self.assertEqual(composed["reference"]["generation"], 41)
        self.assertEqual(composed["reference"]["status"], "refreshing")
        self.assertTrue(composed["reference"]["refreshing"])

    def test_scheduler_returns_the_service_refresh_start_snapshot(self):
        terminal = _make_reference_snapshot(generation=50, status="stale")
        started = _make_reference_snapshot(generation=51, status="refreshing")
        started["reference_refreshing"] = True

        with (
            patch.object(app_module, "get_firmware_reference_snapshot", return_value=terminal),
            patch.object(app_module, "get_vzm32sn_reference_data", return_value=started) as start_mock,
            patch.object(app_module.threading, "Thread") as thread_class,
        ):
            scheduled = app_module.schedule_firmware_reference_refresh(
                force_refresh=True,
                allow_in_test=True,
            )

        try:
            self.assertEqual(scheduled["generation"], 51)
            self.assertTrue(scheduled["reference_refreshing"])
            start_mock.assert_called_once_with(allow_network=True, force_refresh=True)
            thread_class.return_value.start.assert_called_once_with()
        finally:
            with app_module.firmware_reference_refresh_lock:
                app_module.firmware_reference_refresh_active = False
                app_module.firmware_reference_refresh_thread = None

    def test_delayed_reference_completion_cannot_overwrite_newer_live_progress(self):
        topic = "zigbee2mqtt/device_a"
        started = threading.Event()
        release = threading.Event()
        current_reference = _make_reference_snapshot(generation=20, status="stale")

        with app_module.device_list_lock:
            app_module.device_list["device_a"]["capabilities"]["full_editor"] = True
            app_module.device_list["device_a"]["ota_status"].update({
                "revision": 1,
                "state": "updating",
                "progress": 5,
                "installed_version": "16974080",
                "latest_version": "16974081",
            })

        def cached_reference_lookup(allow_network=True, force_refresh=False):
            return dict(current_reference)

        def blocking_reference_refresh(force_refresh=False):
            started.set()
            self.assertTrue(release.wait(timeout=5))
            current_reference.update(_make_reference_snapshot(generation=21, status="ready"))
            return dict(current_reference)

        with (
            patch.object(app_module, "get_vzm32sn_reference_data", side_effect=cached_reference_lookup),
            patch.object(app_module, "refresh_vzm32sn_reference_data", side_effect=blocking_reference_refresh),
            patch.object(app_module.socketio, "emit") as emit_mock,
            patch.object(app_module, "emit_device_delta"),
        ):
            with app_module.firmware_reference_refresh_lock:
                app_module.firmware_reference_refresh_active = True
            worker = threading.Thread(target=app_module._firmware_reference_refresh_worker)
            worker.start()
            self.assertTrue(started.wait(timeout=5))

            updated = app_module.update_device_ota_status(
                topic,
                {"state": "updating", "progress": 73.5, "remaining": 42},
            )
            self.assertEqual(updated["revision"], 2)
            release.set()
            worker.join(timeout=5)
            self.assertFalse(worker.is_alive())

        firmware_events = [
            call.args[1]
            for call in emit_mock.call_args_list
            if call.args and call.args[0] == "firmware_status"
        ]
        self.assertGreaterEqual(len(firmware_events), 2)
        final_payload = firmware_events[-1]["payload"]
        self.assertEqual(final_payload["live"]["revision"], 2)
        self.assertEqual(final_payload["live"]["progress"], 73.5)
        self.assertEqual(final_payload["live"]["remaining"], 42)
        self.assertEqual(final_payload["reference"]["generation"], 21)
        with app_module.device_list_lock:
            stored = app_module.device_list["device_a"]["ota_status"]
            self.assertEqual(stored["revision"], 2)
            self.assertEqual(stored["progress"], 73.5)
            self.assertNotIn("reference", stored)

    def test_snapshot_change_and_force_sync_never_request_reference_network(self):
        topic = "zigbee2mqtt/device_a"
        reference = _make_reference_snapshot(generation=30)

        def cached_reference_only(allow_network=True, force_refresh=False):
            self.assertFalse(allow_network, "synchronous application path requested firmware network I/O")
            return reference

        client = self._client()
        client.get_received()
        with (
            patch.object(app_module, "get_vzm32sn_reference_data", side_effect=cached_reference_only) as reference_mock,
            patch.object(app_module, "schedule_firmware_reference_refresh", return_value=False),
            patch.object(app_module, "publish_json", return_value=(True, 0)),
        ):
            snapshot = app_module.build_device_snapshot(topic)
            client.emit("change_device", topic)
            client.get_received()
            client.emit("force_sync", {"request_id": "read-only-firmware-sync"})

        self.assertEqual(snapshot["payload"]["ota_status"]["reference"]["generation"], 30)
        self.assertGreaterEqual(reference_mock.call_count, 3)
        self.assertTrue(all(
            call.kwargs.get("allow_network") is False
            for call in reference_mock.call_args_list
        ))

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

    def test_zigbee2mqtt_v2_update_state_supplies_availability_without_legacy_flag(self):
        available = app_module.extract_ota_status_from_payload({
            "update": {
                "state": "available",
                "installed_version": 10,
                "latest_version": 11,
            }
        })
        idle = app_module.extract_ota_status_from_payload({"update": {"state": "idle"}})
        self.assertIs(available["available"], True)
        self.assertEqual(available["state"], "available")
        self.assertIs(idle["available"], False)

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

    def test_auto_off_disconnect_cleanup_bypasses_rate_limit_and_cleans_sid_bucket(self):
        client = self._client()
        client.get_received()
        client.emit("change_device", "zigbee2mqtt/device_shared")
        client.get_received()
        sid = self._server_sid(client)
        now = 7000.0
        app_module.reset_command_rate_limits(now=now)

        for _ in range(int(app_module.COMMAND_RATE_CAPACITY_PER_SID)):
            self.assertTrue(app_module.consume_command_rate_limit(sid, now=now)[0])
        self.assertFalse(app_module.consume_command_rate_limit(sid, now=now)[0])

        # Auto-off is a session preference, not an MQTT write, so it remains
        # usable even when that session's publish budget is exhausted.
        client.emit("set_reporting_auto_off", {"enabled": True})
        self.assertTrue(app_module.get_session_reporting_auto_off(sid))

        with patch.object(app_module.time, "monotonic", return_value=now):
            with patch.object(app_module, "publish_json", return_value=(True, 0)) as publish_mock:
                client.disconnect()

        publish_mock.assert_called_once()
        self.assertEqual(publish_mock.call_args.kwargs.get("origin"), "auto_disable_target_reporting")
        with app_module.command_rate_limits_lock:
            self.assertNotIn(sid, app_module.command_rate_limits)

    def test_auto_off_disconnect_skips_publish_when_backend_or_device_is_not_ready(self):
        for offline_kind in ("broker", "device"):
            with self.subTest(offline_kind=offline_kind):
                client = self._client()
                client.get_received()
                client.emit("change_device", "zigbee2mqtt/device_shared")
                client.emit("set_reporting_auto_off", {"enabled": True})
                client.get_received()
                if offline_kind == "broker":
                    with app_module.mqtt_state_lock:
                        app_module.mqtt_state["broker_connected"] = False
                        app_module.mqtt_state["connected"] = False
                else:
                    with app_module.device_list_lock:
                        app_module.device_list["device_shared"]["availability"] = "offline"
                with patch.object(app_module, "publish_json") as publish_mock:
                    client.disconnect()
                publish_mock.assert_not_called()

                with app_module.mqtt_state_lock:
                    app_module.mqtt_state.update({
                        "connected": True,
                        "broker_connected": True,
                        "zigbee2mqtt_connected": True,
                        "inventory_ready": True,
                    })
                with app_module.device_list_lock:
                    app_module.device_list["device_shared"]["availability"] = None

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

    def test_read_only_firmware_snapshot_preserves_slash_friendly_name(self):
        friendly_name = "kitchen/floor_light"
        topic = f"zigbee2mqtt/{friendly_name}"
        with app_module.device_list_lock:
            app_module.device_list.clear()
            app_module.device_list[friendly_name] = _make_device(friendly_name, topic)
            app_module.device_list[friendly_name]["ota_status"].update({
                "revision": 1,
                "installed_version": "16974080",
            })

        with (
            patch.object(app_module, "get_firmware_reference_snapshot", return_value=_make_reference_snapshot()),
            patch.object(app_module, "schedule_firmware_reference_refresh", return_value=False),
            patch.object(app_module, "publish_json") as publish_mock,
        ):
            snapshot = app_module.build_device_snapshot(topic)

        publish_mock.assert_not_called()
        self.assertEqual(snapshot["topic"], topic)
        self.assertEqual(snapshot["payload"]["ota_status"]["topic"], topic)
        self.assertEqual(snapshot["payload"]["ota_status"]["live"]["installed_version"], "16974080")

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
        with (
            patch.object(app_module, "get_firmware_reference_snapshot", return_value=_make_reference_snapshot()),
            patch.object(app_module, "schedule_firmware_reference_refresh", return_value=False),
        ):
            app_module.on_message(None, None, msg)

        firmware_events = [event["args"][0] for event in client.get_received() if event["name"] == "firmware_status"]
        self.assertTrue(firmware_events)
        latest = firmware_events[-1]["payload"]
        self.assertEqual(latest["live"]["revision"], 1)
        self.assertEqual(latest["live"]["available"], True)
        self.assertEqual(latest["live"]["installed_version"], "16974080")
        self.assertEqual(latest["live"]["latest_version"], "16973834")
        self.assertEqual(latest["live"]["state"], "available")
        self.assertEqual(latest["reference"]["installed_version_detail"]["display_version"], "1.00")
        self.assertEqual(latest["reference"]["installed_version_detail"]["raw_hex"], "0x01030100")
        self.assertEqual(latest["reference"]["latest_version_detail"]["display_version"], "0.10")
        self.assertEqual(latest["reference"]["latest_version_detail"]["raw_hex"], "0x0103000A")
        self.assertEqual(latest["reference"]["official_versions"], {"Production": "1.00", "Beta": "1.01"})

        with app_module.device_list_lock:
            stored = app_module.device_list["Bedroom Light Control"]["ota_status"]
            self.assertEqual(stored["revision"], 1)
            self.assertIsNone(stored["progress"])
            self.assertNotIn("installed_version_detail", stored)
            self.assertNotIn("reference", stored)

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

    def test_command_readiness_blocks_every_publish_family_until_backend_is_ready(self):
        client = self._client()
        client.get_received()
        client.emit("change_device", "zigbee2mqtt/device_a")
        client.get_received()

        with app_module.mqtt_state_lock:
            app_module.mqtt_state.update({
                "connected": False,
                "broker_connected": False,
                "zigbee2mqtt_connected": None,
                "inventory_ready": False,
                "reason": "Disconnected",
            })

        commands = [
            ("set_target_reporting", {"enabled": True, "request_id": "ready-report"}),
            ("set_basic_control", {"state": "ON", "request_id": "ready-basic"}),
            ("update_parameter", {"param": "mmWaveHoldTime", "value": 30, "request_id": "ready-param"}),
            ("apply_parameters", {"changes": {"mmWaveHoldTime": 30}, "request_id": "ready-apply"}),
            ("force_sync", {"request_id": "ready-sync"}),
            ("send_command", 2),
        ]
        with patch.object(app_module, "publish_json") as publish_mock:
            for event_name, payload in commands:
                with self.subTest(event_name=event_name):
                    client.emit(event_name, payload)
                    results = self._command_results(client)
                    self.assertTrue(results)
                    self.assertEqual(results[-1]["status"], "error")
                    self.assertIn("MQTT broker", results[-1]["message"])
        publish_mock.assert_not_called()

    def test_command_readiness_allows_unknown_availability_but_rejects_offline(self):
        topic = "zigbee2mqtt/device_a"
        self.assertIsNone(app_module.get_command_readiness_error(topic))
        with app_module.device_list_lock:
            app_module.device_list["device_a"]["availability"] = "offline"
        self.assertIn("Device is offline", app_module.get_command_readiness_error(topic))

        with app_module.device_list_lock:
            app_module.device_list["device_a"]["availability"] = None
        with app_module.mqtt_state_lock:
            app_module.mqtt_state["zigbee2mqtt_connected"] = False
            app_module.mqtt_state["connected"] = False
        self.assertIn("Zigbee2MQTT is offline", app_module.get_command_readiness_error(topic))

        with app_module.mqtt_state_lock:
            app_module.mqtt_state["zigbee2mqtt_connected"] = True
            app_module.mqtt_state["connected"] = True
            app_module.mqtt_state["inventory_ready"] = False
        self.assertIn("inventory is still loading", app_module.get_command_readiness_error(topic))

    def test_command_readiness_preserves_signature_discovery_fallback(self):
        topic = "zigbee2mqtt/signature_only"
        device = _make_device("signature_only", topic)
        device["inventory_present"] = False
        device["availability"] = None
        with app_module.device_list_lock:
            app_module.device_list["signature_only"] = device

        self.assertIsNone(app_module.get_command_readiness_error(topic))

        with app_module.device_list_lock:
            app_module.device_list["signature_only"]["availability"] = "offline"
        self.assertIn("Device is offline", app_module.get_command_readiness_error(topic))

    def test_command_rate_limit_is_fair_per_sid_and_recovers_with_the_clock(self):
        capacity = int(app_module.COMMAND_RATE_CAPACITY_PER_SID)
        refill_rate = float(app_module.COMMAND_RATE_REFILL_PER_SECOND)
        base_time = 1000.0
        app_module.reset_command_rate_limits(now=base_time)

        for _ in range(capacity):
            allowed, retry_after = app_module.consume_command_rate_limit("sid-a", now=base_time)
            self.assertTrue(allowed)
            self.assertEqual(retry_after, 0)

        allowed, retry_after = app_module.consume_command_rate_limit("sid-a", now=base_time)
        self.assertFalse(allowed)
        self.assertGreater(retry_after, 0)

        # Exhausting one browser must not consume another browser's local bucket.
        allowed, retry_after = app_module.consume_command_rate_limit("sid-b", now=base_time)
        self.assertTrue(allowed)
        self.assertEqual(retry_after, 0)

        # A backwards observation cannot mint tokens; ordinary monotonic
        # progress must still recover one token afterward.
        allowed, _ = app_module.consume_command_rate_limit("sid-a", now=base_time - 10)
        self.assertFalse(allowed)
        allowed, retry_after = app_module.consume_command_rate_limit(
            "sid-a",
            now=base_time + (1.1 / refill_rate),
        )
        self.assertTrue(allowed)
        self.assertEqual(retry_after, 0)
        self.assertFalse(app_module.consume_command_rate_limit(
            "sid-a",
            now=base_time + (1.1 / refill_rate),
        )[0])

    def test_command_rate_limit_applies_global_backpressure_and_refills(self):
        capacity = int(app_module.COMMAND_RATE_GLOBAL_CAPACITY)
        refill_rate = float(app_module.COMMAND_RATE_GLOBAL_REFILL_PER_SECOND)
        base_time = 2000.0
        app_module.reset_command_rate_limits(now=base_time)

        for index in range(capacity):
            allowed, retry_after = app_module.consume_command_rate_limit(
                f"global-sid-{index}",
                now=base_time,
            )
            self.assertTrue(allowed)
            self.assertEqual(retry_after, 0)

        allowed, retry_after = app_module.consume_command_rate_limit(
            "global-overflow",
            now=base_time,
        )
        self.assertFalse(allowed)
        self.assertGreater(retry_after, 0)

        allowed, retry_after = app_module.consume_command_rate_limit(
            "global-recovered",
            now=base_time + (1.1 / refill_rate),
        )
        self.assertTrue(allowed)
        self.assertEqual(retry_after, 0)

    def test_command_rate_limit_cost_is_atomic(self):
        capacity = int(app_module.COMMAND_RATE_CAPACITY_PER_SID)
        base_time = 3000.0
        app_module.reset_command_rate_limits(now=base_time)

        for _ in range(capacity - 1):
            self.assertTrue(app_module.consume_command_rate_limit("sid-cost", now=base_time)[0])

        allowed, retry_after = app_module.consume_command_rate_limit(
            "sid-cost",
            cost=2,
            now=base_time,
        )
        self.assertFalse(allowed)
        self.assertGreater(retry_after, 0)

        # A rejected multi-token request must not consume the final token.
        self.assertTrue(app_module.consume_command_rate_limit("sid-cost", now=base_time)[0])

    def test_publish_handlers_are_throttled_and_force_sync_costs_two_tokens(self):
        client = self._client()
        client.get_received()
        client.emit("change_device", "zigbee2mqtt/device_a")
        client.get_received()

        events = (
            (
                "set_target_reporting",
                {"enabled": True, "request_id": "limited-target"},
                "set_target_reporting",
                1,
            ),
            (
                "set_basic_control",
                {"state": "ON", "request_id": "limited-basic"},
                "set_basic_control",
                1,
            ),
            (
                "update_parameter",
                {"param": "mmWaveHoldTime", "value": 30, "request_id": "limited-update"},
                "update_parameter",
                1,
            ),
            (
                "apply_parameters",
                {"changes": {"mmWaveHoldTime": 30}, "request_id": "limited-apply"},
                "apply_parameters",
                1,
            ),
            ("force_sync", {"request_id": "limited-sync"}, "force_sync", 2),
            ("send_command", 2, "send_command", 1),
        )
        with patch.object(app_module, "enforce_command_rate_limit_or_emit", return_value=False) as enforce_mock:
            with patch.object(app_module, "publish_json") as publish_mock:
                for event_name, payload, expected_action, expected_cost in events:
                    with self.subTest(event_name=event_name):
                        enforce_mock.reset_mock()
                        client.emit(event_name, payload)
                        enforce_mock.assert_called_once()
                        args, kwargs = enforce_mock.call_args
                        self.assertEqual(args[0], self._server_sid(client))
                        self.assertEqual(args[1], expected_action)
                        actual_cost = kwargs.get("cost", args[2] if len(args) > 2 else 1)
                        self.assertEqual(actual_cost, expected_cost)
                        received = client.get_received()
                        if event_name == "force_sync":
                            self.assertNotIn("device_snapshot", [event["name"] for event in received])
                publish_mock.assert_not_called()
        with app_module.pending_writes_lock:
            self.assertEqual(app_module.pending_writes, {})

    def test_invalid_or_unready_commands_do_not_consume_rate_tokens(self):
        client = self._client()
        client.get_received()

        with patch.object(app_module, "enforce_command_rate_limit_or_emit") as enforce_mock:
            client.emit(
                "set_basic_control",
                {"state": "ON", "request_id": "unready-basic"},
            )
            client.emit(
                "set_basic_control",
                {"topic": "zigbee2mqtt/device_a", "request_id": "missing-control"},
            )
            with patch.object(
                app_module.schema_service,
                "validate_update",
                return_value=(False, "invalid test value", None, False),
            ):
                client.emit(
                    "update_parameter",
                    {
                        "topic": "zigbee2mqtt/device_a",
                        "param": "mmWaveHoldTime",
                        "value": 30,
                        "request_id": "invalid-schema-value",
                    },
                )
            with patch.object(app_module, "build_force_sync_payload", return_value={}):
                client.emit(
                    "force_sync",
                    {"topic": "zigbee2mqtt/device_a", "request_id": "no-readable-fields"},
                )

        enforce_mock.assert_not_called()

    def test_rate_limited_command_returns_retryable_error_before_publish(self):
        client = self._client()
        client.get_received()
        client.emit("change_device", "zigbee2mqtt/device_a")
        client.get_received()
        sid = self._server_sid(client)
        now = 4000.0

        for _ in range(int(app_module.COMMAND_RATE_CAPACITY_PER_SID)):
            self.assertTrue(app_module.consume_command_rate_limit(sid, now=now)[0])

        with patch.object(app_module.time, "monotonic", return_value=now):
            with patch.object(app_module, "publish_json") as publish_mock:
                client.emit(
                    "set_basic_control",
                    {"state": "ON", "request_id": "rate-limited-basic"},
                )
        publish_mock.assert_not_called()
        result = self._command_results(client, "set_basic_control")[-1]
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["error_code"], "rate_limited")
        self.assertTrue(result["retryable"])
        self.assertGreater(result["retry_after_ms"], 0)
        self.assertEqual(result["payload"]["retry_after_ms"], result["retry_after_ms"])

    def test_read_only_events_and_session_preference_are_not_rate_limited(self):
        client = self._client()
        client.get_received()
        sid = self._server_sid(client)
        now = 5000.0
        for _ in range(int(app_module.COMMAND_RATE_CAPACITY_PER_SID)):
            self.assertTrue(app_module.consume_command_rate_limit(sid, now=now)[0])

        with patch.object(app_module.time, "monotonic", return_value=now):
            client.emit("request_devices")
            client.emit("request_schema")
            client.emit("change_device", "zigbee2mqtt/device_a")
            client.emit("set_reporting_auto_off", {"enabled": True})

        received_names = [event["name"] for event in client.get_received()]
        self.assertIn("device_list", received_names)
        self.assertIn("schema_model", received_names)
        self.assertIn("device_snapshot", received_names)
        self.assertTrue(app_module.get_session_reporting_auto_off(sid))
        client.emit("set_reporting_auto_off", {"enabled": False})

    def test_disconnect_clears_only_that_sids_command_bucket(self):
        client_a = self._client()
        client_b = self._client()
        client_a.get_received()
        client_b.get_received()
        sid_a = self._server_sid(client_a)
        sid_b = self._server_sid(client_b)
        now = 6000.0

        for _ in range(int(app_module.COMMAND_RATE_CAPACITY_PER_SID)):
            self.assertTrue(app_module.consume_command_rate_limit(sid_a, now=now)[0])
            self.assertTrue(app_module.consume_command_rate_limit(sid_b, now=now)[0])
        self.assertFalse(app_module.consume_command_rate_limit(sid_a, now=now)[0])
        self.assertFalse(app_module.consume_command_rate_limit(sid_b, now=now)[0])

        client_a.disconnect()
        self.assertTrue(app_module.consume_command_rate_limit(sid_a, now=now)[0])
        self.assertFalse(app_module.consume_command_rate_limit(sid_b, now=now)[0])

    def test_command_payload_and_request_limits_reject_before_publish(self):
        client = self._client()
        client.get_received()
        client.emit("change_device", "zigbee2mqtt/device_a")
        client.get_received()

        with patch.object(app_module, "publish_json") as publish_mock:
            client.emit(
                "update_parameter",
                {
                    "param": "futureScalar",
                    "value": "x" * (app_module.MAX_STRING_LENGTH + 1),
                    "request_id": "oversized-value",
                },
            )
            result = self._command_results(client, "update_parameter")[-1]
            self.assertEqual(result["status"], "error")
            self.assertIn("UTF-8 bytes", result["message"])

            client.emit(
                "update_parameter",
                {
                    "param": "mmWaveHoldTime",
                    "value": 30,
                    "request_id": "bad request id with spaces",
                },
            )
            result = self._command_results(client, "update_parameter")[-1]
            self.assertEqual(result["status"], "error")
            self.assertIn("Request ID", result["message"])

            with patch.object(app_module, "MAX_CHANGE_COUNT", 1):
                client.emit(
                    "apply_parameters",
                    {
                        "request_id": "too-many-fields",
                        "changes": {"mmWaveHoldTime": 30, "mmWaveStayLife": 5},
                    },
                )
            result = self._command_results(client, "apply_parameters")[-1]
            self.assertEqual(result["status"], "error")
            self.assertIn("At most 1", result["message"])

            oversized = "x" * (app_module.MAX_STRING_LENGTH + 1)
            bounded_envelope_cases = (
                ("set_reporting_auto_off", {"enabled": True, "ignored": oversized}),
                ("set_target_reporting", {"enabled": True, "ignored": oversized}),
                ("set_basic_control", {"state": "ON", "ignored": oversized}),
                (
                    "update_parameter",
                    {"param": "mmWaveHoldTime", "value": 30, "ignored": oversized},
                ),
                (
                    "apply_parameters",
                    {"changes": {"mmWaveHoldTime": 30}, "ignored": oversized},
                ),
                ("force_sync", {"ignored": oversized}),
                ("send_command", oversized),
            )
            for event_name, envelope in bounded_envelope_cases:
                with self.subTest(event_name=event_name):
                    client.emit(event_name, envelope)
                    result = self._command_results(client, event_name)[-1]
                    self.assertEqual(result["status"], "error")
                    self.assertIn("UTF-8 bytes", result["message"])

            client.emit(
                "set_basic_control",
                {"brightness": float("nan"), "request_id": "nonfinite-brightness"},
            )
            result = self._command_results(client, "set_basic_control")[-1]
            self.assertEqual(result["status"], "error")
            self.assertIn("finite", result["message"])
        publish_mock.assert_not_called()

        nested = {"value": 1}
        for _ in range(app_module.MAX_VALUE_DEPTH + 1):
            nested = {"child": nested}
        self.assertIn("nesting", app_module.validate_command_payload(nested))
        self.assertIn("finite", app_module.validate_command_payload({"value": float("nan")}))
        self.assertIn("valid UTF-8", app_module.validate_command_payload({"value": "\ud800"}))
        self.assertIn("valid UTF-8", app_module.validate_command_payload({"\ud800": "value"}))

    def test_pending_write_caps_fail_closed_without_replacing_existing_work(self):
        with patch.object(app_module, "MAX_PENDING_WRITES_PER_SID", 1):
            first = app_module.register_pending_write(
                "sid-a", "one", "zigbee2mqtt/device_a", "update_parameter", {"one": 1}
            )
            duplicate = app_module.register_pending_write(
                "sid-a", "one", "zigbee2mqtt/device_a", "update_parameter", {"replacement": 9}
            )
            second = app_module.register_pending_write(
                "sid-a", "two", "zigbee2mqtt/device_a", "update_parameter", {"two": 2}
            )
        self.assertIsNotNone(first)
        self.assertIsNone(duplicate)
        self.assertIsNone(second)
        with app_module.pending_writes_lock:
            self.assertEqual(app_module.pending_writes["sid-a:one"]["expected"], {"one": 1})

        with app_module.pending_writes_lock:
            app_module.pending_writes.clear()
        with patch.object(app_module, "MAX_PENDING_WRITES_GLOBAL", 1):
            self.assertIsNotNone(app_module.register_pending_write(
                "sid-a", "one", "zigbee2mqtt/device_a", "update_parameter", {"one": 1}
            ))
            self.assertIsNone(app_module.register_pending_write(
                "sid-b", "two", "zigbee2mqtt/device_b", "update_parameter", {"two": 2}
            ))

    def test_signature_discovery_upgrades_quick_controls_from_later_reports_only(self):
        topic = "zigbee2mqtt/signature_only"
        device = _make_device(
            "signature_only",
            topic,
            capabilities={
                "state": False,
                "brightness": False,
                "full_editor": True,
                "state_property": None,
                "brightness_property": None,
                "readable_state_property": None,
                "readable_brightness_property": None,
                "quick_controls_ambiguous": False,
            },
        )
        device["inventory_present"] = False
        with app_module.device_list_lock:
            app_module.device_list.clear()
            app_module.device_list["signature_only"] = device

        with patch.object(app_module, "emit_device_list") as emit_device_list:
            app_module.on_message(
                None,
                None,
                SimpleNamespace(
                    topic=topic,
                    payload=json.dumps({"state": "ON", "brightness": 120}).encode("utf-8"),
                ),
            )
        upgraded = app_module.get_device_by_topic(topic)["capabilities"]
        self.assertTrue(upgraded["state"])
        self.assertTrue(upgraded["brightness"])
        self.assertEqual(upgraded["state_property"], "state")
        self.assertEqual(upgraded["brightness_property"], "brightness")
        emit_device_list.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
