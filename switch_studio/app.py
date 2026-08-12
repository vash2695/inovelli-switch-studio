"""
Inovelli Switch Studio Backend
Provides a real-time MQTT-to-WebSocket bridge for Home Assistant Ingress.
Handles device discovery, Zigbee byte array decoding, and two-way configuration.
"""

import json
import os
import traceback
import time
import threading 
import copy
import hashlib
import ipaddress
import math
import re
import urllib.parse
from flask import Flask, render_template, request
from flask_socketio import SocketIO
import paho.mqtt.client as mqtt
import logging
try:
    from .schema_service import SchemaService
    from .firmware_reference import (
        get_vzm32sn_reference_data,
        refresh_vzm32sn_reference_data,
        resolve_vzm32sn_firmware_reference,
    )
except ImportError:
    from schema_service import SchemaService
    from firmware_reference import (
        get_vzm32sn_reference_data,
        refresh_vzm32sn_reference_data,
        resolve_vzm32sn_firmware_reference,
    )

# Suppress the Werkzeug development server warning
log = logging.getLogger('werkzeug')
log.setLevel(logging.ERROR)

# --- LOAD HOME ASSISTANT CONFIGURATION ---
CONFIG_PATH = '/data/options.json'
MQTT_CONNACK_REASON = {
    0: "Connection accepted",
    1: "Unacceptable protocol version",
    2: "Identifier rejected",
    3: "Server unavailable",
    4: "Bad username or password",
    5: "Not authorized",
}
TEST_MODE = str(os.environ.get("SWITCH_STUDIO_TEST_MODE", "")).strip().lower() in {"1", "true", "yes", "on"}
FIRMWARE_PROCESS_EPOCH = f"{os.getpid()}-{time.time_ns()}"
SUPERVISOR_INGRESS_IP = ipaddress.ip_address('172.30.32.2')
TRUSTED_INGRESS_PEERS = {str(SUPERVISOR_INGRESS_IP)}
ALLOW_LOCAL_DIRECT = TEST_MODE or str(
    os.environ.get('SWITCH_STUDIO_ALLOW_LOCAL_DIRECT', '')
).strip().lower() in {'1', 'true', 'yes', 'on'}


def _config_first(config_obj, keys, default_value):
    for key in keys:
        if key in config_obj and config_obj.get(key) is not None:
            return config_obj.get(key)
    return default_value


def _file_sha256_prefix(path, length=12):
    try:
        with open(path, "rb") as f:
            digest = hashlib.sha256(f.read()).hexdigest()
        return digest[:length]
    except Exception:
        return "unavailable"


def _as_int_or_none(value):
    if value is None:
        return None
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, (int, float)):
        return int(value)
    if isinstance(value, str):
        stripped = value.strip()
        if stripped == "":
            return None
        try:
            return int(stripped)
        except ValueError:
            try:
                return int(float(stripped))
            except ValueError:
                return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _as_number_or_none(value):
    if value is None or isinstance(value, bool):
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    if parsed != parsed or parsed in {float('inf'), float('-inf')}:
        return None
    return int(parsed) if parsed.is_integer() else parsed


def _as_bool(value, default=False):
    if value is None:
        return bool(default)
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"1", "true", "yes", "on"}:
            return True
        if lowered in {"0", "false", "no", "off"}:
            return False
    return bool(default)


def normalize_peer_address(value):
    """Return the actual socket peer as an IP address without trusting proxy headers."""
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        peer = ipaddress.ip_address(value.strip())
    except ValueError:
        return None
    if isinstance(peer, ipaddress.IPv6Address) and peer.ipv4_mapped is not None:
        return peer.ipv4_mapped
    return peer


def is_trusted_ingress_peer(remote_addr, test_mode=None):
    """Accept only Home Assistant's ingress proxy, plus loopback for explicit local QA."""
    peer = normalize_peer_address(remote_addr)
    if peer is None:
        return False
    allow_loopback = ALLOW_LOCAL_DIRECT if test_mode is None else bool(test_mode)
    return peer == SUPERVISOR_INGRESS_IP or (allow_loopback and peer.is_loopback)


def _normalized_origin(value):
    if not isinstance(value, str) or not value.strip():
        return None
    normalized_value = value.strip()
    if ',' in normalized_value:
        return None
    try:
        parsed = urllib.parse.urlsplit(normalized_value)
    except ValueError:
        return None
    if parsed.scheme.lower() not in {'http', 'https'} or not parsed.netloc:
        return None
    if parsed.username or parsed.password or parsed.path not in {'', '/'} or parsed.query or parsed.fragment:
        return None
    hostname = parsed.hostname
    if not hostname:
        return None
    try:
        port = parsed.port
    except ValueError:
        return None
    scheme = parsed.scheme.lower()
    if (scheme == 'http' and port == 80) or (scheme == 'https' and port == 443):
        port = None
    normalized_host = hostname.lower()
    if ':' in normalized_host:
        normalized_host = f'[{normalized_host}]'
    port_suffix = f':{port}' if port is not None else ''
    return f'{scheme}://{normalized_host}{port_suffix}'


def is_allowed_socket_origin(origin, environ=None):
    """Apply same-origin checks using Host data supplied by the trusted ingress peer."""
    if origin is None or (isinstance(origin, str) and not origin.strip()):
        return True
    request_environ = environ if isinstance(environ, dict) else {}
    host = str(request_environ.get('HTTP_HOST') or '').strip()
    scheme = str(request_environ.get('wsgi.url_scheme') or 'http').strip().lower()
    forwarded_host = str(request_environ.get('HTTP_X_FORWARDED_HOST') or '').split(',')[0].strip()
    forwarded_proto = str(request_environ.get('HTTP_X_FORWARDED_PROTO') or scheme).split(',')[0].strip().lower()
    effective_origin = (
        _normalized_origin(f"{forwarded_proto}://{forwarded_host}")
        if forwarded_host else
        (_normalized_origin(f"{scheme}://{host}") if host else None)
    )
    return effective_origin is not None and _normalized_origin(origin) == effective_origin


class TrustedIngressMiddleware:
    """Reject non-ingress peers before Flask or Engine.IO allocates request state."""

    def __init__(self, wsgi_app):
        self.wsgi_app = wsgi_app

    def __call__(self, environ, start_response):
        if is_trusted_ingress_peer(environ.get('REMOTE_ADDR')):
            return self.wsgi_app(environ, start_response)
        body = b'Forbidden: use Home Assistant Ingress'
        start_response(
            '403 Forbidden',
            [
                ('Content-Type', 'text/plain; charset=utf-8'),
                ('Content-Length', str(len(body))),
                ('Cache-Control', 'no-store'),
            ],
        )
        return [body]


def _normalize_basic_state(value):
    if isinstance(value, bool):
        return 'ON' if value else 'OFF', None

    if isinstance(value, (int, float)):
        return ('ON' if int(value) != 0 else 'OFF'), None

    if isinstance(value, str):
        normalized = value.strip().upper()
        if normalized in {'ON', 'OFF'}:
            return normalized, None
        if normalized in {'TRUE', 'YES', '1'}:
            return 'ON', None
        if normalized in {'FALSE', 'NO', '0'}:
            return 'OFF', None

    return None, "State must be ON, OFF, or a boolean"


def _normalize_basic_brightness(value):
    parsed = _as_int_or_none(value)
    if parsed is None:
        return None, "Brightness must be a numeric value from 0 to 254"

    if parsed < 0:
        parsed = 0
    if parsed > 254:
        parsed = 254
    return parsed, None


def _values_equal(expected, observed):
    if isinstance(expected, bool) or isinstance(observed, bool):
        def as_bool_like(value):
            if isinstance(value, bool):
                return value
            if isinstance(value, (int, float)) and value in {0, 1}:
                return bool(value)
            normalized = str(value).strip().lower()
            if normalized in {'true', 'on', 'yes', '1'}:
                return True
            if normalized in {'false', 'off', 'no', '0'}:
                return False
            return None

        expected_bool = as_bool_like(expected)
        observed_bool = as_bool_like(observed)
        if expected_bool is not None and observed_bool is not None:
            return expected_bool is observed_bool
        return False

    if isinstance(expected, (int, float)) or isinstance(observed, (int, float)):
        try:
            return float(expected) == float(observed)
        except (TypeError, ValueError):
            pass

    if isinstance(expected, dict) or isinstance(observed, dict):
        if not isinstance(expected, dict) or not isinstance(observed, dict):
            return False
        return all(
            key in observed and _values_equal(value, observed.get(key))
            for key, value in expected.items()
        )

    if isinstance(expected, list) or isinstance(observed, list):
        if not isinstance(expected, list) or not isinstance(observed, list):
            return False
        return len(expected) == len(observed) and all(
            _values_equal(expected_value, observed_value)
            for expected_value, observed_value in zip(expected, observed)
        )

    return str(expected) == str(observed)

try:
    with open(CONFIG_PATH) as f:
        config = json.load(f)
        MQTT_BROKER = _config_first(config, ['mqtt_broker', 'broker', 'host'], 'core-mosquitto')
        MQTT_PORT = int(_config_first(config, ['mqtt_port', 'port'], 1883))
        MQTT_USERNAME = str(_config_first(config, ['mqtt_username', 'mqtt_user', 'username'], '') or '')
        MQTT_PASSWORD = str(_config_first(config, ['mqtt_password', 'mqtt_pass', 'password'], '') or '')
        MQTT_BASE_TOPIC = str(_config_first(config, ['mqtt_base_topic', 'base_topic'], 'zigbee2mqtt') or 'zigbee2mqtt')
        SWITCH_STUDIO_UI = _as_bool(_config_first(config, ['switch_studio_ui'], True), True)
except FileNotFoundError:
    print("No options.json found. Using defaults.", flush=True)
    MQTT_BROKER = 'core-mosquitto'
    MQTT_PORT = 1883
    MQTT_USERNAME = ''
    MQTT_PASSWORD = ''
    MQTT_BASE_TOPIC = 'zigbee2mqtt'
    SWITCH_STUDIO_UI = True

APP_DIR = os.path.dirname(os.path.abspath(__file__))
SCHEMA_DEFINITION_PATHS = [
    os.path.join(APP_DIR, 'zigbee2mqtt_definition.md'),
    os.path.join(APP_DIR, 'zigbee2mqtt_definition.json'),
    os.path.join(os.path.dirname(APP_DIR), 'zigbee2mqtt_definition.md'),
    '/app/zigbee2mqtt_definition.md',
]
schema_service = SchemaService(definition_paths=SCHEMA_DEFINITION_PATHS)
print(
    f"Schema loaded: source={schema_service.schema.get('source')} path={schema_service.schema.get('source_path')}",
    flush=True
)
print(
    f"MQTT config: broker={MQTT_BROKER} port={MQTT_PORT} base_topic={MQTT_BASE_TOPIC} "
    f"username_set={'yes' if MQTT_USERNAME else 'no'} password_set={'yes' if MQTT_PASSWORD else 'no'} "
    f"switch_studio_ui={'enabled' if SWITCH_STUDIO_UI else 'disabled'}",
    flush=True
)
template_path = os.path.join(APP_DIR, 'templates', 'index.html')
template_fingerprint = _file_sha256_prefix(template_path)
template_tabs_enabled = False
try:
    with open(template_path, encoding='utf-8') as f:
        template_tabs_enabled = 'data-tab-target="load"' in f.read()
except Exception:
    template_tabs_enabled = False
print(
    f"UI template fingerprint: {template_fingerprint} tabs_enabled={'yes' if template_tabs_enabled else 'no'}",
    flush=True
)
if ALLOW_LOCAL_DIRECT and not TEST_MODE:
    print(
        'WARNING: SWITCH_STUDIO_ALLOW_LOCAL_DIRECT is enabled; loopback access is intended only for local QA.',
        flush=True,
    )

