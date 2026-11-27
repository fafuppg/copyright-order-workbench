"""Reconnect a local-only SSH forward to the existing cloud MySQL."""
import json
import os
import select
import signal
import socketserver
import threading
import time
from pathlib import Path

import paramiko

ROOT = Path(__file__).resolve().parent.parent


class ForwardHandler(socketserver.BaseRequestHandler):
    def handle(self):
        transport = self.server.tunnel.transport
        if transport is None or not transport.is_active():
            return
        try:
            channel = transport.open_channel(
                'direct-tcpip', ('127.0.0.1', 3306),
                self.request.getpeername(), timeout=8,
            )
            if channel is None:
                return
            self.request.settimeout(15)
            channel.settimeout(15)
            with channel:
                while transport.is_active() and not self.server.tunnel.stopped.is_set():
                    ready, _, _ = select.select([self.request, channel], [], [], 5)
                    if self.request in ready:
                        data = self.request.recv(65536)
                        if not data:
                            break
                        channel.sendall(data)
                    if channel in ready:
                        data = channel.recv(65536)
                        if not data:
                            break
                        self.request.sendall(data)
        except (OSError, EOFError, paramiko.SSHException):
            # Failed SQL requests are reported, never replayed here.
            pass


class ForwardServer(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True


class ReconnectingTunnel:
    def __init__(self, cfg, known_hosts, port=13316, *, connector=None,
                 probe_interval=20, probe_timeout=8, retry_limit=15):
        self.cfg = cfg
        self.known_hosts = known_hosts
        self.port = port
        self.connector = connector or self.connect
        self.probe_interval = probe_interval
        self.probe_timeout = probe_timeout
        self.retry_limit = retry_limit
        self.stopped = threading.Event()
        self.ready = threading.Event()
        self.transport = None
        self.server = None

    def connect(self):
        client = paramiko.SSHClient()
        try:
            client.load_host_keys(str(self.known_hosts))
            client.connect(
                self.cfg['host'], username=self.cfg['user'],
                password=self.cfg['password'], timeout=15,
                banner_timeout=15, auth_timeout=15, channel_timeout=8,
                allow_agent=False, look_for_keys=False,
            )
            return client
        except BaseException:
            client.close()
            raise

    def probe(self, transport):
        """Require a bounded SSH reply, including after sleep and network changes."""
        result = threading.Event()
        errors = []

        def request():
            try:
                transport.global_request('keepalive@openssh.com', wait=True)
            except (OSError, EOFError, paramiko.SSHException) as error:
                errors.append(error)
            finally:
                result.set()

        threading.Thread(target=request, daemon=True).start()
        deadline = time.monotonic() + self.probe_timeout
        while not result.wait(min(.05, max(0, deadline - time.monotonic()))):
            if self.stopped.is_set():
                raise InterruptedError('SSH probe stopped')
            if time.monotonic() >= deadline:
                raise OSError('SSH heartbeat did not respond')
        if self.stopped.is_set():
            raise InterruptedError('SSH probe stopped')
        if errors or not transport.is_active():
            raise OSError('SSH heartbeat did not respond')

    def connect_interruptibly(self):
        """Stop promptly even if TCP connect or SSH authentication is blocked.

        The worker owns a late connection until it is handed to run(). It closes
        any connection completed after shutdown instead of leaking it.
        """
        done = threading.Event()
        lock = threading.Lock()
        outcome = {}

        def connect():
            try:
                client = self.connector()
                with lock:
                    if self.stopped.is_set():
                        client.close()
                    else:
                        outcome['client'] = client
            except BaseException as error:
                with lock:
                    outcome['error'] = error
            finally:
                done.set()

        threading.Thread(target=connect, daemon=True).start()
        while not done.wait(.05):
            if self.stopped.is_set():
                break
        with lock:
            client = outcome.pop('client', None)
            if self.stopped.is_set():
                if client is not None:
                    client.close()
                return None
            if 'error' in outcome:
                raise outcome['error']
            return client

    def stop(self):
        self.stopped.set()

    def run(self):
        delay = 1
        try:
            while not self.stopped.is_set():
                client = None
                try:
                    client = self.connect_interruptibly()
                    if client is None:
                        break
                    transport = client.get_transport()
                    if transport is None or not transport.is_active():
                        raise OSError('SSH is not connected')
                    self.probe(transport)
                    if self.stopped.is_set():
                        break
                    # Bind after authentication. Keep this listener while reconnecting.
                    if self.server is None:
                        self.server = ForwardServer(('127.0.0.1', self.port), ForwardHandler)
                        self.server.tunnel = self
                        threading.Thread(target=self.server.serve_forever, daemon=True).start()
                    self.transport = transport
                    self.ready.set()
                    delay = 1
                    print('云端数据库通道已连接，断线后将自动重连。', flush=True)
                    while not self.stopped.wait(self.probe_interval):
                        self.probe(transport)
                except (paramiko.AuthenticationException, paramiko.BadHostKeyException):
                    print('云端连接身份验证失败，请检查连接配置。', flush=True)
                    raise
                except (OSError, EOFError, paramiko.SSHException) as error:
                    if isinstance(error, OSError) and error.errno in (48, 98):
                        # Another instance owns this port; do not fight it.
                        raise
                    if not self.stopped.is_set():
                        print('云端连接中断，%s 秒后自动重试（%s）。' %
                              (delay, type(error).__name__), flush=True)
                finally:
                    self.ready.clear()
                    self.transport = None
                    if client is not None:
                        client.close()
                if self.stopped.wait(delay):
                    break
                delay = min(delay * 2, self.retry_limit)
        finally:
            if self.server is not None:
                self.server.shutdown()
                self.server.server_close()


def main():
    cfg = json.loads((ROOT / '.private/connection.json').read_text())
    tunnel = ReconnectingTunnel(
        cfg, ROOT / '.private/known_hosts', int(os.environ.get('DB_PORT', '13316')),
    )
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: tunnel.stop())
    try:
        tunnel.run()
    except (OSError, paramiko.SSHException) as error:
        print('数据库通道未能启动（%s）。' % type(error).__name__, flush=True)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
