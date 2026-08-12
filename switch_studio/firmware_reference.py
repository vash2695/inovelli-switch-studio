import copy
import json
import os
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
REFERENCE_RETRY_TTL_SECONDS = 60
HTTP_TIMEOUT_SECONDS = 6
REFERENCE_REFRESH_DEADLINE_SECONDS = 45
MAX_HTTP_RESPONSE_BYTES = 4 * 1024 * 1024
MAX_PERSISTED_CACHE_BYTES = 4 * 1024 * 1024
MAX_REFERENCE_ITEMS = 2048
OTA_HEADER_BYTES = 16
REFERENCE_CACHE_SCHEMA_VERSION = 1
REFERENCE_CACHE_PATH = os.environ.get(
    "SWITCH_STUDIO_FIRMWARE_CACHE_PATH",
    "/data/firmware_reference_v1.json",
)

_CACHE_LOCK = threading.Lock()
_REFERENCE_CACHE = {}
_REFERENCE_REFRESHING = set()
_REFERENCE_REFRESH_EVENTS = {}
_REFRESH_CONTEXT = threading.local()

_VERSION_IN_FILENAME_RE = re.compile(r"_([0-9]+\.[0-9]+)\.ota$", re.IGNORECASE)
_CURRENT_VERSION_RE = re.compile(
    r"Current\s+(Production|Beta)\s+Version:</b>\s*([0-9]+\.[0-9]+)",
    re.IGNORECASE,
)
_COMMUNITY_VERSION_RE = re.compile(
    r"v([0-9]+\.[0-9]+)\s*/\s*0x([0-9A-Fa-f]{8})",
    re.IGNORECASE,
)


def _http_get_bytes(url, max_bytes=None, headers=None):
    limit = MAX_HTTP_RESPONSE_BYTES if max_bytes is None else max(1, int(max_bytes))
    request_headers = {"User-Agent": "SwitchStudio/1.0"}
    request_headers.update(headers or {})
    req = urllib.request.Request(url, headers=request_headers)
    deadline = getattr(_REFRESH_CONTEXT, "deadline", None)
    timeout = HTTP_TIMEOUT_SECONDS
    if deadline is not None:
        remaining = float(deadline) - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("firmware reference refresh deadline exceeded")
        timeout = min(timeout, max(0.1, remaining))
    with urllib.request.urlopen(req, timeout=timeout) as response:
        content_length = response.headers.get("Content-Length")
        if content_length:
            try:
                if int(content_length) > limit and not headers:
                    raise ValueError(f"response exceeds {limit} bytes")
            except (TypeError, ValueError) as exc:
                if isinstance(exc, ValueError) and "exceeds" in str(exc):
                    raise
        payload = response.read(limit + 1)
        if len(payload) > limit:
            raise ValueError(f"response exceeds {limit} bytes")
        return payload


def _http_get_ota_header(url):
    return _http_get_bytes(
        url,
        max_bytes=OTA_HEADER_BYTES,
        headers={"Range": f"bytes=0-{OTA_HEADER_BYTES - 1}"},
    )


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
    errors = []
    for index_url in ZIGBEE_OTA_INDEX_URLS:
        try:
            data = _http_get_json(index_url)
        except Exception as exc:
            errors.append(exc)
            continue
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
            if len(entries) >= MAX_REFERENCE_ITEMS:
                break
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
    if errors and not entries:
        raise errors[-1]
    return entries


def _load_inovelli_repo_entries():
    data = _http_get_json(INOVELLI_FIRMWARE_TREE_URL)
    tree = data.get("tree") if isinstance(data, dict) else []
    entries = []
    if not isinstance(tree, list):
        return entries

    matching_items = 0
    for item in tree:
        if not isinstance(item, dict):
            continue
        path = str(item.get("path") or "")
        if "Blue-Series/Zigbee/VZM32-SN-MMWave-Switch" not in path:
            continue
        if item.get("type") != "blob" or not path.lower().endswith(".ota"):
            continue
        matching_items += 1
        if matching_items > MAX_REFERENCE_ITEMS:
            break
        raw_url = f"{INOVELLI_FIRMWARE_RAW_ROOT}{path}"
        try:
            build = parse_ota_file_version(_http_get_ota_header(raw_url))
        except Exception:
            continue
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
    for post in posts[:MAX_REFERENCE_ITEMS]:
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


