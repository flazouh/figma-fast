#!/usr/bin/env python3
"""A stand-in for the Figma app under --remote-debugging-pipe: reads NUL-ended CDP calls on fd 3, answers on fd 4.
Every call is answered with its method echoed. Target.attachToTarget makes session S-<n> and then sends an event on
that session; Browser.ping also sends an event with no session, which every client should get."""
import json, os

r, w = 3, 4
n = 0
buf = b''

def send(message):
    os.write(w, json.dumps(message).encode() + b'\0')

while True:
    chunk = os.read(r, 1 << 16)
    if not chunk:
        break
    buf += chunk
    while b'\0' in buf:
        raw, buf = buf.split(b'\0', 1)
        call = json.loads(raw)
        method = call.get('method')
        if method == 'Target.attachToTarget':
            n += 1
            session = 'S-%d' % n
            send({'id': call['id'], 'result': {'sessionId': session}})
            send({'method': 'Page.loadEventFired', 'sessionId': session, 'params': {'target': call['params']['targetId']}})
        else:
            send({'id': call['id'], 'result': {'echo': method, 'params': call.get('params', {})}})
            if method == 'Browser.ping':
                send({'method': 'Target.targetCreated', 'params': {}})