app = Flask(__name__)
socketio = SocketIO(app, cors_allowed_origins=is_allowed_socket_origin, async_mode='threading')
app.wsgi_app = TrustedIngressMiddleware(app.wsgi_app)


@app.before_request
def require_trusted_ingress_peer():
    if is_trusted_ingress_peer(request.remote_addr):
        return None
    return (
        'Forbidden: use Home Assistant Ingress',
        403,
        {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store',
        },
    )

# Stores device names, topics, config, and throttling timers
device_list = {}
device_list_lock = threading.Lock()
# Retained availability messages can arrive before Zigbee2MQTT's retained
# bridge/devices inventory. Keep the latest exact-topic value so inventory
# creation is independent of MQTT delivery order.
device_availability_cache = {}

# Stores per-socket selected MQTT topic to avoid cross-session command routing
session_topics = {}
session_topics_lock = threading.Lock()
# Stores per-socket preference for auto-disabling target reporting on disconnect
session_reporting_auto_off = {}
session_reporting_auto_off_lock = threading.Lock()

# Tracks writes until Zigbee2MQTT echoes the requested values on the device topic.
pending_writes = {}
pending_writes_lock = threading.Lock()
PENDING_WRITE_TIMEOUT_SECONDS = 10.0
MAX_PENDING_WRITES_PER_SID = 16
MAX_PENDING_WRITES_GLOBAL = 256

# Firmware state reported by Zigbee2MQTT and public firmware-reference metadata
# are intentionally separate domains. Reference refreshes run in one background
# worker and may never replace the device's live OTA record.
firmware_reference_refresh_lock = threading.Lock()
firmware_reference_refresh_active = False
firmware_reference_refresh_thread = None

# Socket.IO command envelopes are intentionally small. Bound them before they
# reach schema validation, pending-write tracking, or MQTT serialization so a
# connected browser cannot grow memory/thread usage without limit.
MAX_REQUEST_ID_LENGTH = 128
MAX_PARAMETER_NAME_LENGTH = 128
MAX_CHANGE_COUNT = 128
MAX_VALUE_DEPTH = 8
MAX_CONTAINER_ITEMS = 128
MAX_STRING_LENGTH = 4096
MAX_COMMAND_PAYLOAD_BYTES = 65536
REQUEST_ID_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\Z")

# MQTT-producing browser commands use atomic per-session and global token
# buckets. Pending-write caps bound retained work; these buckets additionally
# bound rapid confirmed writes and commands that do not await device echoes.
COMMAND_RATE_CAPACITY_PER_SID = 12.0
COMMAND_RATE_REFILL_PER_SECOND = 4.0
COMMAND_RATE_GLOBAL_CAPACITY = 60.0
COMMAND_RATE_GLOBAL_REFILL_PER_SECOND = 20.0
MAX_COMMAND_RATE_SIDS = 256
command_rate_limits = {}
command_rate_limits_lock = threading.Lock()
command_rate_global = {
    'tokens': COMMAND_RATE_GLOBAL_CAPACITY,
    'updated_at': time.monotonic(),
}

mqtt_state = {
    'connected': False,
    'broker_connected': False,
    'zigbee2mqtt_connected': None,
    'inventory_ready': False,
    'reason': 'Starting',
    'updated_at': time.time(),
}
mqtt_state_lock = threading.Lock()
_MQTT_STATE_UNSET = object()

DEFAULT_GLOBAL_ZONE_CONFIG = {
    'x_min': -400,
    'x_max': 400,
    'y_min': 0,
    'y_max': 600,
    'z_min': -600,
    'z_max': 600,
}
GLOBAL_ZONE_ATTRIBUTE_MAP = {
    'mmWaveWidthMin': 'x_min',
    'mmWaveWidthMax': 'x_max',
    'mmWaveDepthMin': 'y_min',
    'mmWaveDepthMax': 'y_max',
    'mmWaveHeightMin': 'z_min',
    'mmWaveHeightMax': 'z_max',
}


def get_device_snapshot():
    with device_list_lock:
        return copy.deepcopy(list(device_list.values()))


def get_device_by_topic(topic):
    with device_list_lock:
        for data in device_list.values():
            if data.get('topic') == topic:
                return copy.deepcopy(data)
    return None


def _iter_expose_nodes(value):
    if isinstance(value, list):
        for item in value:
            yield from _iter_expose_nodes(item)
        return
    if not isinstance(value, dict):
        return
    yield value
    yield from _iter_expose_nodes(value.get('features'))


def _expose_allows(node, access_bit):
    access = node.get('access') if isinstance(node, dict) else None
    if isinstance(access, bool):
        return True
    if isinstance(access, int):
        return bool(access & access_bit)
    return True


def infer_blue_series_capabilities(definition, model):
    definition_data = definition if isinstance(definition, dict) else {}
    top_level_exposes = definition_data.get('exposes', [])
    control_groups = []
    if isinstance(top_level_exposes, list):
        for expose in top_level_exposes:
            if not isinstance(expose, dict):
                continue
            expose_type = str(expose.get('type') or '').strip().lower()
            if expose_type not in {'light', 'switch', 'fan'}:
                continue
            group_properties = {
                str(node.get('property') or '').strip()
                for node in _iter_expose_nodes(expose)
                if str(node.get('property') or '').strip()
            }
            if group_properties.intersection({'state', 'brightness', 'fan_state', 'fan_mode'}):
                control_groups.append(expose)

    controls_ambiguous = len(control_groups) > 1
    control_source = control_groups[0] if len(control_groups) == 1 else top_level_exposes
    nodes_by_property = {}
    for node in _iter_expose_nodes(control_source):
        prop = str(node.get('property') or '').strip()
        if prop:
            nodes_by_property.setdefault(prop, []).append(node)
    all_properties = {
        str(node.get('property') or '').strip().lower()
        for node in _iter_expose_nodes(top_level_exposes)
        if str(node.get('property') or '').strip()
    }

    def find_property(candidates, access_bit):
        for candidate in candidates:
            if any(_expose_allows(node, access_bit) for node in nodes_by_property.get(candidate, [])):
                return candidate
        return None

    state_property = None if controls_ambiguous else find_property(('state', 'fan_state'), 2)
    brightness_property = None if controls_ambiguous else find_property(('brightness',), 2)
    readable_state_property = (
        find_property((state_property,), 4)
        if state_property
        else None
    )
    readable_brightness_property = (
        find_property((brightness_property,), 4)
        if brightness_property
        else None
    )
    normalized_model = str(model or '').strip().upper()
    has_mmwave = any(prop.startswith('mmwave') for prop in all_properties)
    is_vzm32 = normalized_model == 'VZM32-SN'

    return {
        'state': state_property is not None,
        'brightness': brightness_property is not None,
        'presence': 'occupancy' in all_properties or has_mmwave,
        'zones': is_vzm32,
        'full_editor': is_vzm32,
        'state_property': state_property,
        'brightness_property': brightness_property,
        'readable_state_property': readable_state_property,
        'readable_brightness_property': readable_brightness_property,
        'quick_controls_ambiguous': controls_ambiguous,
    }


def get_basic_control_mapping(device):
    if not isinstance(device, dict):
        return {'state': None, 'brightness': None}
    capabilities = device.get('capabilities') if isinstance(device.get('capabilities'), dict) else {}
    if capabilities.get('quick_controls_ambiguous'):
        return {'state': None, 'brightness': None}
    if 'state_property' in capabilities:
        state_property = capabilities.get('state_property')
    else:
        state_property = 'state' if capabilities.get('state') else None
    if 'brightness_property' in capabilities:
        brightness_property = capabilities.get('brightness_property')
    else:
        brightness_property = 'brightness' if capabilities.get('brightness') else None
    return {
        'state': str(state_property).strip() if state_property else None,
        'brightness': str(brightness_property).strip() if brightness_property else None,
    }


def get_initial_control_query(device):
    if not isinstance(device, dict):
        return {}
    capabilities = device.get('capabilities') if isinstance(device.get('capabilities'), dict) else {}
    properties = (
        capabilities.get('readable_state_property'),
        capabilities.get('readable_brightness_property'),
    )
    return {str(prop): '' for prop in properties if prop}


def upsert_discovered_device(
    friendly_name,
    model='VZM32-SN',
    manufacturer='Inovelli',
    capabilities=None,
    seen_at=None,
    inventory_present=False,
):
    name = str(friendly_name or '').strip()
    if not name or name == 'bridge':
        return None, False
    topic = f"{MQTT_BASE_TOPIC}/{name}"
    created = False
    with device_list_lock:
        cached_availability = device_availability_cache.get(topic)
        cached_state = (
            cached_availability.get('state')
            if isinstance(cached_availability, dict)
            else None
        )
        if name not in device_list:
            device_list[name] = {
                'friendly_name': name,
                'topic': topic,
                'manufacturer': manufacturer or 'Inovelli',
                'model': model or 'Unknown Blue Series model',
                'availability': cached_state,
                'inventory_present': bool(inventory_present),
                'capabilities': {
                    'state': False,
                    'brightness': False,
                    'presence': False,
                    'zones': False,
                    **(capabilities or {}),
                },
                'interference_zones': [],
                'detection_zones': [],
                'stay_zones': [],
                'zone_config': dict(DEFAULT_GLOBAL_ZONE_CONFIG),
                'last_config': {},
                'ota_status': default_ota_status(),
                'last_update': 0,
                'last_seen': time.time() if seen_at is None else seen_at,
            }
            created = True
        else:
            device = device_list[name]
            if model:
                device['model'] = model
            if manufacturer:
                device['manufacturer'] = manufacturer
            device.setdefault('capabilities', {}).update(capabilities or {})
            if cached_state:
                device['availability'] = cached_state
            if inventory_present:
                device['inventory_present'] = True
            if seen_at is not None:
                device['last_seen'] = seen_at
    return topic, created


def set_session_topic(sid, topic):
    with session_topics_lock:
        session_topics[sid] = topic


def get_session_topic(sid):
    with session_topics_lock:
        return session_topics.get(sid)


def get_valid_session_topic(sid):
    topic = get_session_topic(sid)
    if not topic or not get_device_by_topic(topic):
        return None
    return topic


def device_supports_full_editor(topic):
    device = get_device_by_topic(topic)
    if not device:
        return False
    capabilities = device.get('capabilities') if isinstance(device.get('capabilities'), dict) else {}
    if 'full_editor' in capabilities:
        return bool(capabilities.get('full_editor'))
    return str(device.get('model') or '').strip().upper() == 'VZM32-SN'


def resolve_command_topic(sid, data=None):
    requested_topic = data.get('topic') if isinstance(data, dict) else None
    if requested_topic:
        topic = get_device_topic_from_identifier(requested_topic)
        if not topic:
            return None, 'Unknown device topic'
        if not device_supports_full_editor(topic):
            return None, 'Full configuration is not supported for this model yet'
        return topic, None
    topic = get_valid_session_topic(sid)
    if not topic:
        return None, 'No device selected'
    if not device_supports_full_editor(topic):
        return None, 'Full configuration is not supported for this model yet'
    return topic, None


def get_command_readiness_error(topic, require_full_editor=True):
    """Return a retryable reason when a device command is not safe to publish."""
    device = get_device_by_topic(topic)
    if not device:
        return 'Device is no longer in the discovered inventory; refresh and retry'
    if require_full_editor and not device_supports_full_editor(topic):
        return 'Full configuration is not supported for this model yet'

    state = get_mqtt_state()
    if not state.get('broker_connected'):
        return 'MQTT broker is disconnected; wait for reconnection and retry'
    if state.get('zigbee2mqtt_connected') is not True:
        if state.get('zigbee2mqtt_connected') is False:
            return 'Zigbee2MQTT is offline; wait for it to reconnect and retry'
        return 'Zigbee2MQTT readiness is not confirmed yet; wait and retry'
    if not state.get('inventory_ready'):
        return 'Zigbee2MQTT device inventory is still loading; wait and retry'

    availability = str(device.get('availability') or '').strip().lower()
    if availability == 'offline':
        return 'Device is offline; wait for it to reconnect and retry'
    return None


