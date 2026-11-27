"""Exercise disconnect/reconnect using real local sockets, without cloud credentials."""
import importlib.util
import socket
import socketserver
import threading
import time
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('workbench_tunnel', Path(__file__).resolve().parents[1] / 'scripts/tunnel.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Echo(socketserver.BaseRequestHandler):
    def handle(self):
        while True:
            data = self.request.recv(1024)
            if not data:
                break
            self.request.sendall(data)


class FakeTransport:
    def __init__(self, address):
        self.address = address
        self.active = True
        self.channels = []
        self.blackhole = False
        self.closed = threading.Event()

    def is_active(self):
        return self.active

    def global_request(self, *args, **kwargs):
        if self.blackhole:
            self.closed.wait(2)
        if not self.active:
            raise OSError('dropped transport')

    def open_channel(self, *args, **kwargs):
        channel = socket.create_connection(self.address, timeout=1)
        self.channels.append(channel)
        return channel

    def get_transport(self):
        return self

    def close(self):
        self.active = False
        self.closed.set()
        for channel in self.channels:
            try:
                channel.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            channel.close()


class ReconnectTests(unittest.TestCase):
    def setUp(self):
        self.echo = socketserver.ThreadingTCPServer(('127.0.0.1', 0), Echo)
        self.echo.daemon_threads = True
        threading.Thread(target=self.echo.serve_forever, daemon=True).start()
        self.clients = []
        self.errors = []

    def tearDown(self):
        if hasattr(self, 'tunnel'):
            self.tunnel.stop()
            self.runner.join(2)
            self.assertFalse(self.runner.is_alive(), 'tunnel must exit without waiting indefinitely')
        self.echo.shutdown()
        self.echo.server_close()
        self.assertEqual(self.errors, [])

    def connect(self):
        client = FakeTransport(self.echo.server_address)
        self.clients.append(client)
        return client

    def start(self, connector=None):
        self.tunnel = module.ReconnectingTunnel({}, None, 0, connector=connector or self.connect,
            probe_interval=.03, probe_timeout=.06, retry_limit=.05)
        def run():
            try:
                self.tunnel.run()
            except Exception as error:
                self.errors.append(error)
        self.runner = threading.Thread(target=run, daemon=True)
        self.runner.start()

    def wait_for(self, check):
        deadline = time.monotonic() + 4
        while time.monotonic() < deadline:
            if check():
                return
            time.sleep(.01)
        self.fail('condition did not recover within bounded wait')

    def echo_once(self, payload):
        with socket.create_connection(self.tunnel.server.server_address, timeout=1) as sock:
            sock.sendall(payload)
            self.assertEqual(sock.recv(1024), payload)

    def test_initial_failure_recovers_and_forwards(self):
        attempts = []
        def connect():
            attempts.append(1)
            if len(attempts) == 1:
                raise OSError('offline')
            return self.connect()
        self.start(connect)
        self.wait_for(self.tunnel.ready.is_set)
        self.echo_once(b'after initial outage')
        self.assertEqual(len(attempts), 2)

    def test_dropped_transport_reconnects_on_same_listener(self):
        self.start()
        self.wait_for(self.tunnel.ready.is_set)
        address = self.tunnel.server.server_address
        self.echo_once(b'before disconnect')
        self.clients[0].close()
        self.wait_for(lambda: len(self.clients) >= 2 and self.tunnel.ready.is_set())
        self.assertEqual(self.tunnel.server.server_address, address)
        self.echo_once(b'after disconnect')

    def test_silent_transport_is_detected_and_replaced(self):
        self.start()
        self.wait_for(self.tunnel.ready.is_set)
        original = self.clients[0]
        original.blackhole = True
        self.wait_for(lambda: len(self.clients) >= 2 and self.tunnel.ready.is_set())
        self.assertTrue(original.closed.is_set())
        self.echo_once(b'after silent network loss')

    def test_stop_interrupts_offline_retry(self):
        attempts = threading.Event()
        def offline():
            attempts.set()
            raise OSError('offline')
        self.start(offline)
        self.assertTrue(attempts.wait(1))
        self.tunnel.stop()
        self.runner.join(1)
        self.assertFalse(self.runner.is_alive())

    def test_stop_interrupts_blocked_heartbeat_and_closes_transport(self):
        self.start()
        self.wait_for(self.tunnel.ready.is_set)
        original = self.clients[0]
        entered = threading.Event()
        def blocked(*args, **kwargs):
            entered.set()
            original.closed.wait(5)
        original.global_request = blocked
        self.tunnel.probe_timeout = 8
        self.assertTrue(entered.wait(1))
        started = time.monotonic()
        self.tunnel.stop()
        self.runner.join(1)
        self.assertFalse(self.runner.is_alive())
        self.assertLess(time.monotonic() - started, 1)
        self.assertTrue(original.closed.is_set())

    def test_stop_interrupts_connect_and_closes_late_connection(self):
        entered = threading.Event()
        release = threading.Event()
        def slow_connect():
            entered.set()
            release.wait(5)
            return self.connect()
        self.start(slow_connect)
        self.assertTrue(entered.wait(1))
        self.tunnel.stop()
        self.runner.join(1)
        self.assertFalse(self.runner.is_alive())
        release.set()
        self.wait_for(lambda: bool(self.clients) and self.clients[0].closed.is_set())
        self.assertIsNone(self.tunnel.server)


if __name__ == '__main__':
    unittest.main()
