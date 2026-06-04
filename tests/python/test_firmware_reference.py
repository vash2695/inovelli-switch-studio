import unittest

from switch_studio import firmware_reference


class FirmwareReferenceTests(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