def resolve_ready_command_topic(sid, data=None, require_full_editor=True):
    if require_full_editor:
        topic, error = resolve_command_topic(sid, data)
    else:
        requested_topic = data.get('topic') if isinstance(data, dict) else None
        if requested_topic:
            topic = get_device_topic_from_identifier(requested_topic)
            error = None if topic else 'Unknown device topic'
        else:
            topic = get_valid_session_topic(sid)
            error = None if topic else 'No device selected'
    if not topic:
        return None, error
    readiness_error = get_command_readiness_error(topic, require_full_editor=require_full_editor)
    return (None, readiness_error) if readiness_error else (topic, None)


def normalize_command_request_id(data, prefix):
    raw = data.get('request_id') if isinstance(data, dict) else None
    if raw is None:
        return f"{prefix}-{time.time_ns()}", None
    if not isinstance(raw, str):
        return None, 'Request ID must be a string'
    normalized = raw.strip()
    if not REQUEST_ID_PATTERN.fullmatch(normalized):
        return None, (
            f'Request ID must contain 1-{MAX_REQUEST_ID_LENGTH} letters, numbers, dots, colons, underscores, or hyphens'
        )
    return normalized, None


def validate_bounded_command_value(value, depth=0):
    if depth > MAX_VALUE_DEPTH:
        return f'Payload nesting exceeds the {MAX_VALUE_DEPTH}-level limit'
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        if isinstance(value, float) and not math.isfinite(value):
            return 'Payload numbers must be finite'
        return None
    if isinstance(value, str):
        try:
            encoded_value = value.encode('utf-8')
        except UnicodeEncodeError:
            return 'Payload strings must contain valid UTF-8 text'
        if len(encoded_value) > MAX_STRING_LENGTH:
            return f'Payload strings must be at most {MAX_STRING_LENGTH} UTF-8 bytes'
        return None
    if isinstance(value, list):
        if len(value) > MAX_CONTAINER_ITEMS:
            return f'Payload lists must contain at most {MAX_CONTAINER_ITEMS} items'
        for item in value:
            error = validate_bounded_command_value(item, depth + 1)
            if error:
                return error
        return None
    if isinstance(value, dict):
        if len(value) > MAX_CONTAINER_ITEMS:
            return f'Payload objects must contain at most {MAX_CONTAINER_ITEMS} fields'
        for key, item in value.items():
            if not isinstance(key, str) or not key or len(key) > MAX_PARAMETER_NAME_LENGTH:
                return f'Payload field names must contain 1-{MAX_PARAMETER_NAME_LENGTH} characters'
            try:
                key.encode('utf-8')
            except UnicodeEncodeError:
                return 'Payload field names must contain valid UTF-8 text'
            error = validate_bounded_command_value(item, depth + 1)
            if error:
                return error
        return None
    return f'Payload value type {type(value).__name__} is not supported'


def validate_command_payload(payload):
    error = validate_bounded_command_value(payload)
    if error:
        return error
    try:
        serialized = json.dumps(payload, allow_nan=False, separators=(',', ':'))
    except (TypeError, ValueError):
        return 'Payload must be valid finite JSON'
    if len(serialized.encode('utf-8')) > MAX_COMMAND_PAYLOAD_BYTES:
        return f'Payload exceeds the {MAX_COMMAND_PAYLOAD_BYTES}-byte limit'
    return None


def validate_command_envelope_or_emit(sid, action, payload):
    """Reject oversized or non-JSON Socket.IO command envelopes before parsing."""
    error = validate_command_payload(payload)
    if not error:
        return True
    emit_command_result(
        sid,
        action=action,
        status='error',
        message=error,
    )
    return False


def _refill_command_bucket(bucket, capacity, refill_rate, now):
    previous = float(bucket.get('updated_at') or now)
    effective_now = max(previous, now)
    elapsed = effective_now - previous
    bucket['tokens'] = min(
        float(capacity),
        max(0.0, float(bucket.get('tokens') or 0.0)) + (elapsed * float(refill_rate)),
    )
    bucket['updated_at'] = effective_now


def reset_command_rate_limits(now=None):
    """Reset bounded command accounting; exposed for deterministic lifecycle tests."""
    current = time.monotonic() if now is None else float(now)
    with command_rate_limits_lock:
        command_rate_limits.clear()
        command_rate_global.update({
            'tokens': COMMAND_RATE_GLOBAL_CAPACITY,
            'updated_at': current,
        })


def clear_command_rate_limit(sid):
    if not sid:
        return
    with command_rate_limits_lock:
        command_rate_limits.pop(str(sid), None)


def consume_command_rate_limit(sid, cost=1, now=None):
    """Atomically charge per-session and global buckets without partial deductions."""
    if not sid:
        return False, None
    if isinstance(cost, bool) or not isinstance(cost, (int, float)) or not math.isfinite(float(cost)):
        raise ValueError('Command rate cost must be a finite integer from 1 to 2')
    numeric_cost = float(cost)
    if not numeric_cost.is_integer() or numeric_cost < 1 or numeric_cost > 2:
        raise ValueError('Command rate cost must be a finite integer from 1 to 2')

    current = time.monotonic() if now is None else float(now)
    sid_key = str(sid)
    with command_rate_limits_lock:
        sid_bucket = command_rate_limits.get(sid_key)
        if sid_bucket is None:
            if len(command_rate_limits) >= MAX_COMMAND_RATE_SIDS:
                return False, None
            sid_bucket = {
                'tokens': COMMAND_RATE_CAPACITY_PER_SID,
                'updated_at': current,
            }
            command_rate_limits[sid_key] = sid_bucket

        _refill_command_bucket(
            sid_bucket,
            COMMAND_RATE_CAPACITY_PER_SID,
            COMMAND_RATE_REFILL_PER_SECOND,
            current,
        )
        _refill_command_bucket(
            command_rate_global,
            COMMAND_RATE_GLOBAL_CAPACITY,
            COMMAND_RATE_GLOBAL_REFILL_PER_SECOND,
            current,
        )

        sid_deficit = max(0.0, numeric_cost - sid_bucket['tokens'])
        global_deficit = max(0.0, numeric_cost - command_rate_global['tokens'])
        if sid_deficit or global_deficit:
            retry_after = max(
                sid_deficit / COMMAND_RATE_REFILL_PER_SECOND,
                global_deficit / COMMAND_RATE_GLOBAL_REFILL_PER_SECOND,
                0.1,
            )
            return False, retry_after

        sid_bucket['tokens'] -= numeric_cost
        command_rate_global['tokens'] -= numeric_cost
        return True, 0.0


def enforce_command_rate_limit_or_emit(sid, action, cost=1, topic=None, request_id=None):
    allowed, retry_after = consume_command_rate_limit(sid, cost=cost)
    if allowed:
        return True
    server_busy = retry_after is None
    retry_after_ms = None if server_busy else max(100, int(math.ceil(retry_after * 1000)))
    payload = {
        'error_code': 'server_busy' if server_busy else 'rate_limited',
        'retryable': True,
    }
    if retry_after_ms is not None:
        payload['retry_after_ms'] = retry_after_ms
    emit_command_result(
        sid,
        action=action,
        status='error',
        topic=topic,
        request_id=request_id,
        payload=payload,
        message=(
            'The command service is busy; wait and retry'
            if server_busy else
            f'Too many commands; retry in about {retry_after_ms} ms'
        ),
        error_code=payload['error_code'],
        retryable=True,
        retry_after_ms=retry_after_ms,
    )
    return False


def clear_session_topic(sid):
    with session_topics_lock:
        session_topics.pop(sid, None)


def has_session_for_topic(topic):
    if not topic:
        return False
    with session_topics_lock:
        return any(active_topic == topic for active_topic in session_topics.values())


def set_session_reporting_auto_off(sid, enabled):
    with session_reporting_auto_off_lock:
        session_reporting_auto_off[sid] = bool(enabled)


def get_session_reporting_auto_off(sid):
    with session_reporting_auto_off_lock:
        return bool(session_reporting_auto_off.get(sid, False))


def clear_session_reporting_auto_off(sid):
    with session_reporting_auto_off_lock:
        session_reporting_auto_off.pop(sid, None)


def get_mqtt_state():
    with mqtt_state_lock:
        return copy.deepcopy(mqtt_state)


def update_mqtt_state(
    connected=_MQTT_STATE_UNSET,
    reason=None,
    zigbee2mqtt_connected=_MQTT_STATE_UNSET,
    inventory_ready=_MQTT_STATE_UNSET,
):
    with mqtt_state_lock:
        if connected is not _MQTT_STATE_UNSET:
            mqtt_state['broker_connected'] = bool(connected)
        if zigbee2mqtt_connected is not _MQTT_STATE_UNSET:
            mqtt_state['zigbee2mqtt_connected'] = (
                None if zigbee2mqtt_connected is None else bool(zigbee2mqtt_connected)
            )
        if inventory_ready is not _MQTT_STATE_UNSET:
            mqtt_state['inventory_ready'] = bool(inventory_ready)
        broker_connected = bool(mqtt_state.get('broker_connected'))
        bridge_connected = mqtt_state.get('zigbee2mqtt_connected')
        mqtt_state['connected'] = broker_connected and bridge_connected is True
        mqtt_state['reason'] = str(
            reason
            or ('Connected' if mqtt_state['connected'] else 'Disconnected')
        )
        mqtt_state['updated_at'] = time.time()
        payload = copy.deepcopy(mqtt_state)
    socketio.emit('backend_status', {'mqtt': payload, 'ts': time.time()})
    return payload


def emit_backend_status(room=None):
    socketio.emit(
        'backend_status',
        {'mqtt': get_mqtt_state(), 'ts': time.time()},
        room=room
    )


def _pending_write_key(sid, request_id):
    return f"{sid}:{request_id}"


def _cancel_pending_timer(entry):
    timer = entry.get('timer') if isinstance(entry, dict) else None
    if timer is not None:
        try:
            timer.cancel()
        except Exception:
            pass


def remove_pending_write(sid, request_id):
    key = _pending_write_key(sid, request_id)
    with pending_writes_lock:
        entry = pending_writes.pop(key, None)
    _cancel_pending_timer(entry)
    return entry


def expire_pending_write(sid, request_id):
    entry = remove_pending_write(sid, request_id)
    if not entry:
        return None

    expected = entry.get('expected', {})
    confirmed_fields = sorted(entry.get('confirmed_fields', set()))
    unresolved_fields = sorted(set(expected.keys()) - set(confirmed_fields))
    emit_command_result(
        sid,
        action=entry.get('action') or 'apply_parameters',
        status='not_confirmed',
        topic=entry.get('topic'),
        request_id=request_id,
        payload={
            'expected': copy.deepcopy(expected),
            'observed': copy.deepcopy(entry.get('observed', {})),
            'confirmed_fields': confirmed_fields,
            'unresolved_fields': unresolved_fields,
        },
        message='Device did not confirm every requested value'
    )
    return entry


def register_pending_write(sid, request_id, topic, action, expected):
    if not sid or not request_id or not topic or not isinstance(expected, dict) or not expected:
        return None

    key = _pending_write_key(sid, request_id)
    entry = {
        'sid': sid,
        'request_id': request_id,
        'topic': topic,
        'action': action,
        'expected': copy.deepcopy(expected),
        'observed': {},
        'confirmed_fields': set(),
        'created_at': time.monotonic(),
        'timer': None,
    }

    if not TEST_MODE:
        timer = threading.Timer(PENDING_WRITE_TIMEOUT_SECONDS, expire_pending_write, args=(sid, request_id))
        timer.daemon = True
        entry['timer'] = timer

    with pending_writes_lock:
        existing = pending_writes.get(key)
        if existing is not None:
            return None
        sid_count = sum(1 for item in pending_writes.values() if item.get('sid') == sid)
        if sid_count >= MAX_PENDING_WRITES_PER_SID:
            return None
        if len(pending_writes) >= MAX_PENDING_WRITES_GLOBAL:
            return None
        pending_writes[key] = entry

    if entry['timer'] is not None:
        entry['timer'].start()
    return entry


