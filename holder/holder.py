#!/usr/bin/env python3
"""Holds the Figma app with --remote-debugging-pipe and relays its CDP pipe on a unix socket.
One JSON CDP message a line on the socket; NUL-ended messages on the pipe. One client at a time."""
import fcntl, os, socket, subprocess, sys, threading, time
APP = '/Applications/Figma.app/Contents/MacOS/Figma'
D = os.path.expanduser('~/.cache/figma-cdp'); os.makedirs(D, exist_ok=True)
SOCK = os.path.join(D, 'cdp.sock')
def log(*a):
    print(time.strftime('%H:%M:%S'), *a, flush=True)
to_app_r, to_app_w = os.pipe(); from_app_r, from_app_w = os.pipe()
hi = lambda fd: fcntl.fcntl(fd, fcntl.F_DUPFD, 40)
a, b = hi(to_app_r), hi(from_app_w)
def pre():
    os.dup2(a, 3); os.dup2(b, 4)
env = {k: v for k, v in os.environ.items() if k in ('HOME', 'USER', 'LOGNAME', 'PATH', 'TMPDIR', 'LANG', 'SHELL')}
proc = subprocess.Popen([APP, '--remote-debugging-pipe'], preexec_fn=pre, pass_fds=(3, 4), env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
for fd in (to_app_r, from_app_w, a, b):
    os.close(fd)
log('figma pid', proc.pid)
client = {'conn': None}; lock = threading.Lock()
def pump():
    buf = b''
    while True:
        chunk = os.read(from_app_r, 1 << 16)
        if not chunk:
            log('app pipe closed'); os._exit(1)
        buf += chunk
        while b'\0' in buf:
            msg, buf = buf.split(b'\0', 1)
            with lock:
                c = client['conn']
            if c:
                try: c.sendall(msg + b'\n')
                except OSError: pass
threading.Thread(target=pump, daemon=True).start()
if os.path.exists(SOCK): os.unlink(SOCK)
srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); srv.bind(SOCK); os.chmod(SOCK, 0o600); srv.listen(4)
log('listening', SOCK)
def serve(conn):
    with lock: client['conn'] = conn
    f = conn.makefile('rb')
    try:
        for line in f:
            line = line.strip()
            if line: os.write(to_app_w, line + b'\0')
    except OSError: pass
    finally:
        with lock:
            if client['conn'] is conn: client['conn'] = None
        try: conn.close()
        except OSError: pass
while True:
    conn, _ = srv.accept()
    threading.Thread(target=serve, args=(conn,), daemon=True).start()
