import copy
import json
import re
import threading
import time
import urllib.request


VZM32SN_HELP_URL = "https://help.inovelli.com/en/articles/13744028-blue-series-mmwave-presence-dimmer-switch-firmware-changelog"
VZM32SN_COMMUNITY_URL = "https://community.inovelli.com/t/blue-series-mmwave-firmware-changelog-vzm32-sn/20869"
VZM32SN_COMMUNITY_JSON_URL = f"{VZM32SN_COMMUNITY_URL}.json"
INOVELLI_FIRMWARE_TREE_URL = "https://api.github.com/repos/InovelliUSA/Firmware/git/trees/main?recursive=1"
INOVELLI_FIRMWARE_RAW_ROOT = "https://raw.githubusercontent.com/InovelliUSA/Firmware/main/"
ZIGBEE_OTA_INDEX_URLS = (
    "https://raw.githubusercontent.com/Koenkk/zigbee-OTA/master/index.json",
    "https://raw.githubusercontent.com/Koenkk/zigbee-OTA/master/index1.json",
)
REFERENCE_CACHE_TTL_SECONDS = 6 * 60 * 60

_CACHE_LOCK = threading.Lock()
_REFERENCE_CACHE = {}

_VERSION_IN_FILENAME_RE = re.compile(r"_([0-9]+\.[0-9]+)\.ota$", re.IGNORECASE)
_CURRENT_VERSION_RE = re.compile(
    r"Current\s+(Production|Beta)\s+Version:</b>\s*([0-9]+\.[0-9]+)",
    re.IGNORECASE,
)
_COMMUNITY_VERSION_RE = re.compile(
    r"v([0-9]+\.[0-9]+)\s*/\s*0x([0-9A-Fa-f]{8})",
    re.IGNORECASE,
)


def _http_get_bytes(url):
    req = urllib.request.Request(url, headers={"User-Agent": "SwitchStudio/1.0"})
    with urllib.request.urlopen(req, timeout=15) as response:
        return response.read()


def _http_get_json(url):
    return json.loads(_http_get_bytes(url).decode("utf-8"))


def _http_get_text(url):
    return _http_get_bytes(url).decode("utf-8", "ignore")


def _coerce_build_int(value):
    if value is None:
        return None
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return None
        try:
            if stripped.lower().startswith("0x"):
                return int(stripped, 16)
            return int(stripped)
        except ValueError:
            return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def format_build_hex(value):
    build = _coerce_build_int(value)
    if build is None or build < 0:
        return None
    return f"0x{build:08X}"


def extract_public_version_from_filename(value):
    if not value:
        return None
    normalized = str(value).strip().split("?")[0].rstrip("/")
    filename = normalized.split("/")[-1]
    match = _VERSION_IN_FILENAME_RE.search(filename)
    if not match:
        return None
    return match.group(1)


def derive_vzm32sn_public_version(value):
    build = _coerce_build_int(value)
    if build is None or build < 0 or build > 0xFFFFFFFF:
        return None
    return f"{(build >> 8) & 0xFF}.{build & 0xFF:02d}"


def parse_ota_file_version(raw_bytes):
    if not isinstance(raw_bytes, (bytes, bytearray)) or len(raw_bytes) < 16:
        return None
    return int.from_bytes(raw_bytes[12:16], byteorder="little", signed=False)


def _extract_track_hint(value):
    normalized = str(value or "").strip().lower()
    if not normalized:
        return None
    if "beta" in normalized:
        return "Beta"
    if "production" in normalized or "stable" in normalized or "release" in normalized:
        return "Production"
    return None


def _build_entry(build, display_version=None, track=None, file_name=None, source_name=None, source_url=None, match_kind="exact", source_priority=0):
    build_int = _coerce_build_int(build)
    if build_int is None:
        return None
    return {
        "build": str(build_int),
        "raw_hex": format_build_hex(build_int),
        "display_version": display_version,
        "track": track,
        "file_name": file_name,
        "source_name": source_name,
        "source_url": source_url,
        "match_kind": match_kind,
        "exact_match": match_kind == "exact",
        "source_priority": int(source_priority or 0),
        "alias_versions": [],
    }