def clear_pending_writes_for_sid(sid):
    removed = []
    prefix = f"{sid}:"
    with pending_writes_lock:
        for key in [item for item in pending_writes if item.startswith(prefix)]:
            removed.append(pending_writes.pop(key))
    for entry in removed:
        _cancel_pending_timer(entry)


def reconcile_pending_writes(topic, config_payload):
    if not topic or not isinstance(config_payload, dict):
        return

    completed = []
    partial = []
    with pending_writes_lock:
        for key, entry in list(pending_writes.items()):
            if entry.get('topic') != topic:
                continue

            newly_confirmed = []
            confirmation_changed = False
            for param, expected_value in entry.get('expected', {}).items():
                if param not in config_payload:
                    continue
                observed_value = config_payload.get(param)
                entry['observed'][param] = copy.deepcopy(observed_value)
                if _values_equal(expected_value, observed_value) and param not in entry['confirmed_fields']:
                    entry['confirmed_fields'].add(param)
                    newly_confirmed.append(param)
                    confirmation_changed = True
                elif not _values_equal(expected_value, observed_value) and param in entry['confirmed_fields']:
                    entry['confirmed_fields'].remove(param)
                    confirmation_changed = True

            if not confirmation_changed:
                continue

            if len(entry['confirmed_fields']) == len(entry.get('expected', {})):
                completed.append(pending_writes.pop(key))
            else:
                partial.append(copy.deepcopy({
                    'sid': entry.get('sid'),
                    'request_id': entry.get('request_id'),
                    'topic': entry.get('topic'),
                    'action': entry.get('action'),
                    'expected': entry.get('expected', {}),
                    'confirmed_fields': set(entry.get('confirmed_fields', set())),
                }))

    for entry in completed:
        _cancel_pending_timer(entry)
        emit_command_result(
            entry.get('sid'),
            action=entry.get('action') or 'apply_parameters',
            status='confirmed',
            topic=entry.get('topic'),
            request_id=entry.get('request_id'),
            payload=copy.deepcopy(entry.get('expected', {})),
            message='Device confirmed requested values'
        )

    for entry in partial:
        expected_fields = set(entry.get('expected', {}).keys())
        confirmed_fields = set(entry.get('confirmed_fields', set()))
        emit_command_result(
            entry.get('sid'),
            action=entry.get('action') or 'apply_parameters',
            status='sending',
            topic=entry.get('topic'),
            request_id=entry.get('request_id'),
            payload={
                'confirmed_fields': sorted(confirmed_fields),
                'unresolved_fields': sorted(expected_fields - confirmed_fields),
            }
        )


def default_ota_status():
    return {
        'revision': 0,
        'observed_at': None,
        'observed_source': 'zigbee2mqtt',
        'available': None,
        'downgrade': None,
        'installed_version': None,
        'latest_version': None,
        'state': None,
        'progress': None,
        'remaining': None,
        'last_error': None,
    }


def ensure_ota_status(device_data):
    ota_status = device_data.get('ota_status')
    if not isinstance(ota_status, dict):
        ota_status = default_ota_status()
    else:
        ota_status = copy_live_ota_status(ota_status)
    device_data['ota_status'] = ota_status
    return ota_status


LIVE_OTA_FIELDS = (
    'revision',
    'observed_at',
    'observed_source',
    'available',
    'downgrade',
    'installed_version',
    'latest_version',
    'state',
    'progress',
    'remaining',
    'last_error',
)


def copy_live_ota_status(ota_status):
    source = ota_status if isinstance(ota_status, dict) else {}
    live = default_ota_status()
    for key in LIVE_OTA_FIELDS:
        if key in source:
            live[key] = copy.deepcopy(source.get(key))
    try:
        live['revision'] = max(0, int(live.get('revision') or 0))
    except (TypeError, ValueError):
        live['revision'] = 0
    return live


def get_firmware_reference_snapshot():
    """Return reference metadata immediately; this function never performs I/O."""
    try:
        snapshot = get_vzm32sn_reference_data(allow_network=False)
    except Exception as reference_error:
        print(f"Firmware reference snapshot failed: {reference_error}", flush=True)
        snapshot = {}
    return copy.deepcopy(snapshot) if isinstance(snapshot, dict) else {}


def _reference_status_name(reference_data):
    raw_status = str(
        reference_data.get('status')
        or reference_data.get('reference_status')
        or ''
    ).strip().lower()
    if raw_status in {'ready', 'fresh'}:
        return 'fresh'
    if raw_status in {'partial', 'stale', 'refreshing', 'loading', 'unavailable'}:
        return raw_status
    if reference_data.get('fetched_at'):
        return 'stale' if reference_data.get('reference_stale') else 'fresh'
    return 'unavailable'


def _is_firmware_reference_refresh_active():
    with firmware_reference_refresh_lock:
        return bool(firmware_reference_refresh_active)


def _nonnegative_int(value, default=0):
    try:
        return max(0, int(value))
    except (TypeError, ValueError, OverflowError):
        return default


def compose_firmware_status(topic, ota_status=None, schedule_refresh=True):
    live = copy_live_ota_status(ota_status)
    reference_data = None
    if schedule_refresh:
        # Scheduling advances the reference service to a distinct, visible
        # refresh-start generation before we take the snapshot below. This
        # lets long-lived pages distinguish a legitimate refresh from a
        # delayed replay of the preceding terminal generation.
        started_reference = schedule_firmware_reference_refresh()
        if isinstance(started_reference, dict):
            reference_data = copy.deepcopy(started_reference)
    if reference_data is None:
        reference_data = get_firmware_reference_snapshot()
    refreshing = bool(
        reference_data.get('refreshing')
        or reference_data.get('reference_refreshing')
        or _is_firmware_reference_refresh_active()
    )
    status = _reference_status_name(reference_data)
    if refreshing and status == 'unavailable':
        status = 'loading'

    current_versions = reference_data.get('current_versions')
    reference = {
        'generation': _nonnegative_int(
            reference_data.get('generation') or reference_data.get('reference_generation') or 0
        ),
        'status': status,
        'refreshing': refreshing,
        'partial': bool(reference_data.get('partial') or status == 'partial'),
        'stale': bool(reference_data.get('stale') or reference_data.get('reference_stale') or status == 'stale'),
        'fetched_at': reference_data.get('fetched_at'),
        'last_attempt_at': reference_data.get('last_attempt_at'),
        'next_retry_at': reference_data.get('next_retry_at') or reference_data.get('retry_at'),
        'error': reference_data.get('error') or reference_data.get('reference_error'),
        'official_versions': copy.deepcopy(current_versions) if isinstance(current_versions, dict) else {},
        'installed_version_detail': resolve_vzm32sn_firmware_reference(
            live.get('installed_version'),
            allow_network=False,
            reference_data=reference_data,
        ),
        'latest_version_detail': resolve_vzm32sn_firmware_reference(
            live.get('latest_version'),
            allow_network=False,
            reference_data=reference_data,
        ),
        'sources': copy.deepcopy(reference_data.get('sources')) if isinstance(reference_data.get('sources'), dict) else {},
    }
    payload = {
        'schema_version': 1,
        'epoch': FIRMWARE_PROCESS_EPOCH,
        'topic': topic,
        'live': live,
        'reference': reference,
        'management': {
            'owner': 'zigbee2mqtt',
            'local_actions': False,
        },
    }
    return payload


def _firmware_reference_refresh_worker(force_refresh=False):
    global firmware_reference_refresh_active
    try:
        # The scheduler already applied force_refresh while starting the
        # service flight. This worker must only join it; forcing again could
        # start a second attempt if the first completes before this thread is
        # scheduled.
        refresh_vzm32sn_reference_data(force_refresh=False)
    except Exception as refresh_error:
        print(f"Firmware reference refresh failed: {refresh_error}", flush=True)
    finally:
        with firmware_reference_refresh_lock:
            firmware_reference_refresh_active = False

    with device_list_lock:
        topics = [
            data.get('topic')
            for data in device_list.values()
            if data.get('topic')
            and isinstance(data.get('ota_status'), dict)
            and bool((data.get('capabilities') or {}).get('full_editor'))
        ]
    for topic in topics:
        emit_firmware_status(topic)


def schedule_firmware_reference_refresh(force_refresh=False, allow_in_test=False):
    """Start at most one reference worker without delaying MQTT/socket handlers."""
    global firmware_reference_refresh_active, firmware_reference_refresh_thread
    if TEST_MODE and not allow_in_test:
        return False

    reference_data = get_firmware_reference_snapshot()
    status = _reference_status_name(reference_data)
    if not force_refresh and status == 'fresh' and not reference_data.get('reference_stale'):
        return False
    retry_at = reference_data.get('next_retry_at') or reference_data.get('retry_at')
    try:
        if not force_refresh and retry_at is not None and time.time() < float(retry_at):
            return False
    except (TypeError, ValueError, OverflowError):
        pass

    with firmware_reference_refresh_lock:
        if firmware_reference_refresh_active:
            return False
        firmware_reference_refresh_active = True

    try:
        # This call is nonblocking. It atomically records refresh-start as a
        # new reference generation and launches the service's single-flight
        # worker. The app worker below only joins that flight and emits the
        # completed generation.
        started_reference = get_vzm32sn_reference_data(
            allow_network=True,
            force_refresh=bool(force_refresh),
        )
    except Exception as refresh_start_error:
        with firmware_reference_refresh_lock:
            firmware_reference_refresh_active = False
        print(f"Firmware reference refresh could not start: {refresh_start_error}", flush=True)
        return False

    with firmware_reference_refresh_lock:
        worker = threading.Thread(
            target=_firmware_reference_refresh_worker,
            args=(bool(force_refresh),),
            daemon=True,
            name='firmware-reference-refresh',
        )
        firmware_reference_refresh_thread = worker
    try:
        worker.start()
    except Exception as worker_start_error:
        with firmware_reference_refresh_lock:
            firmware_reference_refresh_active = False
            firmware_reference_refresh_thread = None
        print(f"Firmware reference completion worker could not start: {worker_start_error}", flush=True)
        return False
    return copy.deepcopy(started_reference) if isinstance(started_reference, dict) else True


def get_device_id_from_topic(topic):
    if not topic:
        return None
    prefix = f"{MQTT_BASE_TOPIC}/"
    if topic.startswith(prefix):
        suffix = topic[len(prefix):]
        return suffix or None
    return topic.split('/')[-1]


def get_device_topic_from_identifier(identifier):
    if not identifier:
        return None
    normalized = str(identifier).strip()
    if not normalized:
        return None

    with device_list_lock:
        for data in device_list.values():
            topic = data.get('topic')
            if not topic:
                continue
            if topic == normalized:
                return topic
            if data.get('friendly_name') == normalized:
                return topic
            if get_device_id_from_topic(topic) == normalized:
                return topic
    return None


def emit_firmware_status(topic, room=None):
    device_data = get_device_by_topic(topic)
    if not device_data:
        return
    ota_status = device_data.get('ota_status')
    if not isinstance(ota_status, dict):
        return
    ota_payload = compose_firmware_status(topic, ota_status)
    socketio.emit(
        'firmware_status',
        {
            'topic': topic,
            'payload': ota_payload,
            'ts': time.time()
        },
        room=room
    )