def _build_reference_data(previous_data=None):
    previous_data = previous_data if isinstance(previous_data, dict) else {}
    previous_contributions = previous_data.get("source_data")
    previous_contributions = previous_contributions if isinstance(previous_contributions, dict) else {}
    source_contributions = copy.deepcopy(previous_contributions)
    source_status = {}
    attempt_at = time.time()

    loaders = (
        ("zigbee_ota_catalog", _load_zigbee_ota_entries),
        ("inovelli_repo", _load_inovelli_repo_entries),
        ("inovelli_help", _load_inovelli_help_versions),
        ("inovelli_community", _load_inovelli_community_entries),
    )

    prior_deadline = getattr(_REFRESH_CONTEXT, "deadline", None)
    _REFRESH_CONTEXT.deadline = time.monotonic() + REFERENCE_REFRESH_DEADLINE_SECONDS
    try:
        for source_key, loader in loaders:
            try:
                loaded = loader()
                if not loaded:
                    raise ValueError("source returned no usable firmware reference data")
                if source_key == "inovelli_help":
                    if not isinstance(loaded, dict):
                        raise ValueError("source returned invalid version data")
                    source_contributions[source_key] = copy.deepcopy(loaded)
                    source_status[source_key] = {
                        "status": "ok",
                        "error": None,
                        "fetched_at": attempt_at,
                        "stale": False,
                    }
                    continue
                if not isinstance(loaded, list):
                    raise ValueError("source returned invalid entry data")
                source_contributions[source_key] = copy.deepcopy(loaded[:MAX_REFERENCE_ITEMS])
                source_status[source_key] = {
                    "status": "ok",
                    "error": None,
                    "fetched_at": attempt_at,
                    "stale": False,
                }
            except Exception as exc:
                previous_health = (previous_data.get("sources") or {}).get(source_key, {})
                source_status[source_key] = {
                    "status": "stale" if source_key in source_contributions else "error",
                    "error": f"{type(exc).__name__}: {exc}",
                    "fetched_at": (
                        previous_health.get("fetched_at")
                        if isinstance(previous_health, dict)
                        else previous_data.get("fetched_at")
                    ),
                    "stale": source_key in source_contributions,
                }
    finally:
        if prior_deadline is None:
            try:
                del _REFRESH_CONTEXT.deadline
            except AttributeError:
                pass
        else:
            _REFRESH_CONTEXT.deadline = prior_deadline

    entries_by_build = {}
    current_versions = {}
    help_versions = source_contributions.get("inovelli_help")
    if isinstance(help_versions, dict):
        current_versions.update(help_versions)
    for source_key in ("zigbee_ota_catalog", "inovelli_repo", "inovelli_community"):
        contribution = source_contributions.get(source_key)
        if isinstance(contribution, list):
            for entry in contribution[:MAX_REFERENCE_ITEMS]:
                _merge_reference_entry(entries_by_build, entry)

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
        "source_data": source_contributions,
        "fetched_at": attempt_at,
    }


def _has_reference_content(data):
    if not isinstance(data, dict):
        return False
    entries = data.get("entries")
    current_versions = data.get("current_versions")
    return bool(
        (isinstance(entries, dict) and entries)
        or (isinstance(current_versions, dict) and current_versions)
    )


def _reference_error_summary(data):
    sources = data.get("sources") if isinstance(data, dict) else {}
    if not isinstance(sources, dict):
        return None
    failures = []
    for source, health in sources.items():
        if isinstance(health, dict):
            if health.get("status") != "ok":
                failures.append(f"{source}: {health.get('error') or health.get('status')}")
        elif health != "ok":
            failures.append(f"{source}: {health}")
    return "; ".join(failures) if failures else None


