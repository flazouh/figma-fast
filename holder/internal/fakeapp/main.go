// Command fakeapp stands in for the Figma app under --remote-debugging-pipe in tests: it reads
// NUL-ended CDP calls on fd 3 and answers on fd 4.
//
// Every call is answered with its method echoed. Target.attachToTarget makes session S-<n> and then
// sends an event on that session. Browser.ping also sends an event with no session, which every
// client should get. Target.detachFromTarget also sends a sessionless Fake.detached event naming the
// session, so a test sees the holder detach a leaving client's sessions.
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
)

func main() {
	in := bufio.NewReader(os.NewFile(3, "cdp-in"))
	out := os.NewFile(4, "cdp-out")
	send := func(m map[string]any) {
		data, _ := json.Marshal(m)
		_, _ = out.Write(append(data, 0))
	}
	n := 0
	for {
		raw, err := in.ReadBytes(0)
		if err != nil {
			return
		}
		var call struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Params map[string]any  `json:"params"`
		}
		if json.Unmarshal(raw[:len(raw)-1], &call) != nil {
			continue
		}
		if call.Params == nil {
			call.Params = map[string]any{}
		}
		switch call.Method {
		case "Target.attachToTarget":
			n++
			session := fmt.Sprintf("S-%d", n)
			send(map[string]any{"id": call.ID, "result": map[string]any{"sessionId": session}})
			send(map[string]any{"method": "Page.loadEventFired", "sessionId": session, "params": map[string]any{"target": call.Params["targetId"]}})
		default:
			send(map[string]any{"id": call.ID, "result": map[string]any{"echo": call.Method, "params": call.Params}})
			switch call.Method {
			case "Browser.ping":
				send(map[string]any{"method": "Target.targetCreated", "params": map[string]any{}})
			case "Target.detachFromTarget":
				send(map[string]any{"method": "Fake.detached", "params": call.Params})
			}
		}
	}
}