def update_device_ota_status(topic, values):
    if not topic or not isinstance(values, dict):
        return None

    ota_payload = None
    with device_list_lock:
        for device_data in device_list.values():
            if device_data.get('topic') != topic:
                continue

            ota_status = ensure_ota_status(device_data)
            for key in LIVE_OTA_FIELDS:
                if key in {'revision', 'observed_at', 'observed_source'}:
                    continue
                if key in values:
                    ota_status[key] = copy.deepcopy(values.get(key))

            ota_status['revision'] = _nonnegative_int(ota_status.get('revision')) + 1
            ota_status['observed_at'] = time.time()
            ota_status['observed_source'] = 'zigbee2mqtt'

            if ota_status.get('state'):
                normalized_state = str(ota_status.get('state')).strip().lower()
                terminal_states = {'idle', 'available', 'up_to_date', 'completed', 'success', 'done', 'checked'}
                if normalized_state not in {'error', 'failed', 'failure'} and 'last_error' not in values:
                    ota_status['last_error'] = None
                if normalized_state in terminal_states and 'progress' not in values:
                    ota_status['progress'] = None
                if normalized_state in {'idle', 'available', 'up_to_date', 'checked'}:
                    ota_status['progress'] = None
                if normalized_state in terminal_states:
                    ota_status['remaining'] = None
            ota_payload = copy.deepcopy(ota_status)
            break

    if ota_payload is None:
        return None

    firmware_payload = compose_firmware_status(topic, ota_payload)
    socketio.emit('firmware_status', {'topic': topic, 'payload': firmware_payload, 'ts': time.time()})
    emit_device_delta('firmware_status', firmware_payload, topic=topic)
    return copy_live_ota_status(ota_payload)


def extract_ota_status_from_payload(payload):
    if not isinstance(payload, dict):
        return None

    update_info = payload.get('update') if isinstance(payload.get('update'), dict) else {}
    result = {}

    for source in (payload, update_info):
        for key in ('update_available', 'updateAvailable'):
            if key in source and source.get(key) is not None:
                result['available'] = _as_bool(source.get(key), False)
                break
        if 'available' in result:
            break

    for source in (payload, update_info):
        if 'downgrade' in source and source.get('downgrade') is not None:
            result['downgrade'] = _as_bool(source.get('downgrade'), False)
            break

    for source in (update_info, payload):
        for key in ('installed_version', 'installedVersion', 'current_version', 'currentVersion'):
            if key in source and source.get(key) is not None:
                result['installed_version'] = str(source.get(key))
                break
        if 'installed_version' in result:
            break

    for source in (update_info, payload):
        for key in ('latest_version', 'latestVersion', 'available_version', 'availableVersion'):
            if key in source and source.get(key) is not None:
                result['latest_version'] = str(source.get(key))
                break
        if 'latest_version' in result:
            break

    # Device payloads also contain a top-level ON/OFF load state. OTA lifecycle
    # fields are authoritative only inside Zigbee2MQTT's nested update object.
    for key in ('state', 'status'):
        if key in update_info and update_info.get(key) is not None:
            result['state'] = str(update_info.get(key))
            break

    # Zigbee2MQTT 2.x removed the legacy update_available property. Its nested
    # update lifecycle is now the availability signal for passive consumers.
    if 'available' not in result and result.get('state') is not None:
        normalized_update_state = str(result.get('state') or '').strip().lower()
        if normalized_update_state == 'available':
            result['available'] = True
        elif normalized_update_state in {'idle', 'up_to_date'}:
            result['available'] = False

    if 'progress' in update_info:
        raw_progress = update_info.get('progress')
        progress = _as_number_or_none(raw_progress)
        if progress is not None or raw_progress is None:
            result['progress'] = progress

    if 'remaining' in update_info:
        raw_remaining = update_info.get('remaining')
        remaining = _as_number_or_none(raw_remaining)
        if remaining is not None or raw_remaining is None:
            result['remaining'] = remaining

    for key in ('error', 'message'):
        if key in update_info:
            error_value = update_info.get(key)
            result['last_error'] = None if error_value in {None, ''} else str(error_value)
            break

    return result or None


def resolve_target_reporting_value(enabled):
    schema = schema_service.get_schema() or {}
    field = None
    for entry in schema.get('fields', []) or []:
        if isinstance(entry, dict) and entry.get('name') == 'mmWaveTargetInfoReport':
            field = entry
            break

    values = [value for value in (field or {}).get('values', []) if isinstance(value, str)]
    if values:
        token = 'enable' if enabled else 'disable'
        for value in values:
            if token in value.lower():
                return value
        return values[-1] if enabled else values[0]

    return 'Enable' if enabled else 'Disable (default)'


def emit_device_delta(kind, payload, topic=None, room=None):
    socketio.emit(
        'device_delta',
        {
            'kind': kind,
            'topic': topic,
            'payload': payload,
            'ts': time.time()
        },
        room=room
    )


def emit_device_list(room=None):
    devices = get_device_snapshot()
    socketio.emit('device_list', devices, room=room)
    emit_device_delta('device_list', {'devices': devices}, room=room)


def build_device_snapshot(topic):
    device_data = get_device_by_topic(topic)
    if not device_data:
        return None

    ota_status = compose_firmware_status(topic, device_data.get('ota_status'))

    payload = {
        'friendly_name': device_data.get('friendly_name'),
        'zone_config': device_data.get('zone_config'),
        'interference_zones': device_data.get('interference_zones', []),
        'detection_zones': device_data.get('detection_zones', []),
        'stay_zones': device_data.get('stay_zones', []),
        'last_config': device_data.get('last_config', {}),
        'last_seen': device_data.get('last_seen'),
        'ota_status': ota_status,
    }
    return {'topic': topic, 'payload': payload, 'ts': time.time()}


def emit_device_snapshot(topic, room=None):
    snapshot = build_device_snapshot(topic)
    if not snapshot:
        return
    socketio.emit('device_snapshot', snapshot, room=room)


def emit_command_result(
    sid,
    action,
    status,
    topic=None,
    request_id=None,
    message=None,
    payload=None,
    rc=None,
    error_code=None,
    retryable=None,
    retry_after_ms=None,
):
    result = {
        'action': action,
        'status': status,
        'topic': topic,
        'request_id': request_id,
        'ts': time.time()
    }
    if message:
        result['message'] = message
    if payload is not None:
        result['payload'] = payload
    if rc is not None:
        result['rc'] = rc
    if error_code is not None:
        result['error_code'] = error_code
    if retryable is not None:
        result['retryable'] = bool(retryable)
    if retry_after_ms is not None:
        result['retry_after_ms'] = int(retry_after_ms)

    socketio.emit('command_result', result, room=sid)


def reserve_pending_write_or_emit(sid, request_id, topic, action, expected):
    entry = register_pending_write(sid, request_id, topic, action, expected)
    if entry is not None:
        return True
    emit_command_result(
        sid,
        action=action,
        status='error',
        topic=topic,
        request_id=request_id,
        payload=copy.deepcopy(expected),
        message='This request is already pending or too many device writes await confirmation; wait and retry',
    )
    return False


def emit_schema_model(room=None):
    socketio.emit('schema_model', schema_service.get_schema(), room=room)


def _iter_schema_fields(fields):
    for field in fields or []:
        if not isinstance(field, dict):
            continue
        yield field
        yield from _iter_schema_fields(field.get('features'))


def _schema_field_can_get(field):
    if not isinstance(field, dict):
        return False
    if 'can_get' in field:
        return bool(field.get('can_get'))
    access = field.get('access')
    return isinstance(access, int) and not isinstance(access, bool) and bool(access & 4)


def build_force_sync_payload():
    schema = schema_service.get_schema() or {}
    payload = {}
    for field in _iter_schema_fields(schema.get('fields')):
        name = field.get('property') or field.get('name')
        if not name:
            continue
        if not _schema_field_can_get(field):
            continue
        payload[str(name)] = ""
    return payload


def on_connect(client, userdata, flags, rc):
    reason = MQTT_CONNACK_REASON.get(rc, "Unknown")
    print(f"Connected to MQTT Broker with code {rc} ({reason})", flush=True)
    if rc == 0:
        subscribe_topic = f"{MQTT_BASE_TOPIC}/#"
        client.subscribe(subscribe_topic)
        print(f"Subscribed to topic: {subscribe_topic}", flush=True)
        update_mqtt_state(
            True,
            'Waiting for Zigbee2MQTT',
            zigbee2mqtt_connected=None,
            inventory_ready=False,
        )
    else:
        update_mqtt_state(False, reason)
        print(
            "MQTT connection was not accepted. Check broker host/port and credentials in add-on Configuration.",
            flush=True
        )


def on_disconnect(client, userdata, rc):
    reason = 'Connection lost' if rc else 'Disconnected'
    print(f"Disconnected from MQTT Broker with code {rc}", flush=True)
    update_mqtt_state(False, reason, zigbee2mqtt_connected=None, inventory_ready=False)


def on_connect_fail(client, userdata):
    print("MQTT connection attempt failed; retrying", flush=True)
    update_mqtt_state(False, 'MQTT broker unavailable', zigbee2mqtt_connected=None, inventory_ready=False)