def _merge_reference_entry(entries_by_build, entry):
    if not isinstance(entry, dict):
        return
    build = _coerce_build_int(entry.get("build"))
    if build is None:
        return

    current = entries_by_build.get(build)
    if current is None:
        entries_by_build[build] = copy.deepcopy(entry)
        return

    incoming = copy.deepcopy(entry)
    if incoming.get("display_version") and incoming.get("display_version") != current.get("display_version"):
        alias_versions = set(current.get("alias_versions") or [])
        if current.get("display_version"):
            alias_versions.add(current["display_version"])
        if incoming.get("display_version"):
            alias_versions.add(incoming["display_version"])
        incoming["alias_versions"] = sorted(alias_versions)

    keep_incoming = int(incoming.get("source_priority") or 0) > int(current.get("source_priority") or 0)
    primary = incoming if keep_incoming else current
    secondary = current if keep_incoming else incoming

    merged = copy.deepcopy(primary)
    for key in ("display_version", "track", "file_name", "source_name", "source_url", "raw_hex"):
        if not merged.get(key):
            merged[key] = secondary.get(key)

    alias_versions = set(merged.get("alias_versions") or [])
    alias_versions.update(secondary.get("alias_versions") or [])
    primary_display = merged.get("display_version")
    if primary_display in alias_versions:
        alias_versions.remove(primary_display)
    merged["alias_versions"] = sorted(alias_versions)
    entries_by_build[build] = merged


def _load_zigbee_ota_entries():
    entries = []
    for index_url in ZIGBEE_OTA_INDEX_URLS:
        data = _http_get_json(index_url)
        if not isinstance(data, list):
            continue
        for item in data:
            if not isinstance(item, dict):
                continue
            markers = (
                item.get("modelId"),
                item.get("fileName"),
                item.get("url"),
                item.get("originalUrl"),
                item.get("otaHeaderString"),
            )
            if not any("VZM32-SN" in str(marker or "") for marker in markers):
                continue
            entry = _build_entry(
                build=item.get("fileVersion"),
                display_version=extract_public_version_from_filename(item.get("fileName") or item.get("originalUrl")),
                track=_extract_track_hint(item.get("originalUrl") or item.get("fileName")),
                file_name=item.get("fileName"),
                source_name="Inovelli OTA file",
                source_url=item.get("originalUrl") or item.get("url"),
                source_priority=20,
            )
            if entry:
                entries.append(entry)
    return entries


def _load_inovelli_repo_entries():
    data = _http_get_json(INOVELLI_FIRMWARE_TREE_URL)
    tree = data.get("tree") if isinstance(data, dict) else []
    entries = []
    if not isinstance(tree, list):
        return entries

    for item in tree:
        if not isinstance(item, dict):
            continue
        path = str(item.get("path") or "")
        if "Blue-Series/Zigbee/VZM32-SN-MMWave-Switch" not in path:
            continue
        if item.get("type") != "blob" or not path.lower().endswith(".ota"):
            continue
        raw_url = f"{INOVELLI_FIRMWARE_RAW_ROOT}{path}"
        build = parse_ota_file_version(_http_get_bytes(raw_url))
        entry = _build_entry(
            build=build,
            display_version=extract_public_version_from_filename(path),
            track=_extract_track_hint(path),
            file_name=path.split("/")[-1],
            source_name="Inovelli firmware file",
            source_url=f"https://github.com/InovelliUSA/Firmware/tree/main/{path.rsplit('/', 1)[0]}",
            source_priority=30,
        )
        if entry:
            entries.append(entry)
    return entries


def _load_inovelli_help_versions():
    html = _http_get_text(VZM32SN_HELP_URL)
    versions = {}
    for track, version in _CURRENT_VERSION_RE.findall(html):
        normalized_track = str(track or "").strip().title()
        versions[normalized_track] = str(version).strip()
    return versions


def _load_inovelli_community_entries():
    data = _http_get_json(VZM32SN_COMMUNITY_JSON_URL)
    entries = []
    posts = data.get("post_stream", {}).get("posts", []) if isinstance(data, dict) else []
    for post in posts:
        if not isinstance(post, dict):
            continue
        cooked = str(post.get("cooked") or "")
        track = "Beta" if "Beta" in cooked else None
        for version, hex_build in _COMMUNITY_VERSION_RE.findall(cooked):
            entry = _build_entry(
                build=int(hex_build, 16),
                display_version=version,
                track=track,
                source_name="Inovelli community changelog",
                source_url=VZM32SN_COMMUNITY_URL,
                source_priority=40,
            )
            if entry:
                entries.append(entry)
    return entries


