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
                    "name": "mmwave_detection_areas",
                    "property": "mmwave_detection_areas",
                    "type": "composite",
                    "access": 7,
                    "features": [
                        {"name": "area1", "property": "area1", "type": "composite", "access": 7},
                    ],
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

    def test_unknown_field_is_allowed_for_forward_compatibility(self):
        ok, err, value, unknown = self.service.validate_update("future_new_field", {"foo": "bar"})
        self.assertTrue(ok)
        self.assertIsNone(err)
        self.assertEqual(value, {"foo": "bar"})
        self.assertTrue(unknown)

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