def on_message(client, userdata, msg):
    global device_list
    try:
        topic = msg.topic
        payload_str = msg.payload.decode().strip()
        
        # --- ROBUST JSON PARSING ---
        if not payload_str:
            return
            
        bridge_state_topic = f"{MQTT_BASE_TOPIC}/bridge/state"
        is_exact_device_topic = get_device_by_topic(topic) is not None
        is_availability_topic = (
            not is_exact_device_topic
            and topic.startswith(f"{MQTT_BASE_TOPIC}/")
            and topic.endswith('/availability')
        )
        try:
            payload = json.loads(payload_str)
        except json.JSONDecodeError:
            if topic != bridge_state_topic and not is_availability_topic:
                return
            payload = payload_str

        if topic == bridge_state_topic:
            bridge_state = payload.get('state') if isinstance(payload, dict) else payload
            normalized_bridge_state = str(bridge_state or '').strip().lower()
            if normalized_bridge_state in {'online', 'offline'}:
                is_online = normalized_bridge_state == 'online'
                update_mqtt_state(
                    zigbee2mqtt_connected=is_online,
                    reason='Connected' if is_online else 'Zigbee2MQTT is offline'
                )
            return

        if is_availability_topic:
            availability_value = payload.get('state') if isinstance(payload, dict) else payload
            normalized_availability = str(availability_value or '').strip().lower()
            if normalized_availability in {'online', 'offline'}:
                base_topic = topic[:-len('/availability')]
                changed = False
                with device_list_lock:
                    device_availability_cache[base_topic] = {
                        'state': normalized_availability,
                        'updated_at': time.time(),
                    }
                    if len(device_availability_cache) > 512:
                        oldest_topic = min(
                            device_availability_cache,
                            key=lambda cached_topic: device_availability_cache[cached_topic].get('updated_at', 0),
                        )
                        device_availability_cache.pop(oldest_topic, None)
                    for device in device_list.values():
                        if device.get('topic') != base_topic:
                            continue
                        changed = device.get('availability') != normalized_availability
                        device['availability'] = normalized_availability
                        if normalized_availability == 'online':
                            device['last_seen'] = time.time()
                        break
                if changed:
                    emit_device_list()
            return

        bridge_devices_topic = f"{MQTT_BASE_TOPIC}/bridge/devices"
        if topic == bridge_devices_topic and isinstance(payload, list):
            initial_queries = []
            inventory_names = set()
            for entry in payload:
                if not isinstance(entry, dict):
                    continue
                if (
                    entry.get('disabled') is True
                    or entry.get('supported') is False
                    or entry.get('interview_completed') is False
                ):
                    continue
                definition = entry.get('definition') if isinstance(entry.get('definition'), dict) else {}
                manufacturer = str(definition.get('vendor') or entry.get('manufacturer') or '').strip()
                model = str(definition.get('model') or entry.get('model_id') or '').strip()
                if manufacturer.lower() != 'inovelli' or not model.upper().startswith('VZM'):
                    continue
                friendly_name = entry.get('friendly_name')
                if not friendly_name:
                    continue
                inventory_names.add(str(friendly_name))
                capabilities = infer_blue_series_capabilities(definition, model)
                discovered_topic, _ = upsert_discovered_device(
                    friendly_name,
                    model=model,
                    manufacturer=manufacturer,
                    capabilities=capabilities,
                    seen_at=None,
                    inventory_present=True,
                )
                if discovered_topic:
                    discovered_device = get_device_by_topic(discovered_topic)
                    query_payload = get_initial_control_query(discovered_device)
                    if query_payload:
                        initial_queries.append((discovered_topic, query_payload))

            with device_list_lock:
                for existing_name in list(device_list.keys()):
                    if existing_name not in inventory_names:
                        device_list.pop(existing_name, None)
                active_topics = {
                    device.get('topic')
                    for device in device_list.values()
                    if device.get('topic')
                }
                for cached_topic in list(device_availability_cache):
                    if cached_topic not in active_topics:
                        device_availability_cache.pop(cached_topic, None)

            current_mqtt_state = get_mqtt_state()
            update_mqtt_state(
                reason=current_mqtt_state.get('reason'),
                inventory_ready=True,
            )
            emit_device_list()
            if client is not None:
                for discovered_topic, query_data in initial_queries:
                    try:
                        client.publish(f"{discovered_topic}/get", json.dumps(query_data), qos=0)
                    except Exception as query_error:
                        print(f"Failed to request initial state for {discovered_topic}: {query_error}", flush=True)
            return

        # Zigbee2MQTT bridge topics may publish arrays/literals; this app only processes object payloads.
        if not isinstance(payload, dict):
            return

        # --- DEVICE DISCOVERY ---
        if topic.startswith(MQTT_BASE_TOPIC):
            has_inovelli_mmwave_signature = (
                'mmWaveVersion' in payload
                and any(
                    key in payload
                    for key in ('mmwaveControlWiredDevice', 'mmWaveRoomSizePreset', 'mmWaveTargetInfoReport')
                )
            )
            # Signature discovery is only a fallback for topics that were not
            # already seeded from bridge/devices. Sparse state reports must not
            # downgrade the authoritative expose-based control mappings.
            if has_inovelli_mmwave_signature and not is_exact_device_topic:
                prefix = f"{MQTT_BASE_TOPIC}/"
                friendly_name = topic[len(prefix):] if topic.startswith(prefix) else ''
                is_command_topic = any(
                    topic.endswith(suffix)
                    and get_device_by_topic(topic[:-len(suffix)]) is not None
                    for suffix in ('/get', '/set', '/availability')
                )
                if friendly_name and not friendly_name.startswith('bridge/') and not is_command_topic:
                    _, discovered = upsert_discovered_device(
                        friendly_name,
                        model='VZM32-SN',
                        manufacturer='Inovelli',
                        capabilities={
                            'state': 'state' in payload,
                            'brightness': 'brightness' in payload,
                            'presence': True,
                            'zones': True,
                            'full_editor': True,
                            'state_property': 'state' if 'state' in payload else None,
                            'brightness_property': 'brightness' if 'brightness' in payload else None,
                            'readable_state_property': 'state' if 'state' in payload else None,
                            'readable_brightness_property': 'brightness' if 'brightness' in payload else None,
                            'quick_controls_ambiguous': False,
                        },
                        seen_at=time.time(),
                        inventory_present=False,
                    )
                    if discovered:
                        print(f"Discovered Inovelli Switch: {friendly_name}", flush=True)
                        emit_device_list()

        # --- CURRENT DEVICE PROCESSING ---
        fname = None
        device_topic = None
        with device_list_lock:
            for name, data in device_list.items():
                if topic == data['topic']:
                    fname = name
                    device_topic = data['topic']
                    data['last_seen'] = time.time()
                    break
        if not fname: return

        # --- PROCESS RAW BYTES (ZCL Cluster 0xFC32) ---
        is_raw_packet = payload.get("0") == 29 and payload.get("1") == 47 and payload.get("2") == 18

        if is_raw_packet:
            cmd_id = payload.get("4")
            
            # --- 0x01: Target Info Reporting (Movement Data) ---
            if cmd_id == 1:
                current_time = time.time()
                should_process = False
                with device_list_lock:
                    device_data = device_list.get(fname)
                    if device_data and (current_time - device_data.get('last_update', 0)) >= 0.1:
                        device_data['last_update'] = current_time
                        should_process = True

                if should_process:
                    seq_num = payload.get("3")
                    num_targets = payload.get("5", 0)
                    targets = []
                    offset = 6

                    for _ in range(num_targets):
                        if str(offset+8) not in payload: break
                        
                        def parse_bytes(idx):
                            try:
                                low = int(payload.get(str(idx)) or 0)
                                high = int(payload.get(str(idx+1)) or 0)
                                return int.from_bytes([low, high], byteorder='little', signed=True)
                            except:
                                return 0

                        targets.append({
                            "id": int(payload.get(str(offset+8)) or 0),
                            "x": parse_bytes(offset),
                            "y": parse_bytes(offset+2),
                            "z": parse_bytes(offset+4),
                            "dop": parse_bytes(offset+6)
                        })
                        offset += 9
                    
                    socketio.emit('new_data', {'topic': device_topic, 'payload': {"seq": seq_num, "targets": targets}})
                    emit_device_delta('new_data', {"seq": seq_num, "targets": targets}, topic=device_topic)

            # --- 0x02 (Interference), 0x03 (Detection), 0x04 (Stay) Areas ---
            elif cmd_id in [2, 3, 4]:
                try:
                    zones = []
                    offset = 6  
                    num_zones = payload.get("5", 0) 
                    
                    for area_offset in range(num_zones):
                        if str(offset+11) not in payload: break
                        
                        def parse_bytes(idx):
                            low = int(payload.get(str(idx)) or 0)
                            high = int(payload.get(str(idx+1)) or 0)
                            return int.from_bytes([low, high], byteorder='little', signed=True)

                        x_min = parse_bytes(offset)
                        x_max = parse_bytes(offset+2)
                        y_min = parse_bytes(offset+4)
                        y_max = parse_bytes(offset+6)
                        z_min = parse_bytes(offset+8)
                        z_max = parse_bytes(offset+10)
                        
                        # Append if it looks like a valid configured zone (has dimensions)
                        # We use a loose check (x_max > x_min) to allow 0-based zones if valid, 
                        # but typically 0,0,0,0,0,0 is an empty zone.
                        if (x_max != 0 or x_min != 0 or y_max != 0 or y_min != 0):
                            zones.append({
                                # Empty raw slots are omitted to preserve the
                                # existing active-zone count contract. Carry the
                                # physical slot identity explicitly so later
                                # consumers do not renumber area3 as area2.
                                "area_id": f"area{area_offset + 1}",
                                "area_index": area_offset + 1,
                                "x_min": x_min, "x_max": x_max, 
                                "y_min": y_min, "y_max": y_max,
                                "z_min": z_min, "z_max": z_max
                            })
                        
                        offset += 12
                    
                    # Store and Emit based on Command ID
                    if cmd_id == 2:
                        with device_list_lock:
                            if fname in device_list:
                                device_list[fname]['interference_zones'] = zones
                        socketio.emit('interference_zones', {'topic': device_topic, 'payload': zones})
                        emit_device_delta('interference_zones', zones, topic=device_topic)
                        print(f"Interference Zones Updated: {zones}", flush=True)
                    elif cmd_id == 3:
                        with device_list_lock:
                            if fname in device_list:
                                device_list[fname]['detection_zones'] = zones
                        socketio.emit('detection_zones', {'topic': device_topic, 'payload': zones})
                        emit_device_delta('detection_zones', zones, topic=device_topic)
                        print(f"Detection Zones Updated: {zones}", flush=True)
                    elif cmd_id == 4:
                        with device_list_lock:
                            if fname in device_list:
                                device_list[fname]['stay_zones'] = zones
                        socketio.emit('stay_zones', {'topic': device_topic, 'payload': zones})
                        emit_device_delta('stay_zones', zones, topic=device_topic)
                        print(f"Stay Zones Updated: {zones}", flush=True)
                    
                except Exception as parse_error:
                    print(f"Warning: Zone packet offset mismatch: {parse_error}", flush=True)
        
        # --- STANDARD STATE UPDATE ---
        config_payload = {k: v for k, v in payload.items() if not k.isdigit()}
        basic_control_mapping = get_basic_control_mapping(get_device_by_topic(device_topic))
        state_property = basic_control_mapping.get('state')
        brightness_property = basic_control_mapping.get('brightness')
        if state_property and state_property != 'state' and state_property in config_payload:
            config_payload['state'] = config_payload[state_property]
        if brightness_property and brightness_property != 'brightness' and brightness_property in config_payload:
            config_payload['brightness'] = config_payload[brightness_property]
        
        if config_payload:
            socketio.emit('device_config', {'topic': device_topic, 'payload': config_payload})
            emit_device_delta('device_config', config_payload, topic=device_topic)

            # Update Standard Global Zone (Attributes 103-106)
            needs_emit = False
            zone_payload = None
            capabilities_changed = False
            ota_status_update = extract_ota_status_from_payload(config_payload)

            with device_list_lock:
                device_data = device_list.get(fname)
                if device_data:
                    if not isinstance(device_data.get('last_config'), dict):
                        device_data['last_config'] = {}
                    device_data['last_config'].update(config_payload)
                    capabilities = device_data.setdefault('capabilities', {})
                    # Signature-only discovery starts conservatively because its
                    # first sparse report may omit load controls. Later explicit
                    # state reports may safely upgrade those inferred mappings;
                    # inventory-derived expose metadata remains authoritative.
                    may_upgrade_signature_controls = (
                        not device_data.get('inventory_present')
                        and str(device_data.get('model') or '').strip().upper() == 'VZM32-SN'
                        and capabilities.get('full_editor', True)
                        and not capabilities.get('quick_controls_ambiguous')
                    )
                    if may_upgrade_signature_controls:
                        if 'state' in config_payload:
                            state_updates = {
                                'state': True,
                                'state_property': 'state',
                                'readable_state_property': 'state',
                            }
                            capabilities_changed = capabilities_changed or any(
                                capabilities.get(key) != value for key, value in state_updates.items()
                            )
                            capabilities.update(state_updates)
                        if 'brightness' in config_payload:
                            brightness_updates = {
                                'brightness': True,
                                'brightness_property': 'brightness',
                                'readable_brightness_property': 'brightness',
                            }
                            capabilities_changed = capabilities_changed or any(
                                capabilities.get(key) != value for key, value in brightness_updates.items()
                            )
                            capabilities.update(brightness_updates)
                        if 'quick_controls_ambiguous' not in capabilities:
                            capabilities['quick_controls_ambiguous'] = False
                            capabilities_changed = True

                    current_zone = dict(DEFAULT_GLOBAL_ZONE_CONFIG)
                    cached_zone = device_data.get('zone_config')
                    if isinstance(cached_zone, dict):
                        current_zone.update(cached_zone)

                    for attribute_name, coordinate_name in GLOBAL_ZONE_ATTRIBUTE_MAP.items():
                        if attribute_name not in config_payload:
                            continue
                        parsed = _as_int_or_none(config_payload.get(attribute_name))
                        if parsed is not None:
                            current_zone[coordinate_name] = parsed
                            needs_emit = True

                    if needs_emit:
                        device_data['zone_config'] = current_zone
                        zone_payload = copy.deepcopy(current_zone)

            if capabilities_changed:
                # The dashboard capability model is carried by device_list, not
                # device_config. Publish the promotion immediately so quick
                # controls become usable without a reconnect or inventory refresh.
                emit_device_list()

            if ota_status_update:
                update_device_ota_status(device_topic, ota_status_update)

            reconcile_pending_writes(device_topic, config_payload)

            if zone_payload:
                socketio.emit('zone_config', {'topic': device_topic, 'payload': zone_payload})
                emit_device_delta('zone_config', zone_payload, topic=device_topic)

    except Exception as e:
        print(f"Error processing message on {msg.topic}: {e}", flush=True)
        traceback.print_exc()

