import json
import os
import tempfile
import unittest

from switch_studio.schema_service import SchemaService


class SchemaServiceValidationTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False, encoding="utf-8")
        definition = {
            "model": "VZM32-SN",
            "vendor": "Inovelli",
            "exposes": [
                {
                    "name": "mmWaveHoldTime",
                    "property": "mmWaveHoldTime",
                    "type": "numeric",
                    "access": 7,
                    "value_min": 0,
                    "value_max": 600,
                    "value_step": 1,
                },
                {
                    "name": "mmwaveControlWiredDevice",
                    "property": "mmwaveControlWiredDevice",
                    "type": "enum",
                    "access": 7,
                    "values": ["Disabled", "Vacancy"],
                },
                {
                    "name": "occupancy",
                    "property": "occupancy",
                    "type": "binary",
                    "access": 5,
                    "value_on": True,
                    "value_off": False,
                },
                {
                    "name": "calibration",
                    "property": "calibration",
                    "type": "numeric",
                    "access": 3,
                    "value_step": 0.1,
                },
                {
                    "name": "offset_step",
                    "property": "offset_step",
                    "type": "numeric",
                    "access": 3,
                    "value_min": 0.05,
                    "value_max": 1.05,
                    "value_step": 0.1,
                },
                {
                    "name": "odd_count",
                    "property": "odd_count",
                    "type": "numeric",
                    "access": 3,
                    "value_min": 1,
                    "value_max": 9,
                    "value_step": 2,
                },
                {
                    "name": "mmwave_detection_areas",
                    "property": "mmwave_detection_areas",
                    "type": "composite",
                    "access": 7,
                    "features": [
                        {
                            "name": "area_1",
                            "property": "area1",
                            "type": "composite",
                            "access": 1,
                            "features": [
                                {
                                    "name": "width_min",
                                    "property": "width_min",
                                    "type": "numeric",
                                    "access": 3,
                                    "value_min": -600,
                                    "value_max": 600,
                                },
                                {
                                    "name": "width_max",
                                    "property": "width_max",
                                    "type": "numeric",
                                    "access": 3,
                                    "value_min": -600,
                                    "value_max": 600,
                                },
                                {
                                    "name": "mode",
                                    "property": "mode",
                                    "type": "enum",
                                    "access": 3,
                                    "values": ["include", "exclude"],
                                },
                                {
                                    "name": "occupancy",
                                    "property": "occupancy",
                                    "type": "binary",
                                    "access": 1,
                                    "value_on": True,
                                    "value_off": False,
                                },
                            ],
                        },
                        {
                            "name": "area_2",
                            "property": "area2",
                            "type": "composite",
                            "access": 1,
                            "features": [
                                {
                                    "name": "width_min",
                                    "property": "width_min",
                                    "type": "numeric",
                                    "access": 3,
                                    "value_min": -600,
                                    "value_max": 600,
                                },
                            ],
                        },
                    ],
                },
                {
                    "name": "mmwave_control_commands",
                    "property": "mmwave_control_commands",
                    "type": "composite",
                    "access": 3,
                    "features": [
                        {
                            "name": "controlID",
                            "property": "controlID",
                            "type": "enum",
                            "access": 3,
                            "values": ["query_areas", "clear_stay_areas"],
                        }
                    ],
                },
                {
                    "name": "no_occupancy_since",
                    "property": "no_occupancy_since",
                    "type": "list",
                    "access": 3,
                    "item_type": {
                        "name": "time",
                        "type": "numeric",
                        "access": 3,
                        "value_min": 0,
                        "value_max": 600,
                        "value_step": 30,
                    },
                },
                {
                    "name": "allowed_modes",
                    "property": "allowed_modes",
                    "type": "list",
                    "access": 3,
                    "item_type": {
                        "name": "mode",
                        "type": "enum",
                        "access": 3,
                        "values": ["fast", "slow"],
                    },
                },
                {
                    "name": "read_only_items",
                    "property": "read_only_items",
                    "type": "list",
                    "access": 3,
                    "item_type": {
                        "name": "value",
                        "type": "numeric",
                        "access": 1,
                    },
                },
                {
                    "name": "led_effect",
                    "property": "led_effect",
                    "type": "composite",
                    "access": 7,
                    "features": [
                        {"name": "effect", "property": "effect", "type": "enum", "access": 7, "values": ["solid", "chase", "clear_effect"]},
                        {"name": "color", "property": "color", "type": "numeric", "access": 7, "value_min": 0, "value_max": 255},
                        {"name": "level", "property": "level", "type": "numeric", "access": 7, "value_min": 0, "value_max": 100},
                        {"name": "duration", "property": "duration", "type": "numeric", "access": 7, "value_min": 0, "value_max": 255},
                    ],
                },
                {
                    "name": "individual_led_effect",
                    "property": "individual_led_effect",
                    "type": "composite",
                    "access": 7,
                    "features": [
                        {"name": "led", "property": "led", "type": "enum", "access": 7, "values": ["1", "2", "3", "4", "5", "6", "7"]},
                        {"name": "effect", "property": "effect", "type": "enum", "access": 7, "values": ["solid", "chase", "clear_effect"]},
                        {"name": "color", "property": "color", "type": "numeric", "access": 7, "value_min": 0, "value_max": 255},
                        {"name": "level", "property": "level", "type": "numeric", "access": 7, "value_min": 0, "value_max": 100},
                        {"name": "duration", "property": "duration", "type": "numeric", "access": 7, "value_min": 0, "value_max": 255},
                    ],
                },
            ],
            "options": [],
        }
        json.dump(definition, self._tmp)
        self._tmp.close()
        self.service = SchemaService(definition_paths=[self._tmp.name])

    def tearDown(self):
        try:
            os.unlink(self._tmp.name)
        except FileNotFoundError:
            pass

    def test_numeric_validation_and_bounds(self):
        ok, err, value, unknown = self.service.validate_update("mmWaveHoldTime", "42")
        self.assertTrue(ok)
        self.assertIsNone(err)
        self.assertEqual(value, 42)
        self.assertFalse(unknown)

        ok, err, value, unknown = self.service.validate_update("mmWaveHoldTime", -1)
        self.assertFalse(ok)
        self.assertIsNotNone(err)
        self.assertIn("below min", err)
        self.assertIsNone(value)
        self.assertFalse(unknown)

    def test_integer_numeric_fields_reject_fractional_boolean_and_non_finite_values(self):
        invalid_values = [True, False, 1.6, "1.6", float("nan"), float("inf"), float("-inf"), "NaN", "Infinity"]
        for candidate in invalid_values:
            with self.subTest(candidate=repr(candidate)):
                ok, err, value, unknown = self.service.validate_update("mmWaveHoldTime", candidate)
                self.assertFalse(ok)
                self.assertIsNotNone(err)
                self.assertIsNone(value)
                self.assertFalse(unknown)

        ok, err, value, unknown = self.service.validate_update("mmWaveHoldTime", 42.0)
        self.assertTrue(ok)
        self.assertIsNone(err)
        self.assertEqual(value, 42)
        self.assertIs(type(value), int)
        self.assertFalse(unknown)

    def test_decimal_steps_are_exact_and_relative_to_the_declared_minimum(self):
        for candidate, expected in [(0.3, 0.3), ("-0.3", -0.3), ("1.20", 1.2)]:
            with self.subTest(field="calibration", candidate=candidate):
                ok, err, value, unknown = self.service.validate_update("calibration", candidate)
                self.assertTrue(ok)
                self.assertIsNone(err)
                self.assertEqual(value, expected)
                self.assertFalse(unknown)

        for candidate in [0.31, "0.30000000000000004"]:
            with self.subTest(field="calibration", candidate=candidate):
                ok, err, value, unknown = self.service.validate_update("calibration", candidate)
                self.assertFalse(ok)
                self.assertIn("step 0.1", err)
                self.assertIsNone(value)
                self.assertFalse(unknown)

        ok, err, value, unknown = self.service.validate_update("offset_step", "0.15")
        self.assertTrue(ok)
        self.assertIsNone(err)
        self.assertEqual(value, 0.15)
        self.assertFalse(unknown)

        ok, err, value, unknown = self.service.validate_update("offset_step", "0.10")
        self.assertFalse(ok)
        self.assertIn("step 0.1", err)
        self.assertIsNone(value)
        self.assertFalse(unknown)

    def test_integral_steps_are_enforced_relative_to_the_declared_minimum(self):
        for candidate in [1, 3, "9"]:
            with self.subTest(candidate=candidate):
                ok, err, value, unknown = self.service.validate_update("odd_count", candidate)
                self.assertTrue(ok)
                self.assertIsNone(err)
                self.assertEqual(value, int(candidate))
                self.assertFalse(unknown)

        for candidate in [2, 4.5]:
            with self.subTest(candidate=candidate):
                ok, err, value, unknown = self.service.validate_update("odd_count", candidate)
                self.assertFalse(ok)
                self.assertIsNotNone(err)
                self.assertIsNone(value)
                self.assertFalse(unknown)

    def test_enum_validation_and_read_only_field(self):
        ok, err, value, unknown = self.service.validate_update("mmwaveControlWiredDevice", "Vacancy")
        self.assertTrue(ok)
        self.assertIsNone(err)
        self.assertEqual(value, "Vacancy")
        self.assertFalse(unknown)

        ok, err, value, unknown = self.service.validate_update("mmwaveControlWiredDevice", "Invalid")
        self.assertFalse(ok)
        self.assertIsNotNone(err)
        self.assertIn("not allowed", err)
        self.assertIsNone(value)
        self.assertFalse(unknown)

        ok, err, value, unknown = self.service.validate_update("occupancy", True)
        self.assertFalse(ok)
        self.assertIsNotNone(err)
        self.assertIn("read-only", err)
        self.assertIsNone(value)
        self.assertFalse(unknown)

    def test_schema_distinguishes_state_updates_from_explicit_get_access(self):
        fields = {field["name"]: field for field in self.service.get_schema()["fields"]}
        self.assertTrue(fields["mmWaveHoldTime"]["can_state"])
        self.assertTrue(fields["mmWaveHoldTime"]["can_get"])
        self.assertTrue(fields["calibration"]["can_state"])
        self.assertFalse(fields["calibration"]["can_get"])
        self.assertTrue(fields["occupancy"]["can_state"])
        self.assertTrue(fields["occupancy"]["can_get"])

    def test_unknown_field_allows_only_bounded_safe_json_scalars(self):
        allowed = [None, True, False, "future value", 42, -1.25]
        for candidate in allowed:
            with self.subTest(candidate=repr(candidate)):
                ok, err, value, unknown = self.service.validate_update("future_new_field", candidate)
                self.assertTrue(ok)
                self.assertIsNone(err)
                self.assertEqual(value, candidate)
                self.assertTrue(unknown)

        rejected = [
            {"foo": "bar"},
            [1, 2],
            (1, 2),
            float("nan"),
            float("inf"),
            2 ** 53,
            "x" * 1025,
            "☃" * 342,
            "\ud800",
        ]
        for candidate in rejected:
            with self.subTest(candidate=type(candidate).__name__):
                ok, err, value, unknown = self.service.validate_update("future_new_field", candidate)
                self.assertFalse(ok)
                self.assertIsNotNone(err)
                self.assertIsNone(value)
                self.assertTrue(unknown)

        ok, err, value, unknown = self.service.validate_update("future_new_field", "x" * 1024)
        self.assertTrue(ok)
        self.assertIsNone(err)
        self.assertEqual(value, "x" * 1024)
        self.assertTrue(unknown)

    def test_parameter_name_validation_never_looks_up_unhashable_values(self):
        class UnhashableString(str):
            __hash__ = None

        invalid_names = [
            None,
            {},
            [],
            0,
            UnhashableString("mmWaveHoldTime"),
            "",
            "x" * 129,
            "future field",
            "future/field",
        ]
        for param in invalid_names:
            with self.subTest(param=repr(param)):
                ok, err, value, unknown = self.service.validate_update(param, 1)
                self.assertFalse(ok)
                self.assertIsNotNone(err)
                self.assertIsNone(value)

    def test_zone_composites_validate_supplied_children_without_requiring_sibling_areas(self):
        payload = {"area1": {"width_min": "-25", "width_max": 30, "mode": "include"}}
        ok, err, value, unknown = self.service.validate_update("mmwave_detection_areas", payload)
        self.assertTrue(ok)
        self.assertIsNone(err)
        self.assertEqual(
            value,
            {"area1": {"width_min": -25, "width_max": 30, "mode": "include"}},
        )
        self.assertFalse(unknown)

        # Zigbee2MQTT exposes a display name (area_1) and wire property (area1).
        # Either input alias is accepted, but MQTT output is canonicalized to the property.
        ok, err, value, unknown = self.service.validate_update(
            "mmwave_detection_areas",
            {"area_1": {"width_min": 12}},
        )
        self.assertTrue(ok)
        self.assertIsNone(err)
        self.assertEqual(value, {"area1": {"width_min": 12}})
        self.assertFalse(unknown)

    def test_composites_reject_empty_unknown_duplicate_read_only_and_invalid_children(self):
        invalid_payloads = [
            {},
            {"area3": {"width_min": 0}},
            {"area1": {}},
            {"area1": {"unknown": 0}},
            {"area1": {"width_min": -601}},
            {"area1": {"width_min": 1.5}},
            {"area1": {"mode": "invalid"}},
            {"area1": {"occupancy": True}},
            {"area1": {"width_min": 0}, "area_1": {"width_max": 10}},
        ]
        for payload in invalid_payloads:
            with self.subTest(payload=payload):
                ok, err, value, unknown = self.service.validate_update("mmwave_detection_areas", payload)
                self.assertFalse(ok)
                self.assertIsNotNone(err)
                self.assertIsNone(value)
                self.assertFalse(unknown)

    def test_command_composite_enforces_enum_and_unexpected_key_constraints(self):
        ok, err, value, unknown = self.service.validate_update(
            "mmwave_control_commands",
            {"controlID": "query_areas"},
        )
        self.assertTrue(ok)
        self.assertIsNone(err)
        self.assertEqual(value, {"controlID": "query_areas"})
        self.assertFalse(unknown)

        for payload in [{}, {"controlID": "erase_everything"}, {"command": "query_areas"}]:
            with self.subTest(payload=payload):
                ok, err, value, unknown = self.service.validate_update("mmwave_control_commands", payload)
                self.assertFalse(ok)
                self.assertIsNotNone(err)
                self.assertIsNone(value)
                self.assertFalse(unknown)

    def test_lists_recursively_validate_and_normalize_every_item(self):
        ok, err, value, unknown = self.service.validate_update("no_occupancy_since", ["0", 30, 60.0])
        self.assertTrue(ok)
        self.assertIsNone(err)
        self.assertEqual(value, [0, 30, 60])
        self.assertFalse(unknown)

        ok, err, value, unknown = self.service.validate_update("allowed_modes", ["fast", "slow"])
        self.assertTrue(ok)
        self.assertIsNone(err)
        self.assertEqual(value, ["fast", "slow"])
        self.assertFalse(unknown)

        invalid_lists = [
            ("no_occupancy_since", "30"),
            ("no_occupancy_since", [True]),
            ("no_occupancy_since", [31]),
            ("no_occupancy_since", [601]),
            ("no_occupancy_since", [{}]),
            ("no_occupancy_since", ["1_0"]),
            ("no_occupancy_since", ["1e999999999"]),
            ("no_occupancy_since", ["9" * 129]),
            ("allowed_modes", ["medium"]),
            ("read_only_items", []),
            ("read_only_items", [1]),
        ]
        for param, payload in invalid_lists:
            with self.subTest(param=param, payload=payload):
                ok, err, value, unknown = self.service.validate_update(param, payload)
                self.assertFalse(ok)
                self.assertIsNotNone(err)
                self.assertIsNone(value)
                self.assertFalse(unknown)

    def test_led_effect_composites_validate_required_nested_values(self):
        payload = {"effect": "chase", "color": 255, "level": 47, "duration": 61}
        ok, err, value, unknown = self.service.validate_update("led_effect", payload)
        self.assertTrue(ok)
        self.assertIsNone(err)
        self.assertEqual(value, payload)
        self.assertFalse(unknown)

        individual = {"led": "7", "effect": "solid", "color": 0, "level": 100, "duration": 255}
        ok, err, value, unknown = self.service.validate_update("individual_led_effect", individual)
        self.assertTrue(ok)
        self.assertIsNone(err)
        self.assertEqual(value, individual)
        self.assertFalse(unknown)

    def test_led_effect_composites_reject_malformed_or_out_of_range_children(self):
        invalid_payloads = [
            ("led_effect", {"effect": "solid", "color": 1, "level": 50}),
            ("led_effect", {"effect": "unknown", "color": 1, "level": 50, "duration": 10}),
            ("led_effect", {"effect": "solid", "color": 256, "level": 50, "duration": 10}),
            ("led_effect", {"effect": "solid", "color": 1, "level": 50.5, "duration": 10}),
            ("individual_led_effect", {"led": "8", "effect": "solid", "color": 1, "level": 50, "duration": 10}),
            ("individual_led_effect", {"led": "1", "effect": "solid", "color": 1, "level": 50, "duration": 10, "extra": True}),
        ]
        for param, payload in invalid_payloads:
            with self.subTest(param=param, payload=payload):
                ok, err, value, unknown = self.service.validate_update(param, payload)
                self.assertFalse(ok)
                self.assertIsNotNone(err)
                self.assertIsNone(value)
                self.assertFalse(unknown)


if __name__ == "__main__":
    unittest.main()
