#!/usr/bin/env python3
"""Holds the Figma app with --remote-debugging-pipe and relays its CDP pipe on a unix socket, for many clients.

One JSON CDP message a line on the socket; NUL-ended messages on the pipe. Many clients at once:
- each call's id is rewritten to an id of the holder's own, and the reply goes back to the client that sent it,
  with the client's id put back, so two clients may use the same ids;
- a session made by Target.attachToTarget belongs to the client that asked; its events go to that client only;
- an event without a session (Target.targetCreated and the like) goes to every client;
- a client that leaves has its sessions detached, so the app keeps no stale attachments.
The holder opens no tab and closes none: the app's tabs are its user's, one per file.

Settings: FIGMA_HOLDER_APP (the app binary), FIGMACLI_DESKTOP_SOCKET (the socket path)."""
import fcntl, json, os, socket, subprocess, sys, threading, time

APP = os.environ.get('FIGMA_HOLDER_APP', '/Applications/Figma.app/Contents/MacOS/Figma')
SOCK = os.environ.get('FIGMACLI_DESKTOP_SOCKET') or os.path.expanduser('~/.cache/figma-cdp/cdp.sock')
# Chromium reads an id as a 32-bit int and drops a call whose id is larger.
MAX_ID = 2**31 - 1


def log(*a):
    print(time.strftime('%H:%M:%S'), *a, flush=True)


class Router:
    """Who asked what, and who owns which session. Every method runs under the one lock."""

    def __init__(self, write_app):
        self.lock = threading.Lock()
        self.write_app = write_app
        self.next_id = 0
        self.calls = {}      # holder id -> (client, client id, method)
        self.sessions = {}   # sessionId -> client
        self.clients = set()

    def _new_id(self):
        self.next_id = self.next_id % (MAX_ID - 1) + 1
        return self.next_id

    def join(self, client):
        with self.lock:
            self.clients.add(client)

    def leave(self, client):
        with self.lock:
            self.clients.discard(client)
            for ours in [i for i, call in self.calls.items() if call[0] is client]:
                del self.calls[ours]
            owned = [s for s, c in self.sessions.items() if c is client]
            for session in owned:
                del self.sessions[session]
                # Nobody waits for this reply: it is dropped as an unknown id.
                self.write_app({'id': self._new_id(), 'method': 'Target.detachFromTarget', 'params': {'sessionId': session}})

    def from_client(self, client, message):
        with self.lock:
            if 'id' not in message:
                return
            ours = self._new_id()
            self.calls[ours] = (client, message['id'], message.get('method', ''))
            message = dict(message, id=ours)
            self.write_app(message)

    def from_app(self, message):
        """Returns [(client, message)] to send."""
        with self.lock:
            if 'id' in message:
                call = self.calls.pop(message['id'], None)
                if call is None:
                    return []
                client, theirs, method = call
                if method == 'Target.attachToTarget' and 'result' in message:
                    session = message['result'].get('sessionId')
                    if session:
                        self.sessions[session] = client
                return [(client, dict(message, id=theirs))] if client in self.clients else []
            session = message.get('sessionId')
            if message.get('method') == 'Target.detachedFromTarget':
                session = message.get('params', {}).get('sessionId', session)
                owner = self.sessions.pop(session, None)
                return [(owner, message)] if owner in self.clients else []
            if session:
                owner = self.sessions.get(session)
                return [(owner, message)] if owner in self.clients else []
            return [(c, message) for c in self.clients]


class Client:
    def __init__(self, conn):
        self.conn = conn
        self.send_lock = threading.Lock()

    def send(self, message):
        data = json.dumps(message, separators=(',', ':')).encode() + b'\n'
        with self.send_lock:
            try:
                self.conn.sendall(data)
            except OSError:
                pass


def launch():
    to_app_r, to_app_w = os.pipe()
    from_app_r, from_app_w = os.pipe()
    hi = lambda fd: fcntl.fcntl(fd, fcntl.F_DUPFD, 40)
    a, b = hi(to_app_r), hi(from_app_w)

    def pre():
        os.dup2(a, 3)
        os.dup2(b, 4)

    keep = ('HOME', 'USER', 'LOGNAME', 'PATH', 'TMPDIR', 'LANG', 'SHELL')
    env = {k: v for k, v in os.environ.items() if k in keep}
    proc = subprocess.Popen([APP, '--remote-debugging-pipe'], preexec_fn=pre, pass_fds=(3, 4), env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for fd in (to_app_r, from_app_w, a, b):
        os.close(fd)
    return proc, to_app_w, from_app_r


def main():
    proc, to_app, from_app = launch()
    log('figma pid', proc.pid)
    write_lock = threading.Lock()

    def write_app(message):
        data = json.dumps(message, separators=(',', ':')).encode() + b'\0'
        with write_lock:
            os.write(to_app, data)

    router = Router(write_app)

    def pump():
        buf = b''
        while True:
            chunk = os.read(from_app, 1 << 16)
            if not chunk:
                log('app pipe closed')
                os._exit(1)
            buf += chunk
            while b'\0' in buf:
                raw, buf = buf.split(b'\0', 1)
                try:
                    message = json.loads(raw)
                except ValueError:
                    continue
                for client, out in router.from_app(message):
                    client.send(out)

    threading.Thread(target=pump, daemon=True).start()
    os.makedirs(os.path.dirname(SOCK), exist_ok=True)
    if os.path.exists(SOCK):
        os.unlink(SOCK)
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    srv.bind(SOCK)
    os.chmod(SOCK, 0o600)
    srv.listen(64)
    log('listening', SOCK)

    def serve(conn):
        client = Client(conn)
        router.join(client)
        f = conn.makefile('rb')
        try:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    router.from_client(client, json.loads(line))
                except ValueError:
                    continue
        except OSError:
            pass
        finally:
            router.leave(client)
            try:
                conn.close()
            except OSError:
                pass

    while True:
        conn, _ = srv.accept()
        threading.Thread(target=serve, args=(conn,), daemon=True).start()


if __name__ == '__main__':
    main()