def _decorate_reference_data(
    data,
    status=None,
    stale=False,
    refreshing=False,
    generation=0,
    last_attempt_at=None,
    error=None,
    retry_at=None,
):
    decorated = copy.deepcopy(data) if isinstance(data, dict) else {}
    decorated.setdefault("entries", {})
    decorated.setdefault("current_versions", {})
    decorated.setdefault("sources", {})
    decorated.setdefault("fetched_at", None)
    decorated.pop("source_data", None)
    if status is None:
        if _has_reference_content(decorated):
            status = "partial" if _reference_error_summary(decorated) else "ready"
        else:
            status = "unavailable"
    decorated["reference_status"] = status
    decorated["reference_stale"] = bool(stale)
    decorated["reference_refreshing"] = bool(refreshing)
    decorated["generation"] = max(0, int(generation or 0))
    decorated["reference_error"] = error if error is not None else _reference_error_summary(decorated)
    decorated["last_attempt_at"] = last_attempt_at
    decorated["retry_at"] = retry_at
    return decorated


def _cache_entry_snapshot(entry, now=None, status=None, refreshing=False):
    now = time.time() if now is None else now
    entry = entry if isinstance(entry, dict) else {}
    expires_at = float(entry.get("expires_at") or 0)
    has_content = _has_reference_content(entry.get("data"))
    effective_status = status or entry.get("status")
    return _decorate_reference_data(
        entry.get("data"),
        status=effective_status,
        stale=has_content and (effective_status == "stale" or now >= expires_at),
        refreshing=refreshing,
        generation=entry.get("generation"),
        last_attempt_at=entry.get("last_attempt_at"),
        error=entry.get("last_error"),
        retry_at=expires_at or None,
    )


def _persist_cache_entry(entry, cache_path=None):
    path = cache_path if cache_path is not None else REFERENCE_CACHE_PATH
    if not path or not isinstance(entry, dict) or not _has_reference_content(entry.get("data")):
        return False
    payload = {
        "schema_version": REFERENCE_CACHE_SCHEMA_VERSION,
        "cache_key": "vzm32sn",
        "entry": copy.deepcopy(entry),
    }
    parent = os.path.dirname(os.path.abspath(path))
    temp_path = f"{path}.tmp-{os.getpid()}-{threading.get_ident()}"
    try:
        os.makedirs(parent, exist_ok=True)
        with open(temp_path, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, allow_nan=False, separators=(",", ":"))
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, path)
        return True
    except (OSError, TypeError, ValueError):
        try:
            if os.path.exists(temp_path):
                os.remove(temp_path)
        except OSError:
            pass
        return False


def _load_persisted_cache(cache_path=None):
    path = cache_path if cache_path is not None else REFERENCE_CACHE_PATH
    if not path:
        return None
    try:
        with open(path, "rb") as handle:
            raw = handle.read(MAX_PERSISTED_CACHE_BYTES + 1)
        if len(raw) > MAX_PERSISTED_CACHE_BYTES:
            return None
        payload = json.loads(raw.decode("utf-8"))
        if not isinstance(payload, dict) or payload.get("schema_version") != REFERENCE_CACHE_SCHEMA_VERSION:
            return None
        if payload.get("cache_key") != "vzm32sn":
            return None
        entry = payload.get("entry")
        if not isinstance(entry, dict) or not _has_reference_content(entry.get("data")):
            return None
        generation = entry.get("generation")
        if isinstance(generation, bool) or not isinstance(generation, int) or generation < 1:
            return None
        if entry.get("status") not in {"ready", "partial", "stale"}:
            return None
        try:
            entry["expires_at"] = float(entry.get("expires_at") or 0)
        except (TypeError, ValueError):
            return None
        data = entry.get("data")
        serialized_entries = data.get("entries") if isinstance(data, dict) else None
        if isinstance(serialized_entries, dict):
            normalized_entries = {}
            for build_key, value in list(serialized_entries.items())[:MAX_REFERENCE_ITEMS]:
                build = _coerce_build_int(build_key)
                if build is not None and isinstance(value, dict):
                    normalized_entries[build] = value
            data["entries"] = normalized_entries
        return copy.deepcopy(entry)
    except (OSError, ValueError, TypeError):
        return None


