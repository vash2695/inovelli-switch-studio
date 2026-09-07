"""Behavioral coverage for command routing, bridge options, and cached selection."""
import json
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from tests.python import test_app_backend as fixtures

app_module = fixtures.app_module


class ReviewRegressionTests(unittest.TestCase):
    setUp = fixtures.AppBackendTests.setUp
    tearDown = fixtures.AppBackendTests.tearDown
    _client = fixtures.AppBackendTests._client
    _client_from_peer = fixtures.AppBackendTests._client_from_peer
    _server_sid = staticmethod(fixtures.AppBackendTests._server_sid)
    _command_results = staticmethod(fixtures.AppBackendTests._command_results)

    @staticmethod
    def mqtt(suffix, payload):
        app_module.on_message(None, None, SimpleNamespace(
            topic=f'zigbee2mqtt/{suffix}', payload=json.dumps(payload).encode('utf-8')))

    @staticmethod
    def inventory_entry(**overrides):
        return {
            'friendly_name': 'device_a', 'ieee_address': '0x1234',
            'interview_state': 'SUCCESSFUL', 'supported': True,
            'definition': {'model': 'VZM32-SN', 'vendor': 'Inovelli', 'exposes': []},
            **overrides,
        }

    def test_maintenance_keeps_explicit_destination_when_navigation_overtakes_dispatch(self):
        client = self._client()
        client.emit('change_device', 'zigbee2mqtt/device_a')
        client.get_received()
        entered, resume = threading.Event(), threading.Event()
        original = app_module.resolve_ready_command_topic

        def delayed_resolve(sid, data=None, **kwargs):
            entered.set()
            if not resume.wait(3):
                raise AssertionError('Navigation did not release command dispatch')
            return original(sid, data, **kwargs)

        with patch.object(app_module, 'resolve_ready_command_topic', side_effect=delayed_resolve), \
                patch.object(app_module, 'publish_json', return_value=(True, 0)) as publish:
            command = threading.Thread(target=client.emit, args=('send_command', {
                'action_id': 3, 'topic': 'zigbee2mqtt/device_a', 'request_id': 'maintenance-a',
            }))
            command.start()
            try:
                self.assertTrue(entered.wait(3))
                client.emit('change_device', 'zigbee2mqtt/device_b')
            finally:
                resume.set()
                command.join(3)
            self.assertFalse(command.is_alive())
            self.assertEqual(publish.call_args.args[0], 'zigbee2mqtt/device_a/set')
        result = self._command_results(client, 'send_command')[-1]
        self.assertEqual((result['topic'], result['request_id']), ('zigbee2mqtt/device_a', 'maintenance-a'))

    def test_maintenance_rejects_implicit_destination(self):
        client = self._client()
        client.emit('change_device', 'zigbee2mqtt/device_b')
        with patch.object(app_module, 'publish_json') as publish:
            for payload in (3, {'action_id': 3}, {'action_id': 3, 'topic': ''}):
                client.emit('send_command', payload)
                self.assertIn('explicit device topic', self._command_results(client, 'send_command')[-1]['message'])
        publish.assert_not_called()

    def test_maintenance_readiness_failure_still_identifies_the_pending_command(self):
        client = self._client()
        app_module.update_mqtt_state(False, 'Disconnected')
        client.emit('send_command', {'action_id': 3, 'topic': 'zigbee2mqtt/device_a', 'request_id': 'offline-maintenance'})
        result = self._command_results(client, 'send_command')[-1]
        self.assertEqual((result['status'], result['topic'], result['request_id']),
                         ('error', 'zigbee2mqtt/device_a', 'offline-maintenance'))

    def test_runtime_options_use_bridge_and_require_matching_response(self):
        client = self._client()
        client.get_received()
        with patch.object(app_module, 'publish_json', return_value=(True, 0)) as publish:
            client.emit('update_parameter', {
                'topic': 'zigbee2mqtt/device_a', 'param': 'power_calibration',
                'value': 10, 'request_id': 'option-one',
            })
        topic, payload = publish.call_args.args[:2]
        self.assertEqual(topic, 'zigbee2mqtt/bridge/request/device/options')
        self.assertEqual(payload['id'], 'device_a')
        self.assertEqual(payload['options'], {'power_calibration': 10})
        self._command_results(client)
        self.mqtt('device_a', {'power_calibration': 10})
        self.assertEqual(self._command_results(client), [])
        response = {'status': 'ok', 'transaction': payload['transaction'],
                    'data': {'id': 'device_a', 'to': {'power_calibration': 10}}}
        self.mqtt('bridge/response/device/options', {**response, 'transaction': 'unrelated'})
        self.mqtt('bridge/response/device/options', {**response, 'data': {**response['data'], 'id': 'device_b'}})
        self.assertEqual(self._command_results(client), [])
        self.mqtt('bridge/response/device/options', response)
        result = self._command_results(client)[-1]
        self.assertEqual((result['status'], result['request_id']), ('confirmed', 'option-one'))
        self.assertEqual(app_module.build_device_snapshot('zigbee2mqtt/device_a')['payload']['last_config']['power_calibration'], 10)

    def test_mixed_batch_waits_for_both_transports_and_accounts_for_two_publications(self):
        client = self._client()
        client.get_received()
        with patch.object(app_module, 'publish_json', return_value=(True, 0)) as publish, \
                patch.object(app_module, 'enforce_command_rate_limit_or_emit', wraps=app_module.enforce_command_rate_limit_or_emit) as rate_limit:
            client.emit('apply_parameters', {'topic': 'zigbee2mqtt/device_a', 'request_id': 'mixed',
                                           'changes': {'power_calibration': 10, 'mmWaveHoldTime': 30}})
        self.assertEqual(rate_limit.call_args.kwargs['cost'], 2)
        device_call, bridge_call = publish.call_args_list
        self.assertEqual(device_call.args[:2], ('zigbee2mqtt/device_a/set', {'mmWaveHoldTime': 30}))
        self.assertEqual(bridge_call.args[1]['options'], {'power_calibration': 10})
        self._command_results(client)
        self.mqtt('bridge/response/device/options', {
            'status': 'ok', 'transaction': bridge_call.args[1]['transaction'],
            'data': {'id': 'device_a', 'to': {'power_calibration': 10}},
        })
        partial = self._command_results(client)[-1]
        self.assertEqual(partial['status'], 'sending')
        self.assertEqual(partial['payload']['unresolved_fields'], ['mmWaveHoldTime'])
        self.mqtt('device_a', {'mmWaveHoldTime': 30})
        self.assertEqual(self._command_results(client)[-1]['status'], 'confirmed')

    def test_option_rejection_keeps_confirmed_device_fields_and_reports_error(self):
        client = self._client()
        client.get_received()
        with patch.object(app_module, 'publish_json', return_value=(True, 0)) as publish:
            client.emit('apply_parameters', {'topic': 'zigbee2mqtt/device_a', 'request_id': 'rejected',
                                           'changes': {'power_calibration': 10, 'mmWaveHoldTime': 30}})
        transaction = publish.call_args.args[1]['transaction']
        self._command_results(client)
        self.mqtt('device_a', {'mmWaveHoldTime': 30})
        self._command_results(client)
        self.mqtt('bridge/response/device/options', {'status': 'error', 'transaction': transaction, 'error': 'Invalid option'})
        result = self._command_results(client)[-1]
        self.assertEqual(result['status'], 'not_confirmed')
        self.assertEqual(result['payload']['confirmed_fields'], ['mmWaveHoldTime'])
        self.assertEqual(result['payload']['unresolved_fields'], ['power_calibration'])
        self.assertIn('Invalid option', result['message'])
        self.assertEqual(len(app_module.pending_writes), 0)

    def test_options_hydrate_in_either_retained_message_order(self):
        config = {'config': {'device_options': {'power_calibration': 5},
                             'devices': {'0x1234': {'friendly_name': 'device_a', 'power_calibration': 10}}}}
        for info_first in (True, False):
            with self.subTest(info_first=info_first):
                with app_module.device_list_lock:
                    app_module.device_list.clear()
                    app_module.device_options_cache.clear()
                messages = [('bridge/info', config), ('bridge/devices', [self.inventory_entry()])]
                for suffix, payload in messages if info_first else reversed(messages):
                    self.mqtt(suffix, payload)
                values = app_module.build_device_snapshot('zigbee2mqtt/device_a')['payload']['last_config']
                self.assertEqual(values['power_calibration'], 10)
                self.assertNotIn('friendly_name', values)

    def test_removed_runtime_option_does_not_leave_a_stale_cached_override(self):
        self.mqtt('bridge/info', {'config': {'devices': {'device_a': {'power_calibration': 10}}}})
        self.mqtt('bridge/info', {'config': {'devices': {'device_a': {}}}})
        values = app_module.build_device_snapshot('zigbee2mqtt/device_a')['payload']['last_config']
        self.assertIsNone(values['power_calibration'])

    def test_option_timeout_and_publish_failure_leave_retryable_results(self):
        client = self._client()
        for request_id, publish_result, expected_status in (
                ('timeout-option', (True, 0), 'not_confirmed'),
                ('failed-option', (False, 4), 'error')):
            with self.subTest(request_id=request_id):
                with patch.object(app_module, 'publish_json', return_value=publish_result):
                    client.emit('apply_parameters', {'topic': 'zigbee2mqtt/device_a', 'request_id': request_id,
                                                   'changes': {'power_calibration': 10}})
                if publish_result[0]:
                    app_module.expire_pending_write(self._server_sid(client), request_id)
                result = self._command_results(client)[-1]
                self.assertEqual(result['status'], expected_status)
                self.assertEqual(result['request_id'], request_id)
                self.assertEqual(len(app_module.pending_writes), 0)

    def test_inventory_exclusions_survive_retained_reports_and_reconnection(self):
        for overrides in ({'disabled': True}, {'supported': False},
                          {'interview_state': None, 'interview_completed': False},
                          {'interview_state': 'PENDING'}, {'interview_state': 'IN_PROGRESS'},
                          {'interview_state': 'FAILED'}):
            with self.subTest(overrides=overrides):
                self.mqtt('bridge/devices', [self.inventory_entry(**overrides)])
                app_module.update_mqtt_state(inventory_ready=False)
                self.mqtt('device_a', {'mmWaveVersion': 1, 'mmWaveTargetInfoReport': 'Enable', 'state': 'ON'})
                self.assertIsNone(app_module.get_device_by_topic('zigbee2mqtt/device_a'))
                self.assertIsNotNone(app_module.get_command_readiness_error('zigbee2mqtt/device_a'))
        self.mqtt('bridge/devices', [self.inventory_entry()])
        self.assertIsNotNone(app_module.get_device_by_topic('zigbee2mqtt/device_a'))

    def test_raw_and_structured_zone_reports_share_latest_snapshot(self):
        structured = {'area2': {'width_min': -120, 'width_max': 240, 'depth_min': 20,
                                'depth_max': 300, 'height_min': -200, 'height_max': 400}}
        self.mqtt('device_a', {'mmwave_detection_areas': structured, 'occupancy': True, 'area1Occupancy': True})
        client = self._client()
        client.get_received()
        client.emit('change_device', 'zigbee2mqtt/device_a')
        events = client.get_received()
        self.assertNotIn('detection_zones', [event['name'] for event in events])
        snap = next(event['args'][0] for event in events if event['name'] == 'device_snapshot')
        self.assertEqual(snap['payload']['last_config']['mmwave_detection_areas'], structured)
        self.assertTrue(snap['payload']['last_config']['occupancy'])
        self.mqtt('device_a', fixtures._raw_zone_packet(3, []))
        snap = app_module.build_device_snapshot('zigbee2mqtt/device_a')
        self.assertEqual(snap['payload']['detection_zones'], [])
        self.assertEqual(snap['payload']['last_config']['mmwave_detection_areas'], {})
        client.get_received()
        client.emit('change_device', 'zigbee2mqtt/device_a')
        cached_zones = next(event['args'][0] for event in client.get_received() if event['name'] == 'detection_zones')
        self.assertTrue(cached_zones['snapshot'])
        self.mqtt('device_a', {'mmwave_detection_areas': structured})
        snap = app_module.build_device_snapshot('zigbee2mqtt/device_a')
        self.assertIsNone(snap['payload']['detection_zones'])
        self.assertEqual(snap['payload']['last_config']['mmwave_detection_areas'], structured)


if __name__ == '__main__':
    unittest.main()
