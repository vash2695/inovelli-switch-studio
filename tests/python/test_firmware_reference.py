import unittest
import json
import os
import tempfile
import threading
import time
from unittest.mock import patch

from switch_studio import firmware_reference


class FirmwareReferenceTests(unittest.TestCase):
    def setUp(self):
        self.cache_dir = tempfile.TemporaryDirectory()
        self.cache_path = os.path.join(self.cache_dir.name, "firmware-reference.json")
        self.path_patch = patch.object(firmware_reference, "REFERENCE_CACHE_PATH", self.cache_path)
        self.path_patch.start()
        with firmware_reference._CACHE_LOCK:
            firmware_reference._REFERENCE_CACHE.clear()
            firmware_reference._REFERENCE_REFRESHING.clear()
            firmware_reference._REFERENCE_REFRESH_EVENTS.clear()

    def tearDown(self):
        with firmware_reference._CACHE_LOCK:
            events = list(firmware_reference._REFERENCE_REFRESH_EVENTS.values())
        for event in events:
            event.wait(2)
        self.path_patch.stop()
        self.cache_dir.cleanup()

    @staticmethod
    def _reference_data(version="1.01", fetched_at=100.0, sources=None):
        entry = firmware_reference._build_entry(
            16974081,
            display_version=version,
            source_name="test",
        )
        return {
            "entries": {16974081: entry},
            "current_versions": {"Production": version},
            "sources": sources or {
                key: {"status": "ok", "error": None, "fetched_at": fetched_at, "stale": False}
                for key in ("zigbee_ota_catalog", "inovelli_repo", "inovelli_help", "inovelli_community")
            },
            "source_data": {"inovelli_help": {"Production": version}},
            "fetched_at": fetched_at,
        }

    def test_extract_public_version_from_filename(self):
        self.assertEqual(
            firmware_reference.extract_public_version_from_filename("VZM32-SN_1.01.ota"),
            "1.01",
        )
        self.assertEqual(
            firmware_reference.extract_public_version_from_filename("https://files.inovelli.com/firmware/VZM32-SN/Beta/0.10/VZM32-SN_0.10.ota"),
            "0.10",
        )
        self.assertIsNone(firmware_reference.extract_public_version_from_filename("not-a-firmware.bin"))

    def test_derive_vzm32sn_public_version_from_build(self):
        self.assertEqual(firmware_reference.derive_vzm32sn_public_version(16974080), "1.00")
        self.assertEqual(firmware_reference.derive_vzm32sn_public_version(16974081), "1.01")
        self.assertEqual(firmware_reference.derive_vzm32sn_public_version(16973834), "0.10")

    def test_parse_ota_file_version_from_bytes(self):
        raw = bytearray(32)
        raw[12:16] = bytes.fromhex("01010301")
        self.assertEqual(firmware_reference.parse_ota_file_version(raw), 16974081)

    def test_resolve_exact_reference_prefers_online_match(self):
        reference_data = {
            "entries": {
                16974081: {
                    "build": "16974081",
                    "raw_hex": "0x01030101",
                    "display_version": "1.01",
                    "track": "Beta",
                    "file_name": "VZM32-SN_1.01.ota",
                    "source_name": "Inovelli firmware file",
                    "source_url": "https://github.com/InovelliUSA/Firmware/tree/main/Blue-Series/Zigbee/VZM32-SN-MMWave-Switch/Beta/1.01",
                    "match_kind": "exact",
                    "exact_match": True,
                    "alias_versions": [],
                }
            },
            "current_versions": {"Production": "1.00", "Beta": "1.01"},
        }
        resolved = firmware_reference.resolve_vzm32sn_firmware_reference(
            "16974081",
            allow_network=False,
            reference_data=reference_data,
        )
        self.assertEqual(resolved["display_version"], "1.01")
        self.assertEqual(resolved["track"], "Beta")
        self.assertTrue(resolved["exact_match"])

    def test_resolve_derived_reference_uses_current_help_version(self):
        reference_data = {
            "entries": {},
            "current_versions": {"Production": "1.00", "Beta": "1.01"},
        }
        resolved = firmware_reference.resolve_vzm32sn_firmware_reference(
            16974080,
            allow_network=False,
            reference_data=reference_data,
        )
        self.assertEqual(resolved["display_version"], "1.00")
        self.assertEqual(resolved["track"], "Production")
        self.assertEqual(resolved["source_name"], "Inovelli help center")
        self.assertEqual(resolved["match_kind"], "derived_current")

    def test_get_is_immediate_and_schedules_single_flight_refresh(self):
        entered = threading.Event()
        release = threading.Event()
        call_count = 0

        def blocked_build(previous_data=None):
            nonlocal call_count
            call_count += 1
            entered.set()
            release.wait(2)
            return self._reference_data()

        with patch.object(firmware_reference, "_build_reference_data", side_effect=blocked_build):
            started = time.monotonic()
            first = firmware_reference.get_vzm32sn_reference_data()
            self.assertLess(time.monotonic() - started, 0.2)
            self.assertTrue(entered.wait(1))
            snapshots = [firmware_reference.get_vzm32sn_reference_data() for _ in range(8)]
            self.assertEqual(call_count, 1)
            self.assertTrue(first["reference_refreshing"])
            self.assertEqual(first["reference_status"], "refreshing")
            self.assertEqual(first["generation"], 1)
            self.assertTrue(all(item["reference_refreshing"] for item in snapshots))
            self.assertTrue(all(item["generation"] == 1 for item in snapshots))
            release.set()
            result = firmware_reference.refresh_vzm32sn_reference_data()

        self.assertEqual(result["reference_status"], "ready")
        self.assertEqual(result["generation"], 2)
        self.assertFalse(result["reference_refreshing"])

    def test_refresh_lifecycle_advances_at_start_and_completion_without_joiner_increment(self):
        entered = threading.Event()
        release = threading.Event()
        join_result = []
        with firmware_reference._CACHE_LOCK:
            firmware_reference._REFERENCE_CACHE["vzm32sn"] = {
                "data": self._reference_data(version="1.00"),
                "status": "ready",
                "expires_at": 0,
                "last_attempt_at": 100,
                "last_error": None,
                "generation": 10,
            }

        def blocked_build(previous_data=None):
            entered.set()
            release.wait(2)
            return self._reference_data(version="1.01")

        def join_refresh():
            join_result.append(
                firmware_reference.refresh_vzm32sn_reference_data(force_refresh=True)
            )

        with patch.object(firmware_reference, "_build_reference_data", side_effect=blocked_build):
            started = firmware_reference.get_vzm32sn_reference_data(force_refresh=True)
            self.assertTrue(entered.wait(1))
            self.assertEqual(started["generation"], 11)
            self.assertEqual(started["reference_status"], "refreshing")
            self.assertTrue(started["reference_refreshing"])

            joiner = threading.Thread(target=join_refresh)
            joiner.start()
            time.sleep(0.02)
            in_flight = firmware_reference.get_vzm32sn_reference_data(allow_network=False)
            self.assertEqual(in_flight["generation"], 11)
            self.assertEqual(in_flight["reference_status"], "refreshing")
            self.assertTrue(joiner.is_alive())

            release.set()
            joiner.join(1)

        self.assertFalse(joiner.is_alive())
        self.assertEqual(len(join_result), 1)
        self.assertEqual(join_result[0]["generation"], 12)
        self.assertEqual(join_result[0]["reference_status"], "ready")
        self.assertFalse(join_result[0]["reference_refreshing"])

    def test_get_returns_exact_start_transition_even_when_worker_completes_inline(self):
        class InlineThread:
            def __init__(self, target, args, **kwargs):
                self.target = target
                self.args = args

            def start(self):
                self.target(*self.args)

        with firmware_reference._CACHE_LOCK:
            firmware_reference._REFERENCE_CACHE["vzm32sn"] = {
                "data": self._reference_data(version="1.00"),
                "status": "ready",
                "expires_at": 0,
                "last_attempt_at": 100,
                "last_error": None,
                "generation": 8,
            }
        with patch.object(firmware_reference, "_build_reference_data", return_value=self._reference_data()), \
             patch.object(firmware_reference.threading, "Thread", InlineThread):
            started = firmware_reference.get_vzm32sn_reference_data(force_refresh=True)

        completed = firmware_reference.get_vzm32sn_reference_data(allow_network=False)
        self.assertEqual(started["generation"], 9)
        self.assertEqual(started["reference_status"], "refreshing")
        self.assertTrue(started["reference_refreshing"])
        self.assertEqual(completed["generation"], 10)
        self.assertEqual(completed["reference_status"], "ready")
        self.assertFalse(completed["reference_refreshing"])

    def test_allow_network_false_is_memory_only(self):
        with patch.object(firmware_reference, "_start_vzm32sn_refresh") as start:
            result = firmware_reference.get_vzm32sn_reference_data(
                allow_network=False,
                force_refresh=True,
            )
        start.assert_not_called()
        self.assertEqual(result["reference_status"], "unavailable")

    def test_refresh_generation_increments_for_each_visible_attempt_state(self):
        good = self._reference_data()
        empty = {
            "entries": {}, "current_versions": {}, "sources": {},
            "source_data": {}, "fetched_at": 200.0,
        }
        with patch.object(firmware_reference, "_build_reference_data", side_effect=[good, good, empty]):
            one = firmware_reference.refresh_vzm32sn_reference_data(force_refresh=True)
            two = firmware_reference.refresh_vzm32sn_reference_data(force_refresh=True)
            failed = firmware_reference.refresh_vzm32sn_reference_data(force_refresh=True)
        self.assertEqual(one["generation"], 2)
        self.assertEqual(two["generation"], 4)
        self.assertEqual(failed["generation"], 6)
        self.assertEqual(failed["reference_status"], "stale")
        self.assertEqual(failed["current_versions"], good["current_versions"])

    def test_partial_refresh_retains_last_known_good_source(self):
        previous = self._reference_data(version="1.00")
        previous["source_data"]["inovelli_community"] = [
            firmware_reference._build_entry(16974080, display_version="1.00")
        ]
        with firmware_reference._CACHE_LOCK:
            firmware_reference._REFERENCE_CACHE["vzm32sn"] = {
                "data": previous,
                "status": "ready",
                "expires_at": 0,
                "last_attempt_at": 100,
                "last_error": None,
                "generation": 1,
            }
        with patch.object(firmware_reference, "_load_zigbee_ota_entries", return_value=[]), \
             patch.object(firmware_reference, "_load_inovelli_repo_entries", return_value=[]), \
             patch.object(firmware_reference, "_load_inovelli_help_versions", return_value={"Production": "1.01"}), \
             patch.object(firmware_reference, "_load_inovelli_community_entries", side_effect=RuntimeError("offline")):
            result = firmware_reference.refresh_vzm32sn_reference_data(force_refresh=True)
        self.assertEqual(result["reference_status"], "partial")
        self.assertEqual(result["sources"]["inovelli_community"]["status"], "stale")
        self.assertIn(16974080, result["entries"])
        self.assertEqual(result["generation"], 3)

    def test_persisted_cache_round_trip_and_corruption_are_failure_safe(self):
        data = self._reference_data()
        entry = {
            "data": data,
            "status": "ready",
            "expires_at": time.time() + 3600,
            "last_attempt_at": 100,
            "last_error": None,
            "generation": 7,
        }
        self.assertTrue(firmware_reference._persist_cache_entry(entry))
        with firmware_reference._CACHE_LOCK:
            firmware_reference._REFERENCE_CACHE.clear()
        self.assertTrue(firmware_reference.initialize_vzm32sn_reference_cache())
        loaded = firmware_reference.get_vzm32sn_reference_data(allow_network=False)
        self.assertEqual(loaded["generation"], 7)
        self.assertEqual(loaded["reference_status"], "ready")
        self.assertEqual(loaded["current_versions"]["Production"], "1.01")
        self.assertEqual(
            firmware_reference.resolve_vzm32sn_firmware_reference(
                16974081,
                allow_network=False,
                reference_data=loaded,
            )["match_kind"],
            "exact",
        )

        with open(self.cache_path, "w", encoding="utf-8") as handle:
            handle.write("{not json")
        with firmware_reference._CACHE_LOCK:
            firmware_reference._REFERENCE_CACHE.clear()
        self.assertFalse(firmware_reference.initialize_vzm32sn_reference_cache())
        self.assertEqual(
            firmware_reference.get_vzm32sn_reference_data(allow_network=False)["reference_status"],
            "unavailable",
        )

    def test_oversized_persisted_cache_is_rejected_without_json_parsing(self):
        with patch.object(firmware_reference, "MAX_PERSISTED_CACHE_BYTES", 8):
            with open(self.cache_path, "wb") as handle:
                handle.write(b"{" + (b"x" * 20))
            self.assertIsNone(firmware_reference._load_persisted_cache())

    def test_total_source_failure_retains_lkg_and_advances_state_generation(self):
        previous = self._reference_data(version="1.00")
        with firmware_reference._CACHE_LOCK:
            firmware_reference._REFERENCE_CACHE["vzm32sn"] = {
                "data": previous,
                "status": "ready",
                "expires_at": 0,
                "last_attempt_at": 100,
                "last_error": None,
                "generation": 4,
            }
        failure = RuntimeError("network unavailable")
        with patch.object(firmware_reference, "_load_zigbee_ota_entries", side_effect=failure), \
             patch.object(firmware_reference, "_load_inovelli_repo_entries", side_effect=failure), \
             patch.object(firmware_reference, "_load_inovelli_help_versions", side_effect=failure), \
             patch.object(firmware_reference, "_load_inovelli_community_entries", side_effect=failure):
            result = firmware_reference.refresh_vzm32sn_reference_data(force_refresh=True)
        self.assertEqual(result["reference_status"], "stale")
        self.assertTrue(result["reference_stale"])
        self.assertEqual(result["generation"], 6)
        self.assertEqual(result["current_versions"]["Production"], "1.00")
        self.assertEqual(result["sources"]["inovelli_help"]["status"], "stale")
        self.assertIn("network unavailable", result["sources"]["inovelli_help"]["error"])

    def test_empty_source_results_retain_each_last_known_good_contribution(self):
        previous = self._reference_data(version="1.00")
        previous["source_data"].update({
            "zigbee_ota_catalog": [firmware_reference._build_entry(16974080, display_version="1.00")],
            "inovelli_repo": [firmware_reference._build_entry(16974080, display_version="1.00")],
            "inovelli_community": [firmware_reference._build_entry(16974080, display_version="1.00")],
        })
        with firmware_reference._CACHE_LOCK:
            firmware_reference._REFERENCE_CACHE["vzm32sn"] = {
                "data": previous,
                "status": "ready",
                "expires_at": 0,
                "last_attempt_at": 100,
                "last_error": None,
                "generation": 2,
            }
        with patch.object(firmware_reference, "_load_zigbee_ota_entries", return_value=[]), \
             patch.object(firmware_reference, "_load_inovelli_repo_entries", return_value=[]), \
             patch.object(firmware_reference, "_load_inovelli_help_versions", return_value={}), \
             patch.object(firmware_reference, "_load_inovelli_community_entries", return_value=[]):
            result = firmware_reference.refresh_vzm32sn_reference_data(force_refresh=True)
        self.assertEqual(result["reference_status"], "stale")
        self.assertEqual(result["current_versions"]["Production"], "1.00")
        self.assertIn(16974080, result["entries"])
        self.assertTrue(all(
            health["status"] == "stale"
            for health in result["sources"].values()
        ))

    def test_http_read_is_bounded_and_ota_uses_range_header(self):
        class Response:
            headers = {}
            def __enter__(self): return self
            def __exit__(self, *args): return False
            def read(self, size): return b"x" * size

        with patch.object(firmware_reference.urllib.request, "urlopen", return_value=Response()), \
             patch.object(firmware_reference.urllib.request, "Request", wraps=firmware_reference.urllib.request.Request) as request:
            with self.assertRaisesRegex(ValueError, "exceeds 16 bytes"):
                firmware_reference._http_get_ota_header("https://example.test/image.ota")
        self.assertEqual(request.call_args.kwargs["headers"]["Range"], "bytes=0-15")

    def test_reference_item_counts_are_bounded(self):
        rows = [
            {"modelId": "VZM32-SN", "fileVersion": index, "fileName": f"VZM32-SN_{index}.01.ota"}
            for index in range(10)
        ]
        with patch.object(firmware_reference, "MAX_REFERENCE_ITEMS", 3), \
             patch.object(firmware_reference, "ZIGBEE_OTA_INDEX_URLS", ("one",)), \
             patch.object(firmware_reference, "_http_get_json", return_value=rows):
            result = firmware_reference._load_zigbee_ota_entries()
        self.assertEqual(len(result), 3)


if __name__ == "__main__":
    unittest.main()