def initialize_vzm32sn_reference_cache(cache_path=None):
    entry = _load_persisted_cache(cache_path)
    if not entry:
        return False
    with _CACHE_LOCK:
        _REFERENCE_CACHE["vzm32sn"] = entry
    return True


def _run_vzm32sn_refresh(cache_key, refresh_event):
    terminal_entry = None
    try:
        with _CACHE_LOCK:
            previous = copy.deepcopy(_REFERENCE_CACHE.get(cache_key) or {})
        previous_data = previous.get("data") if isinstance(previous, dict) else None
        data = _build_reference_data(previous_data=previous_data)
        attempt_at = time.time()
        has_content = _has_reference_content(data)
        error = _reference_error_summary(data)
        sources = data.get("sources") if isinstance(data, dict) else {}
        source_health = list(sources.values()) if isinstance(sources, dict) else []
        all_sources_ok = bool(source_health) and all(
            (health.get("status") if isinstance(health, dict) else health) == "ok"
            for health in source_health
        )
        any_source_ok = any(
            (health.get("status") if isinstance(health, dict) else health) == "ok"
            for health in source_health
        )
        accepted_content = has_content and any_source_ok

        with _CACHE_LOCK:
            latest = _REFERENCE_CACHE.get(cache_key) or previous
            previous_generation = int((latest or {}).get("generation") or 0)
            # This counter versions the complete user-visible reference state,
            # including a failed attempt becoming stale/unavailable. Advancing
            # it for every completed attempt prevents an older equal-generation
            # "fresh" event from hiding a later failure warning in the browser.
            generation = previous_generation + 1
            if accepted_content:
                status = "ready" if all_sources_ok else "partial"
                ttl = REFERENCE_CACHE_TTL_SECONDS if all_sources_ok else REFERENCE_RETRY_TTL_SECONDS
                terminal_entry = {
                    "data": copy.deepcopy(data),
                    "status": status,
                    "expires_at": attempt_at + ttl,
                    "last_attempt_at": attempt_at,
                    "last_error": error,
                    "generation": generation,
                }
            elif _has_reference_content((latest or {}).get("data")) or has_content:
                retained_data = (
                    data
                    if has_content
                    else (latest or {}).get("data")
                )
                terminal_entry = {
                    **copy.deepcopy(latest),
                    "data": copy.deepcopy(retained_data),
                    "status": "stale",
                    "expires_at": attempt_at + REFERENCE_RETRY_TTL_SECONDS,
                    "last_attempt_at": attempt_at,
                    "last_error": error or "Firmware reference sources returned no usable data",
                    "generation": generation,
                }
            else:
                terminal_entry = {
                    "data": copy.deepcopy(data),
                    "status": "unavailable",
                    "expires_at": attempt_at + REFERENCE_RETRY_TTL_SECONDS,
                    "last_attempt_at": attempt_at,
                    "last_error": error or "Firmware reference sources returned no usable data",
                    "generation": generation,
                }

        if accepted_content:
            _persist_cache_entry(terminal_entry)
    except Exception as exc:
        attempt_at = time.time()
        with _CACHE_LOCK:
            previous = _REFERENCE_CACHE.get(cache_key) or {}
            terminal_entry = {
                **copy.deepcopy(previous),
                "data": copy.deepcopy(previous.get("data") or {}),
                "status": "stale" if _has_reference_content(previous.get("data")) else "unavailable",
                "expires_at": attempt_at + REFERENCE_RETRY_TTL_SECONDS,
                "last_attempt_at": attempt_at,
                "last_error": f"{type(exc).__name__}: {exc}",
                "generation": int(previous.get("generation") or 0) + 1,
            }
    finally:
        with _CACHE_LOCK:
            if terminal_entry is not None:
                _REFERENCE_CACHE[cache_key] = terminal_entry
            _REFERENCE_REFRESHING.discard(cache_key)
            _REFERENCE_REFRESH_EVENTS.pop(cache_key, None)
        refresh_event.set()