mqtt_client = mqtt.Client()
if MQTT_USERNAME or MQTT_PASSWORD:
    mqtt_client.username_pw_set(MQTT_USERNAME or '', MQTT_PASSWORD or None)

mqtt_client.on_connect = on_connect
mqtt_client.on_connect_fail = on_connect_fail
mqtt_client.on_disconnect = on_disconnect
mqtt_client.on_message = on_message

def start_mqtt_client(client):
    client.reconnect_delay_set(min_delay=1, max_delay=30)
    try:
        client.connect_async(MQTT_BROKER, MQTT_PORT, 60)
    except Exception as e:
        print(f"Initial MQTT connection setup failed: {e}", flush=True)
    finally:
        client.loop_start()


if not TEST_MODE:
    start_mqtt_client(mqtt_client)


def publish_json(topic, payload, origin, sid=None):
    validation_error = validate_command_payload(payload)
    if validation_error:
        print(
            f"[MQTT-PUBLISH-REJECTED] origin={origin} sid={sid or '-'} topic={topic} error={validation_error}",
            flush=True,
        )
        return False, validation_error
    payload_str = json.dumps(payload, allow_nan=False)
    print(f"[MQTT-PUBLISH] origin={origin} sid={sid or '-'} topic={topic} payload={payload_str}", flush=True)
    try:
        # QoS 0 makes a disconnected command fail immediately instead of being
        # buffered by Paho and unexpectedly executing after a later reconnect.
        publish_result = mqtt_client.publish(topic, payload_str, qos=0)
        rc = getattr(publish_result, 'rc', None)
        ok = (rc == mqtt.MQTT_ERR_SUCCESS)
        return ok, rc
    except Exception as publish_error:
        print(
            f"[MQTT-PUBLISH-ERROR] origin={origin} sid={sid or '-'} topic={topic} error={publish_error}",
            flush=True
        )
        return False, str(publish_error)


# --- WEBSOCKET HANDLERS ---
@socketio.on('connect')
def handle_socket_connect(auth=None):
    if not is_trusted_ingress_peer(request.remote_addr):
        print(
            f"Rejected untrusted WebSocket peer: remote_addr={request.remote_addr or '-'}",
            flush=True,
        )
        return False
    if not is_allowed_socket_origin(request.headers.get('Origin'), request.environ):
        print(
            f"Rejected cross-origin WebSocket connection: remote_addr={request.remote_addr or '-'}",
            flush=True,
        )
        return False
    print(f"WebSocket connected: sid={request.sid}", flush=True)
    set_session_reporting_auto_off(request.sid, False)
    emit_schema_model(room=request.sid)
    emit_backend_status(room=request.sid)


@socketio.on('disconnect')
def handle_socket_disconnect(reason=None):
    sid = request.sid
    # This topic was validated when selected. Keep it for cleanup even if the
    # device was evicted from the in-memory discovery list before disconnect.
    current_topic = get_session_topic(sid)
    should_auto_off = get_session_reporting_auto_off(sid)
    clear_session_topic(sid)
    clear_session_reporting_auto_off(sid)
    clear_pending_writes_for_sid(sid)

    if should_auto_off and current_topic and not has_session_for_topic(current_topic):
        readiness_error = get_command_readiness_error(current_topic)
        if readiness_error:
            print(
                f"Skipped auto-disabling mmWave target reporting: topic={current_topic} sid={sid} reason={readiness_error}",
                flush=True,
            )
        else:
            disable_value = resolve_target_reporting_value(False)
            payload = {'mmWaveTargetInfoReport': disable_value}
            ok, rc = publish_json(f"{current_topic}/set", payload, origin='auto_disable_target_reporting', sid=sid)
            if ok:
                print(
                    f"Auto-disabled mmWave target reporting on disconnect: topic={current_topic} sid={sid}",
                    flush=True
                )
            else:
                print(
                    f"Failed to auto-disable mmWave target reporting on disconnect: topic={current_topic} sid={sid} rc={rc}",
                    flush=True
                )

    clear_command_rate_limit(sid)

    print(f"WebSocket disconnected: sid={request.sid}", flush=True)


@socketio.on('request_devices')
def handle_request_devices():
    emit_device_list(room=request.sid)


@socketio.on('request_schema')
def handle_request_schema():
    emit_schema_model(room=request.sid)

@socketio.on('change_device')
def handle_change_device(new_topic):
    if not new_topic:
        clear_session_topic(request.sid)
        return

    resolved_topic = get_device_topic_from_identifier(new_topic)
    if not resolved_topic:
        clear_session_topic(request.sid)
        emit_command_result(
            request.sid,
            action='change_device',
            status='error',
            message='Device is not currently available'
        )
        return
    if not device_supports_full_editor(resolved_topic):
        clear_session_topic(request.sid)
        emit_command_result(
            request.sid,
            action='change_device',
            status='error',
            topic=resolved_topic,
            message='Full configuration is not supported for this model yet'
        )
        return

    set_session_topic(request.sid, resolved_topic)
    print(f"Switched monitoring to: {resolved_topic} (sid={request.sid})", flush=True)
    emit_command_result(
        request.sid,
        action='change_device',
        status='sent',
        topic=resolved_topic,
        payload={'topic': resolved_topic}
    )
    emit_device_delta('selected_device', {'topic': resolved_topic}, topic=resolved_topic, room=request.sid)
    emit_device_snapshot(resolved_topic, room=request.sid)

    device_data = get_device_by_topic(resolved_topic)
    if device_data:
        if 'zone_config' in device_data: 
            socketio.emit('zone_config', {'topic': resolved_topic, 'payload': device_data['zone_config']}, room=request.sid)
        if 'interference_zones' in device_data: 
            socketio.emit('interference_zones', {'topic': resolved_topic, 'payload': device_data['interference_zones']}, room=request.sid)
        if 'detection_zones' in device_data:
            socketio.emit('detection_zones', {'topic': resolved_topic, 'payload': device_data['detection_zones']}, room=request.sid)
        if 'stay_zones' in device_data:
            socketio.emit('stay_zones', {'topic': resolved_topic, 'payload': device_data['stay_zones']}, room=request.sid)


@socketio.on('set_reporting_auto_off')
def handle_set_reporting_auto_off(data):
    if not validate_command_envelope_or_emit(request.sid, 'set_reporting_auto_off', data):
        return
    enabled = False
    if isinstance(data, dict):
        enabled = _as_bool(data.get('enabled'), False)
    else:
        enabled = _as_bool(data, False)

    set_session_reporting_auto_off(request.sid, enabled)
    emit_command_result(
        request.sid,
        action='set_reporting_auto_off',
        status='sent',
        topic=get_session_topic(request.sid),
        payload={'enabled': enabled}
    )


@socketio.on('set_target_reporting')
def handle_set_target_reporting(data):
    if not validate_command_envelope_or_emit(request.sid, 'set_target_reporting', data):
        return
    request_id, request_error = normalize_command_request_id(data, 'target-report')
    if request_error:
        emit_command_result(
            request.sid,
            action='set_target_reporting',
            status='error',
            message=request_error,
        )
        return
    current_topic, topic_error = resolve_ready_command_topic(request.sid, data)
    if not current_topic:
        emit_command_result(
            request.sid,
            action='set_target_reporting',
            status='error',
            request_id=request_id,
            message=topic_error
        )
        return

    enabled = False
    if isinstance(data, dict):
        enabled = _as_bool(data.get('enabled'), False)
    else:
        enabled = _as_bool(data, False)

    target_value = resolve_target_reporting_value(enabled)
    payload = {'mmWaveTargetInfoReport': target_value}
    if not enforce_command_rate_limit_or_emit(
        request.sid,
        'set_target_reporting',
        cost=1,
        topic=current_topic,
        request_id=request_id,
    ):
        return
    if not reserve_pending_write_or_emit(
        request.sid,
        request_id,
        current_topic,
        'set_target_reporting',
        payload
    ):
        return
    ok, rc = publish_json(
        f"{current_topic}/set",
        payload,
        origin='set_target_reporting',
        sid=request.sid
    )
    if not ok:
        remove_pending_write(request.sid, request_id)
    emit_command_result(
        request.sid,
        action='set_target_reporting',
        status='sent' if ok else 'error',
        topic=current_topic,
        request_id=request_id,
        payload={'enabled': enabled, 'value': target_value},
        rc=rc,
        message=None if ok else 'MQTT publish failed'
    )


@socketio.on('set_basic_control')
def handle_set_basic_control(data):
    if not validate_command_envelope_or_emit(request.sid, 'set_basic_control', data):
        return
    if not isinstance(data, dict):
        emit_command_result(
            request.sid,
            action='set_basic_control',
            status='error',
            request_id=None,
            message='Invalid payload'
        )
        return

    request_id, request_error = normalize_command_request_id(data, 'basic')
    if request_error:
        emit_command_result(
            request.sid,
            action='set_basic_control',
            status='error',
            message=request_error,
        )
        return
    current_topic, topic_error = resolve_ready_command_topic(
        request.sid,
        data,
        require_full_editor=False,
    )
    if not current_topic:
        emit_command_result(
            request.sid,
            action='set_basic_control',
            status='error',
            request_id=request_id,
            message=topic_error,
        )
        return

    control_payload = {}
    errors = []
    basic_control_mapping = get_basic_control_mapping(get_device_by_topic(current_topic))

    if 'state' in data:
        if not basic_control_mapping.get('state'):
            errors.append('Power control is not supported for this device')
        else:
            normalized_state, state_error = _normalize_basic_state(data.get('state'))
            if state_error:
                errors.append(state_error)
            else:
                control_payload['state'] = normalized_state

    if 'brightness' in data:
        if not basic_control_mapping.get('brightness'):
            errors.append('Brightness control is not supported for this device')
        else:
            normalized_brightness, brightness_error = _normalize_basic_brightness(data.get('brightness'))
            if brightness_error:
                errors.append(brightness_error)
            else:
                control_payload['brightness'] = normalized_brightness

    if errors:
        emit_command_result(
            request.sid,
            action='set_basic_control',
            status='error',
            topic=current_topic,
            request_id=request_id,
            payload={k: v for k, v in data.items() if k in {'state', 'brightness'}},
            message='; '.join(errors)
        )
        return

    if not control_payload:
        emit_command_result(
            request.sid,
            action='set_basic_control',
            status='error',
            topic=current_topic,
            request_id=request_id,
            message='Missing state or brightness'
        )
        return

    publish_payload = {
        basic_control_mapping[control_name]: value
        for control_name, value in control_payload.items()
    }
    if not enforce_command_rate_limit_or_emit(
        request.sid,
        'set_basic_control',
        cost=1,
        topic=current_topic,
        request_id=request_id,
    ):
        return
    if not reserve_pending_write_or_emit(
        request.sid,
        request_id,
        current_topic,
        'set_basic_control',
        control_payload
    ):
        return
    ok, rc = publish_json(
        f"{current_topic}/set",
        publish_payload,
        origin='set_basic_control',
        sid=request.sid
    )
    if not ok:
        remove_pending_write(request.sid, request_id)
    emit_command_result(
        request.sid,
        action='set_basic_control',
        status='sent' if ok else 'error',
        topic=current_topic,
        request_id=request_id,
        payload=control_payload,
        rc=rc,
        message=None if ok else 'MQTT publish failed'
    )