def _build_reference_data():
    entries_by_build = {}
    current_versions = {}
    source_status = {}

    loaders = (
        ("zigbee_ota_catalog", _load_zigbee_ota_entries),
        ("inovelli_repo", _load_inovelli_repo_entries),
        ("inovelli_help", _load_inovelli_help_versions),
        ("inovelli_community", _load_inovelli_community_entries),
    )

    for source_key, loader in loaders:
        try:
            loaded = loader()
            if source_key == "inovelli_help":
                if isinstance(loaded, dict):
                    current_versions.update(loaded)
                source_status[source_key] = "ok"
                continue
            if isinstance(loaded, list):
                for entry in loaded:
                    _merge_reference_entry(entries_by_build, entry)
            source_status[source_key] = "ok"
        except Exception as exc:
            source_status[source_key] = f"{type(exc).__name__}: {exc}"

    for build, entry in list(entries_by_build.items()):
        version = entry.get("display_version")
        if not version:
            continue
        for track, current_version in current_versions.items():
            if current_version == version and not entry.get("track"):
                entry["track"] = track

    return {
        "entries": entries_by_build,
        "current_versions": current_versions,
        "sources": source_status,
        "fetched_at": time.time(),
    }


def get_vzm32sn_reference_data(allow_network=True, force_refresh=False):
    cache_key = "vzm32sn"
    now = time.time()

    with _CACHE_LOCK:
        cached = _REFERENCE_CACHE.get(cache_key)
        if (
            not force_refresh
            and cached
            and now < float(cached.get("expires_at") or 0)
        ):
            return copy.deepcopy(cached["data"])

    if not allow_network:
        with _CACHE_LOCK:
            cached = _REFERENCE_CACHE.get(cache_key)
            if cached:
                return copy.deepcopy(cached["data"])
        return {"entries": {}, "current_versions": {}, "sources": {}, "fetched_at": None}

    data = _build_reference_data()
    with _CACHE_LOCK:
        _REFERENCE_CACHE[cache_key] = {
            "data": copy.deepcopy(data),
            "expires_at": now + REFERENCE_CACHE_TTL_SECONDS,
        }
    return data


def resolve_vzm32sn_firmware_reference(build_value, allow_network=True, reference_data=None):
    build = _coerce_build_int(build_value)
    if build is None:
        return None

    data = reference_data if isinstance(reference_data, dict) else get_vzm32sn_reference_data(allow_network=allow_network)
    entries = data.get("entries") if isinstance(data, dict) else {}
    current_versions = data.get("current_versions") if isinstance(data, dict) else {}
    current_versions = current_versions if isinstance(current_versions, dict) else {}

    detail = {
        "build": str(build),
        "raw_hex": format_build_hex(build),
        "display_version": None,
        "track": None,
        "file_name": None,
        "source_name": None,
        "source_url": None,
        "match_kind": "raw",
        "exact_match": False,
        "alias_versions": [],
    }

    exact = entries.get(build) if isinstance(entries, dict) else None
    if isinstance(exact, dict):
        resolved = copy.deepcopy(exact)
        resolved.setdefault("build", str(build))
        resolved.setdefault("raw_hex", format_build_hex(build))
        resolved.setdefault("match_kind", "exact")
        resolved.setdefault("exact_match", True)
        if not resolved.get("track") and resolved.get("display_version"):
            for track, version in current_versions.items():
                if version == resolved.get("display_version"):
                    resolved["track"] = track
                    break
        return resolved

    derived_version = derive_vzm32sn_public_version(build)
    if derived_version:
        detail["display_version"] = derived_version
        detail["match_kind"] = "derived"
        for track, version in current_versions.items():
            if version == derived_version:
                detail["track"] = track
                detail["source_name"] = "Inovelli help center"
                detail["source_url"] = VZM32SN_HELP_URL
                detail["match_kind"] = "derived_current"
                break
        if not detail.get("source_name"):
            detail["source_name"] = "Derived from OTA build"

    return detail