def _start_vzm32sn_refresh(force_refresh=False):
    cache_key = "vzm32sn"
    now = time.time()
    with _CACHE_LOCK:
        cached = _REFERENCE_CACHE.get(cache_key)
        if cache_key in _REFERENCE_REFRESHING:
            return _REFERENCE_REFRESH_EVENTS.get(cache_key), None
        if not force_refresh and cached and now < float(cached.get("expires_at") or 0):
            return None, None
        refresh_event = threading.Event()
        start_entry = copy.deepcopy(cached) if isinstance(cached, dict) else {
            "data": {},
            "expires_at": 0,
            "last_error": None,
        }
        start_entry["status"] = "refreshing"
        start_entry["last_attempt_at"] = now
        start_entry["generation"] = int(start_entry.get("generation") or 0) + 1
        _REFERENCE_CACHE[cache_key] = start_entry
        _REFERENCE_REFRESHING.add(cache_key)
        _REFERENCE_REFRESH_EVENTS[cache_key] = refresh_event
        start_snapshot = _cache_entry_snapshot(
            start_entry,
            now=now,
            status="refreshing",
            refreshing=True,
        )
    worker = threading.Thread(
        target=_run_vzm32sn_refresh,
        args=(cache_key, refresh_event),
        name="firmware-reference-refresh",
        daemon=True,
    )
    try:
        worker.start()
    except Exception as exc:
        failed_at = time.time()
        with _CACHE_LOCK:
            started = _REFERENCE_CACHE.get(cache_key) or start_entry
            _REFERENCE_CACHE[cache_key] = {
                **copy.deepcopy(started),
                "status": "stale" if _has_reference_content(started.get("data")) else "unavailable",
                "expires_at": failed_at + REFERENCE_RETRY_TTL_SECONDS,
                "last_attempt_at": failed_at,
                "last_error": f"{type(exc).__name__}: {exc}",
                "generation": int(started.get("generation") or 0) + 1,
            }
            _REFERENCE_REFRESHING.discard(cache_key)
            _REFERENCE_REFRESH_EVENTS.pop(cache_key, None)
        refresh_event.set()
        start_snapshot = None
    return refresh_event, start_snapshot


def get_vzm32sn_reference_data(allow_network=True, force_refresh=False):
    cache_key = "vzm32sn"
    start_snapshot = None
    if allow_network:
        _, start_snapshot = _start_vzm32sn_refresh(force_refresh=force_refresh)
    if start_snapshot is not None:
        # Return the exact accepted start transition even if an unusually fast
        # worker has already committed its terminal transition concurrently.
        return start_snapshot
    with _CACHE_LOCK:
        cached = copy.deepcopy(_REFERENCE_CACHE.get(cache_key) or {})
        refreshing = cache_key in _REFERENCE_REFRESHING
    if cached:
        return _cache_entry_snapshot(cached, refreshing=refreshing)
    return _decorate_reference_data(
        None,
        status="refreshing" if refreshing else "unavailable",
        refreshing=refreshing,
    )


def refresh_vzm32sn_reference_data(force_refresh=False):
    refresh_event, _ = _start_vzm32sn_refresh(force_refresh=force_refresh)
    if refresh_event is not None:
        refresh_event.wait()
    return get_vzm32sn_reference_data(allow_network=False)


# Persistence is loaded once, before MQTT or Socket.IO hot paths can request a
# snapshot. Missing, corrupt, and read-only add-on data directories are safe.
initialize_vzm32sn_reference_cache()


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
