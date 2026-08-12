import json
import math
import os
import re
import time
from copy import deepcopy
from decimal import Decimal, InvalidOperation


MAX_PARAMETER_NAME_LENGTH = 128
MAX_NUMERIC_LITERAL_LENGTH = 128
MAX_UNKNOWN_STRING_BYTES = 1024
MAX_JSON_NUMBER_MAGNITUDE = (2 ** 53) - 1
UNKNOWN_FIELD_NAME_PATTERN = re.compile(r"[A-Za-z_][A-Za-z0-9_.-]*\Z")
NUMERIC_LITERAL_PATTERN = re.compile(r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?\Z")


MMWAVE_PRESENCE_FIELDS = [
    "mmwaveControlWiredDevice",
    "mmWaveRoomSizePreset",
    "mmWaveHoldTime",
    "mmWaveDetectSensitivity",
    "mmWaveDetectTrigger",
    "mmWaveTargetInfoReport",
    "mmWaveStayLife",
    "mmWaveVersion",
]


class SchemaService:
    def __init__(self, definition_paths=None):
        self.definition_paths = definition_paths or []
        self.definition_path = None
        self.definition_error = None
        self.schema = None
        self.field_map = {}
        self.reload()

    def reload(self):
        model_definition = self._load_definition()
        if model_definition:
            self.schema = self._build_schema(model_definition)
        else:
            self.schema = self._fallback_schema()
        combined_fields = list(self.schema.get("fields", [])) + list(self.schema.get("options", []))
        self.field_map = {field["name"]: field for field in combined_fields if field.get("name")}
        return self.schema

    def get_schema(self):
        return deepcopy(self.schema)

    def validate_update(self, param, value):
        if type(param) is not str:
            return False, "Parameter name must be a string", None, False
        if not param or len(param) > MAX_PARAMETER_NAME_LENGTH:
            return False, f"Parameter name must contain 1-{MAX_PARAMETER_NAME_LENGTH} characters", None, False

        field = self.field_map.get(param)
        if not field:
            # Unknown top-level fields are an intentional, bounded escape hatch for
            # newer firmware/Zigbee2MQTT mappings. Structured values must first be
            # represented in a known schema so their children can be validated.
            if not UNKNOWN_FIELD_NAME_PATTERN.fullmatch(param):
                return False, f"Unknown field name '{param}' is not allowed", None, True
            normalized, error = self._normalize_unknown_scalar(param, value)
            if error:
                return False, error, None, True
            return True, None, normalized, True

        if not field.get("can_write", False):
            return False, f"Field '{param}' is read-only", None, False

        normalized, error = self._normalize_value(field, value)
        if error:
            return False, error, None, False
        return True, None, normalized, False

    def _load_definition(self):
        for path in self.definition_paths:
            if not path:
                continue
            normalized_path = os.path.abspath(path)
            if not os.path.exists(normalized_path):
                continue
            try:
                with open(normalized_path, encoding="utf-8") as f:
                    definition = json.load(f)
                self.definition_path = normalized_path
                self.definition_error = None
                return definition
            except Exception as load_error:
                self.definition_error = str(load_error)
        return None

    def _build_schema(self, model_definition):
        exposes = model_definition.get("exposes", []) or []
        options = model_definition.get("options", []) or []

        fields = [self._normalize_field(entry, "exposes") for entry in exposes if isinstance(entry, dict)]
        options_fields = [self._normalize_field(entry, "options") for entry in options if isinstance(entry, dict)]

        return {
            "source": "zigbee2mqtt_definition",
            "source_path": self.definition_path,
            "model": model_definition.get("model"),
            "vendor": model_definition.get("vendor"),
            "generated_at": time.time(),
            "field_count": len(fields),
            "option_count": len(options_fields),
            "fields": fields,
            "options": options_fields,
            "mmwave_presence_fields": list(MMWAVE_PRESENCE_FIELDS),
        }

    def _normalize_field(self, entry, source):
        name = entry.get("name")
        access = int(entry.get("access", 0) or 0)
        normalized_features = [self._normalize_feature(feature) for feature in (entry.get("features") or []) if isinstance(feature, dict)]

        return {
            "name": name,
            "property": entry.get("property"),
            "label": entry.get("label") or name or "Unknown",
            "description": entry.get("description", ""),
            "type": entry.get("type"),
            "category": entry.get("category") or "none",
            "source": source,
            "access": access,
            "can_state": bool(access & 1),
            "can_get": bool(access & 4),
            "can_read": bool(access & 1 or access & 4),
            "can_write": bool(access & 2),
            "value_min": entry.get("value_min"),
            "value_max": entry.get("value_max"),
            "value_step": entry.get("value_step"),
            "unit": entry.get("unit"),
            "values": entry.get("values", []),
            "value_on": entry.get("value_on"),
            "value_off": entry.get("value_off"),
            "presets": entry.get("presets", []),
            "item_type": self._normalize_feature(entry.get("item_type")) if isinstance(entry.get("item_type"), dict) else None,
            "features": normalized_features,
            "tab": self._infer_tab(name, entry),
            "section": self._infer_section(name, entry),
        }

    def _normalize_feature(self, feature):
        access = int(feature.get("access", 0) or 0)
        normalized_children = [self._normalize_feature(child) for child in (feature.get("features") or []) if isinstance(child, dict)]

        return {
            "name": feature.get("name"),
            "property": feature.get("property"),
            "label": feature.get("label") or feature.get("name") or "Unknown",
            "description": feature.get("description", ""),
            "type": feature.get("type"),
            "access": access,
            "can_state": bool(access & 1),
            "can_get": bool(access & 4),
            "can_read": bool(access & 1 or access & 4),
            "can_write": bool(access & 2),
            "value_min": feature.get("value_min"),
            "value_max": feature.get("value_max"),
            "value_step": feature.get("value_step"),
            "unit": feature.get("unit"),
            "values": feature.get("values", []),
            "value_on": feature.get("value_on"),
            "value_off": feature.get("value_off"),
            "item_type": self._normalize_feature(feature.get("item_type")) if isinstance(feature.get("item_type"), dict) else None,
            "features": normalized_children,
        }

    def _fallback_schema(self):
        fields = [
            {
                "name": "mmwaveControlWiredDevice",
                "property": "mmwaveControlWiredDevice",
                "label": "Wired Device Control",
                "description": "Controls automatic on/off behavior using presence.",
                "type": "enum",
                "category": "config",
                "source": "fallback",
                "access": 7,
                "can_read": True,
                "can_write": True,
                "value_min": None,
                "value_max": None,
                "value_step": None,
                "unit": None,
                "values": [
                    "Disabled",
                    "Occupancy (default)",
                    "Vacancy",
                    "Wasteful Occupancy",
                    "Mirrored Occupancy",
                    "Mirrored Vacancy",
                    "Mirrored Wasteful Occupancy",
                ],
                "presets": [],
                "item_type": None,
                "features": [],
                "tab": "Presence",
                "section": "Presence Controls",
            },
            {
                "name": "mmWaveRoomSizePreset",
                "property": "mmWaveRoomSizePreset",
                "label": "Room Preset",
                "description": "Predefined room dimensions for mmWave processing.",
                "type": "enum",
                "category": "config",
                "source": "fallback",
                "access": 7,
                "can_read": True,
                "can_write": True,
                "value_min": None,
                "value_max": None,
                "value_step": None,
                "unit": None,
                "values": ["Custom", "Small", "Medium", "Large"],
                "presets": [],
                "item_type": None,
                "features": [],
                "tab": "Presence",
                "section": "Presence Controls",
            },
            {
                "name": "mmWaveDetectSensitivity",
                "property": "mmWaveDetectSensitivity",
                "label": "Sensitivity",
                "description": "The sensitivity of the mmWave sensor.",
                "type": "enum",
                "category": "config",
                "source": "fallback",
                "access": 7,
                "can_read": True,
                "can_write": True,
                "value_min": None,
                "value_max": None,
                "value_step": None,
                "unit": None,
                "values": ["Low", "Medium", "High (default)"],
                "presets": [],
                "item_type": None,
                "features": [],
                "tab": "Presence",
                "section": "Presence Controls",
            },
            {
                "name": "mmWaveDetectTrigger",
                "property": "mmWaveDetectTrigger",
                "label": "Trigger Speed",
                "description": "The time from detecting a person to triggering an action.",
                "type": "enum",
                "category": "config",
                "source": "fallback",
                "access": 7,
                "can_read": True,
                "can_write": True,
                "value_min": None,
                "value_max": None,
                "value_step": None,
                "unit": None,
                "values": ["Slow (5s)", "Medium (1s)", "Fast (0.2s, default)"],
                "presets": [],
                "item_type": None,
                "features": [],
                "tab": "Presence",
                "section": "Presence Controls",
            },
            {
                "name": "mmWaveHoldTime",
                "property": "mmWaveHoldTime",
                "label": "Hold Time",
                "description": "Duration in seconds to hold occupancy after motion stops.",
                "type": "numeric",
                "category": "config",
                "source": "fallback",
                "access": 7,
                "can_read": True,
                "can_write": True,
                "value_min": 0,
                "value_max": 4294967295,
                "value_step": 1,
                "unit": "s",
                "values": [],
                "presets": [],
                "item_type": None,
                "features": [],
                "tab": "Presence",
                "section": "Presence Controls",
            },
            {
                "name": "mmWaveStayLife",
                "property": "mmWaveStayLife",
                "label": "Stay Life",
                "description": "Stationary-presence timing parameter.",
                "type": "numeric",
                "category": "config",
                "source": "fallback",
                "access": 7,
                "can_read": True,
                "can_write": True,
                "value_min": 0,
                "value_max": 4294967295,
                "value_step": 1,
                "unit": None,
                "values": [],
                "presets": [],
                "item_type": None,
                "features": [],
                "tab": "Presence",
                "section": "Presence Controls",
            },
            {
                "name": "mmWaveTargetInfoReport",
                "property": "mmWaveTargetInfoReport",
                "label": "Target Reporting",
                "description": "Enable raw target report stream when cluster binding is configured.",
                "type": "enum",
                "category": "config",
                "source": "fallback",
                "access": 7,
                "can_read": True,
                "can_write": True,
                "value_min": None,
                "value_max": None,
                "value_step": None,
                "unit": None,
                "values": ["Disable (default)", "Enable"],
                "presets": [],
                "item_type": None,
                "features": [],
                "tab": "Presence",
                "section": "Presence Controls",
            },
            {
                "name": "mmWaveVersion",
                "property": "mmWaveVersion",
                "label": "mmWave Version",
                "description": "Firmware version of the mmWave module.",
                "type": "numeric",
                "category": "none",
                "source": "fallback",
                "access": 5,
                "can_read": True,
                "can_write": False,
                "value_min": 0,
                "value_max": 4294967295,
                "value_step": 1,
                "unit": None,
                "values": [],
                "presets": [],
                "item_type": None,
                "features": [],
                "tab": "Presence",
                "section": "Presence Diagnostics",
            },
        ]
        for field in fields:
            access = int(field.get("access", 0) or 0)
            field["can_state"] = bool(access & 1)
            field["can_get"] = bool(access & 4)
        return {
            "source": "fallback",
            "source_path": None,
            "model": "VZM32-SN",
            "vendor": "Inovelli",
            "generated_at": time.time(),
            "field_count": len(fields),
            "option_count": 0,
            "fields": fields,
            "options": [],
            "mmwave_presence_fields": list(MMWAVE_PRESENCE_FIELDS),
        }

    def _infer_tab(self, name, entry):
        if not name:
            return "Advanced"

        lname = name.lower()
        entry_category = (entry.get("category") or "").lower()

        if "mmwave" in lname:
            if lname.endswith("_areas") or lname == "mmwave_control_commands":
                return "Zones"
            if lname.endswith("occupancy") or name in {"occupancy", "illuminance"}:
                return "Live"
            return "Presence"

        if lname in {"occupancy", "illuminance", "power", "voltage", "current", "energy", "action", "linkquality"}:
            return "Live"
        if lname in {"area1occupancy", "area2occupancy", "area3occupancy", "area4occupancy"}:
            return "Live"

        load_dimming_keywords = [
            "dimming", "ramprate", "defaultlevel", "minimumlevel", "maximumlevel",
            "outputmode", "quickstart", "autotimeroff", "stateafterpowerrestored",
            "loadlevelindicatortimeout", "switchtype", "invertswitch", "smartbulbmode",
            "bindingofftoonsynclevel", "higheroutputinnonneutral"
        ]
        if any(key in lname for key in load_dimming_keywords):
            return "Load & Dimming"

        if "led" in lname or "notification" in lname or lname in {"led_effect", "individual_led_effect", "firmwareupdateinprogressindicator"}:
            return "LED & Notifications"

        if any(key in lname for key in ["tap", "button", "scene", "aux", "multitap", "doubletap", "singletap", "held", "delay"]):
            return "Buttons & Scenes"

        power_device_names = {
            "identify", "energy_reset", "otaimagetype", "localprotection", "remoteprotection",
            "powertype", "internaltemperature", "overheat", "devicebindnumber",
            "activepowerreports", "periodicpowerandenergyreports", "activeenergyreports",
            "fancontrolmode", "fantimermode", "lowlevelforfancontrolmode", "mediumlevelforfancontrolmode",
            "highlevelforfancontrolmode"
        }
        if lname in power_device_names:
            return "Power & Device"
        if any(key in lname for key in ["calibration", "precision", "transition", "identify_timeout", "state_action", "illuminance_raw", "no_occupancy_since"]):
            return "Power & Device"

        if entry_category == "diagnostic":
            return "Live"

        return "Advanced"

    def _infer_section(self, name, entry):
        tab = self._infer_tab(name, entry)
        lname = (name or "").lower()
        entry_category = (entry.get("category") or "").lower()

        if tab == "Presence":
            if name == "mmWaveVersion":
                return "Presence Diagnostics"
            return "Presence Controls"
        if tab == "Zones":
            return "Zone Definitions"
        if tab == "Live":
            if lname in {"action", "linkquality"}:
                return "Live Diagnostics"
            return "Live Sensors"
        if tab == "Load & Dimming":
            return "Load Behavior & Dimming"
        if tab == "LED & Notifications":
            return "LED Effects & Notifications"
        if tab == "Buttons & Scenes":
            return "Buttons & Scene Behavior"
        if tab == "Power & Device":
            if lname in {"identify", "energy_reset"}:
                return "Device Actions"
            if entry_category == "diagnostic" or lname in {"internaltemperature", "overheat", "devicebindnumber", "linkquality", "action"}:
                return "Diagnostics"
            if any(key in lname for key in ["calibration", "precision", "transition", "identify_timeout", "state_action", "illuminance_raw", "no_occupancy_since"]):
                return "Runtime Options"
            return "Power & Device Settings"
        return "Advanced"

    def _normalize_unknown_scalar(self, param, value):
        if value is None or isinstance(value, bool):
            return value, None

        if isinstance(value, str):
            try:
                byte_length = len(value.encode("utf-8"))
            except UnicodeEncodeError:
                return None, f"Unknown field '{param}' requires a valid UTF-8 string"
            if byte_length > MAX_UNKNOWN_STRING_BYTES:
                return None, (
                    f"Unknown field '{param}' string exceeds "
                    f"{MAX_UNKNOWN_STRING_BYTES} UTF-8 bytes"
                )
            return value, None

        if isinstance(value, int):
            if abs(value) > MAX_JSON_NUMBER_MAGNITUDE:
                return None, (
                    f"Unknown field '{param}' number exceeds the interoperable JSON limit "
                    f"{MAX_JSON_NUMBER_MAGNITUDE}"
                )
            return value, None

        if isinstance(value, float):
            if not math.isfinite(value):
                return None, f"Unknown field '{param}' requires a finite number"
            if abs(value) > MAX_JSON_NUMBER_MAGNITUDE:
                return None, (
                    f"Unknown field '{param}' number exceeds the interoperable JSON limit "
                    f"{MAX_JSON_NUMBER_MAGNITUDE}"
                )
            return value, None

        return None, (
            f"Unknown field '{param}' accepts only a JSON scalar "
            "(string, number, boolean, or null)"
        )

    def _normalize_value(self, field, value, path=None):
        field_path = path or field.get("property") or field.get("name") or "unknown"
        field_type = field.get("type")
        if field_type == "numeric":
            return self._normalize_numeric(field, value, field_path)
        if field_type == "enum":
            return self._normalize_enum(field, value, field_path)
        if field_type == "binary":
            return self._normalize_binary(field, value, field_path)
        if field_type == "composite":
            if field.get("name") in {"led_effect", "individual_led_effect"}:
                return self._normalize_led_effect(field, value, field_path)
            return self._normalize_composite(field, value, field_path)
        if field_type == "list":
            return self._normalize_list(field, value, field_path)
        return None, f"Field '{field_path}' has unsupported schema type '{field_type}'"

    def _normalize_led_effect(self, field, value, path):
        required = ["effect", "color", "level", "duration"]
        if field.get("name") == "individual_led_effect":
            required.insert(0, "led")
        return self._normalize_composite(field, value, path, required_features=required)

    def _normalize_composite(self, field, value, path, required_features=None):
        if not isinstance(value, dict):
            return None, f"Field '{path}' requires an object"

        features = [feature for feature in (field.get("features") or []) if isinstance(feature, dict)]
        if not features:
            return None, f"Field '{path}' has no child schema"

        aliases = {}
        canonical_keys = {}
        features_by_name = {}
        for feature in features:
            name = feature.get("name")
            property_name = feature.get("property")
            canonical = property_name or name
            if not isinstance(canonical, str) or not canonical:
                return None, f"Field '{path}' contains an unnamed child schema"
            canonical_keys[id(feature)] = canonical
            if isinstance(name, str) and name:
                features_by_name[name] = feature
            for alias in {name, property_name}:
                if not isinstance(alias, str) or not alias:
                    continue
                previous = aliases.get(alias)
                if previous is not None and previous is not feature:
                    return None, f"Field '{path}' schema has duplicate child key '{alias}'"
                aliases[alias] = feature

        supplied = []
        unexpected = []
        seen_features = set()
        for key, child_value in value.items():
            feature = aliases.get(key) if isinstance(key, str) else None
            if feature is None:
                unexpected.append(key if isinstance(key, str) else repr(key))
                continue
            feature_id = id(feature)
            if feature_id in seen_features:
                return None, (
                    f"Field '{path}' supplies multiple aliases for "
                    f"'{canonical_keys[feature_id]}'"
                )
            seen_features.add(feature_id)
            supplied.append((feature, child_value))

        if unexpected:
            return None, f"Field '{path}' has unexpected keys: {', '.join(unexpected)}"

        if required_features:
            missing = []
            for required_name in required_features:
                feature = features_by_name.get(required_name)
                if feature is None:
                    return None, f"Field '{path}' schema is missing feature '{required_name}'"
                if id(feature) not in seen_features:
                    missing.append(required_name)
            if missing:
                return None, f"Field '{path}' is missing {', '.join(missing)}"
        elif not supplied:
            return None, f"Field '{path}' requires at least one child value"

        normalized = {}
        for feature, child_value in supplied:
            canonical = canonical_keys[id(feature)]
            child_path = f"{path}.{canonical}"
            # Composite access describes the container in Zigbee2MQTT. Some zone
            # containers are state-only while their declared leaf coordinates are
            # writable, so access is enforced at the supplied leaves instead.
            if feature.get("type") != "composite" and not feature.get("can_write", False):
                return None, f"Field '{child_path}' is read-only"
            normalized_value, error = self._normalize_value(feature, child_value, child_path)
            if error:
                return None, error
            normalized[canonical] = normalized_value
        return normalized, None

    def _normalize_list(self, field, value, path):
        if not isinstance(value, list):
            return None, f"Field '{path}' requires an array"

        item_type = field.get("item_type")
        if not isinstance(item_type, dict):
            return None, f"Field '{path}' has no item schema"
        if not item_type.get("can_write", False):
            return None, f"Field '{path}' item schema is read-only"

        normalized = []
        for index, item in enumerate(value):
            normalized_item, error = self._normalize_value(item_type, item, f"{path}[{index}]")
            if error:
                return None, error
            normalized.append(normalized_item)
        return normalized, None

    def _normalize_numeric(self, field, value, path):
        if isinstance(value, bool) or not isinstance(value, (str, int, float, Decimal)):
            return None, f"Field '{path}' requires a numeric value"

        try:
            numeric_text = value.strip() if isinstance(value, str) else str(value)
            if (
                not numeric_text
                or len(numeric_text) > MAX_NUMERIC_LITERAL_LENGTH
                or not NUMERIC_LITERAL_PATTERN.fullmatch(numeric_text)
            ):
                raise InvalidOperation
            numeric_value = Decimal(numeric_text)
        except (InvalidOperation, ValueError):
            return None, f"Field '{path}' requires a numeric value"

        if not numeric_value.is_finite():
            return None, f"Field '{path}' requires a finite numeric value"
        if numeric_value.copy_abs() > Decimal(MAX_JSON_NUMBER_MAGNITUDE):
            return None, (
                f"Field '{path}' exceeds the interoperable JSON limit "
                f"{MAX_JSON_NUMBER_MAGNITUDE}"
            )

        min_value = field.get("value_min")
        max_value = field.get("value_max")
        step_value = field.get("value_step")

        try:
            min_decimal = Decimal(str(min_value)) if min_value is not None else None
            max_decimal = Decimal(str(max_value)) if max_value is not None else None
            step_decimal = Decimal(str(step_value)) if step_value is not None else None
        except InvalidOperation:
            return None, f"Field '{path}' has invalid numeric schema constraints"

        schema_numbers = (number for number in (min_decimal, max_decimal, step_decimal) if number is not None)
        if any(not number.is_finite() for number in schema_numbers):
            return None, f"Field '{path}' has invalid numeric schema constraints"
        if step_decimal is not None and step_decimal <= 0:
            return None, f"Field '{path}' has invalid numeric step {step_value}"

        if min_decimal is not None and numeric_value < min_decimal:
            return None, f"Field '{path}' is below min {min_value}"
        if max_decimal is not None and numeric_value > max_decimal:
            return None, f"Field '{path}' is above max {max_value}"

        integer_semantics = step_decimal is None or step_decimal == step_decimal.to_integral_value()
        if integer_semantics and numeric_value != numeric_value.to_integral_value():
            return None, f"Field '{path}' requires a whole number"

        if step_decimal is not None:
            base = min_decimal if min_decimal is not None else Decimal(0)
            try:
                step_remainder = (numeric_value - base) % step_decimal
            except InvalidOperation:
                return None, f"Field '{path}' value is not aligned to step {step_value}"
            if step_remainder != 0:
                return None, f"Field '{path}' value is not aligned to step {step_value}"

        if integer_semantics:
            return int(numeric_value), None

        normalized = float(numeric_value)
        if not math.isfinite(normalized):
            return None, f"Field '{path}' requires a finite representable numeric value"
        return normalized, None

    def _normalize_enum(self, field, value, path):
        values = field.get("values") or []
        if not isinstance(value, str):
            return None, f"Field '{path}' requires an enum string"
        if values and value not in values:
            return None, f"Field '{path}' value '{value}' is not allowed"
        return value, None

    def _normalize_binary(self, field, value, path):
        if isinstance(value, bool):
            return value, None

        value_on = field.get("value_on", True)
        value_off = field.get("value_off", False)

        if isinstance(value, str):
            lowered = value.strip().lower()
            if lowered in {"true", "1", "on", "yes"}:
                return value_on if isinstance(value_on, bool) else True, None
            if lowered in {"false", "0", "off", "no"}:
                return value_off if isinstance(value_off, bool) else False, None

        if value == value_on:
            return value, None
        if value == value_off:
            return value, None

        return None, f"Field '{path}' requires a binary value"