@socketio.on('update_parameter')
def handle_update_parameter(data):
    if not validate_command_envelope_or_emit(request.sid, 'update_parameter', data):
        return
    if not isinstance(data, dict):
        emit_command_result(
            request.sid,
            action='update_parameter',
            status='error',
            request_id=None,
            message='Invalid payload'
        )
        return
    request_id, request_error = normalize_command_request_id(data, 'update')
    if request_error:
        emit_command_result(
            request.sid,
            action='update_parameter',
            status='error',
            message=request_error,
        )
        return
    current_topic, topic_error = resolve_ready_command_topic(request.sid, data)
    if not current_topic:
        emit_command_result(
            request.sid,
            action='update_parameter',
            status='error',
            request_id=request_id,
            message=topic_error
        )
        return

    param = data.get('param')
    if not isinstance(param, str) or not param.strip() or len(param) > MAX_PARAMETER_NAME_LENGTH:
        emit_command_result(
            request.sid,
            action='update_parameter',
            status='error',
            topic=current_topic,
            request_id=request_id,
            message=f'Parameter name must contain 1-{MAX_PARAMETER_NAME_LENGTH} characters'
        )
        return
    param = param.strip()

    value = data.get('value')
    payload_error = validate_command_payload({param: value})
    if payload_error:
        emit_command_result(
            request.sid,
            action='update_parameter',
            status='error',
            topic=current_topic,
            request_id=request_id,
            message=payload_error,
        )
        return

    is_valid, validation_error, normalized_value, is_unknown_field = schema_service.validate_update(param, value)
    if not is_valid:
        emit_command_result(
            request.sid,
            action='update_parameter',
            status='error',
            topic=current_topic,
            request_id=request_id,
            payload={param: value},
            message=validation_error
        )
        return

    control_payload = {param: normalized_value}
    if not enforce_command_rate_limit_or_emit(
        request.sid,
        'update_parameter',
        cost=1,
        topic=current_topic,
        request_id=request_id,
    ):
        return
    if not reserve_pending_write_or_emit(
        request.sid,
        request_id,
        current_topic,
        'update_parameter',
        control_payload
    ):
        return
    ok, rc = publish_json(f"{current_topic}/set", control_payload, origin='update_parameter', sid=request.sid)
    if not ok:
        remove_pending_write(request.sid, request_id)
    emit_command_result(
        request.sid,
        action='update_parameter',
        status='sent' if ok else 'error',
        topic=current_topic,
        request_id=request_id,
        payload=control_payload,
        rc=rc,
        message='Sent without schema validation (unknown field)' if (ok and is_unknown_field) else (None if ok else 'MQTT publish failed')
    )


@socketio.on('apply_parameters')
def handle_apply_parameters(data):
    if not validate_command_envelope_or_emit(request.sid, 'apply_parameters', data):
        return
    if not isinstance(data, dict) or not isinstance(data.get('changes'), dict) or not data.get('changes'):
        emit_command_result(
            request.sid,
            action='apply_parameters',
            status='error',
            request_id=None,
            message='Changes must be a non-empty object'
        )
        return
    request_id, request_error = normalize_command_request_id(data, 'apply')
    if request_error:
        emit_command_result(
            request.sid,
            action='apply_parameters',
            status='error',
            message=request_error,
        )
        return
    current_topic, topic_error = resolve_ready_command_topic(request.sid, data)
    if not current_topic:
        emit_command_result(
            request.sid,
            action='apply_parameters',
            status='error',
            request_id=request_id,
            message=topic_error
        )
        return
    changes = data.get('changes')
    if len(changes) > MAX_CHANGE_COUNT:
        emit_command_result(
            request.sid,
            action='apply_parameters',
            status='error',
            topic=current_topic,
            request_id=request_id,
            message=f'At most {MAX_CHANGE_COUNT} fields may be applied at once',
        )
        return
    payload_error = validate_command_payload(changes)
    if payload_error:
        emit_command_result(
            request.sid,
            action='apply_parameters',
            status='error',
            topic=current_topic,
            request_id=request_id,
            message=payload_error,
        )
        return
    normalized_changes = {}
    unknown_fields = []
    validation_errors = []

    for param, value in changes.items():
        if (
            not isinstance(param, str)
            or not param
            or param != param.strip()
            or len(param) > MAX_PARAMETER_NAME_LENGTH
        ):
            validation_errors.append('Every change must have a valid parameter name')
            continue
        is_valid, validation_error, normalized_value, is_unknown_field = schema_service.validate_update(param, value)
        if not is_valid:
            validation_errors.append(f"{param}: {validation_error}")
            continue
        normalized_changes[param] = normalized_value
        if is_unknown_field:
            unknown_fields.append(param)

    if validation_errors:
        emit_command_result(
            request.sid,
            action='apply_parameters',
            status='error',
            topic=current_topic,
            request_id=request_id,
            payload={'errors': validation_errors},
            message='; '.join(validation_errors)
        )
        return

    if not enforce_command_rate_limit_or_emit(
        request.sid,
        'apply_parameters',
        cost=1,
        topic=current_topic,
        request_id=request_id,
    ):
        return
    if not reserve_pending_write_or_emit(
        request.sid,
        request_id,
        current_topic,
        'apply_parameters',
        normalized_changes
    ):
        return
    ok, rc = publish_json(
        f"{current_topic}/set",
        normalized_changes,
        origin='apply_parameters',
        sid=request.sid
    )
    if not ok:
        remove_pending_write(request.sid, request_id)

    emit_command_result(
        request.sid,
        action='apply_parameters',
        status='sent' if ok else 'error',
        topic=current_topic,
        request_id=request_id,
        payload=normalized_changes,
        rc=rc,
        message=(
            f"Sent with {len(unknown_fields)} unrecognized field(s)"
            if ok and unknown_fields
            else (None if ok else 'MQTT publish failed')
        )
    )


@socketio.on('force_sync')
def handle_force_sync(data=None):
    if not validate_command_envelope_or_emit(request.sid, 'force_sync', data):
        return
    request_id, request_error = normalize_command_request_id(data, 'force-sync')
    if request_error:
        emit_command_result(
            request.sid,
            action='force_sync',
            status='error',
            message=request_error,
        )
        return
    current_topic, topic_error = resolve_ready_command_topic(request.sid, data)
    if not current_topic:
        emit_command_result(
            request.sid,
            action='force_sync',
            status='error',
            request_id=request_id,
            message=topic_error
        )
        return
    
    # Build and validate the complete two-publish operation before charging it.
    payload = build_force_sync_payload()
    if not payload:
        emit_command_result(
            request.sid,
            action='force_sync',
            status='error',
            topic=current_topic,
            request_id=request_id,
            message='No GET-capable fields are available for this device schema',
        )
        return
    if not enforce_command_rate_limit_or_emit(
        request.sid,
        'force_sync',
        cost=2,
        topic=current_topic,
        request_id=request_id,
    ):
        return

    # 1. Emit cached data only after the complete operation has acquired its
    # two-token budget. A denied request performs no command-side work.
    emit_device_snapshot(current_topic, room=request.sid)
    device_data = get_device_by_topic(current_topic)
    if device_data:
        if 'zone_config' in device_data: socketio.emit('zone_config', {'topic': current_topic, 'payload': device_data['zone_config']}, room=request.sid)
        if 'interference_zones' in device_data: socketio.emit('interference_zones', {'topic': current_topic, 'payload': device_data['interference_zones']}, room=request.sid)
        if 'detection_zones' in device_data: socketio.emit('detection_zones', {'topic': current_topic, 'payload': device_data['detection_zones']}, room=request.sid)
        if 'stay_zones' in device_data: socketio.emit('stay_zones', {'topic': current_topic, 'payload': device_data['stay_zones']}, room=request.sid)

    # 2. Trigger Z2M read.
    ok_get, rc_get = publish_json(f"{current_topic}/get", payload, origin='force_sync_get', sid=request.sid)
    emit_command_result(
        request.sid,
        action='force_sync_get',
        status='sent' if ok_get else 'error',
        topic=current_topic,
        request_id=request_id,
        payload=payload,
        rc=rc_get,
        message=None if ok_get else 'MQTT publish failed'
    )
    
    # 3. Trigger mmWave Module Report (Query Areas)
    # This forces the sensor to output packets 0x02, 0x03, 0x04
    cmd_payload = { "mmwave_control_commands": { "controlID": "query_areas" } }
    ok_cmd, rc_cmd = publish_json(f"{current_topic}/set", cmd_payload, origin='force_sync_query_areas', sid=request.sid)
    emit_command_result(
        request.sid,
        action='force_sync_query_areas',
        status='sent' if ok_cmd else 'error',
        topic=current_topic,
        request_id=request_id,
        payload=cmd_payload,
        rc=rc_cmd,
        message=None if ok_cmd else 'MQTT publish failed'
    )
    print(f"Force Sync (Z2M Read + Query Areas) sent to {current_topic} (sid={request.sid})", flush=True)


@socketio.on('send_command')
def handle_command(cmd_action):
    if not validate_command_envelope_or_emit(request.sid, 'send_command', cmd_action):
        return
    current_topic, topic_error = resolve_ready_command_topic(request.sid)
    if not current_topic:
        emit_command_result(
            request.sid,
            action='send_command',
            status='error',
            message=topic_error
        )
        return

    action_map = { 0: "reset_mmwave_module", 1: "set_interference", 2: "query_areas", 3: "clear_interference", 4: "reset_detection_area", 5: "clear_stay_areas" }
    try:
        if isinstance(cmd_action, bool):
            raise ValueError
        if isinstance(cmd_action, float) and not cmd_action.is_integer():
            raise ValueError
        if isinstance(cmd_action, str) and not re.fullmatch(r"[0-9]+", cmd_action.strip()):
            raise ValueError
        cmd_action_int = int(cmd_action)
    except (TypeError, ValueError):
        emit_command_result(
            request.sid,
            action='send_command',
            status='error',
            topic=current_topic,
            message='Invalid command action'
        )
        return

    cmd_string = action_map.get(cmd_action_int)
    if cmd_string:
        cmd_payload = {"mmwave_control_commands": {"controlID": cmd_string}}
        if not enforce_command_rate_limit_or_emit(
            request.sid,
            'send_command',
            cost=1,
            topic=current_topic,
        ):
            return
        ok, rc = publish_json(
            f"{current_topic}/set",
            cmd_payload,
            origin='send_command',
            sid=request.sid
        )
        emit_command_result(
            request.sid,
            action='send_command',
            status='sent' if ok else 'error',
            topic=current_topic,
            payload={'action_id': cmd_action_int, 'controlID': cmd_string},
            rc=rc,
            message=None if ok else 'MQTT publish failed'
        )
    else:
        emit_command_result(
            request.sid,
            action='send_command',
            status='error',
            topic=current_topic,
            payload={'action_id': cmd_action_int},
            message='Unknown command action'
        )


def cleanup_stale_devices():
    while True:
        time.sleep(60)
        current_time = time.time()
        with device_list_lock:
            stale_keys = [
                key for key, value in device_list.items()
                if not value.get('inventory_present') and (current_time - value.get('last_seen', 0)) > 3600
            ]
            for key in stale_keys:
                del device_list[key]
        if stale_keys:
            emit_device_list()

cleanup_thread = None
if not TEST_MODE:
    cleanup_thread = threading.Thread(target=cleanup_stale_devices, daemon=True)
    cleanup_thread.start()

@app.route('/')
def index():
    return render_template(
        'index.html',
        ingress_path=request.headers.get('X-Ingress-Path', ''),
        switch_studio_ui=SWITCH_STUDIO_UI
    )

if __name__ == '__main__':
    socketio.run(app, host='0.0.0.0', port=5000, allow_unsafe_werkzeug=True)
