// Package holder relays the Figma app's CDP pipe on a unix socket, for many clients at once.
//
// One JSON CDP message a line on the socket; NUL-ended messages on the pipe.
//   - Each call's id is rewritten to an id of the holder's own, and the reply goes back to the client
//     that sent it with the client's id put back, so two clients may use the same ids.
//   - A session made by Target.attachToTarget belongs to the client that asked; its events go to that
//     client only.
//   - An event without a session (Target.targetCreated and the like) goes to every client.
//   - A client that leaves has its sessions detached, so the app keeps no stale attachments.
//
// The holder opens no tab and closes none: the app's tabs are its user's, one per file.
package holder

import (
	"encoding/json"
	"sync"
)

// MaxID is the largest id the holder sends: Chromium reads an id as a 32-bit int and drops a call
// whose id is larger.
const MaxID = 1<<31 - 1

// Message is one CDP message with its fields kept as they came, so only the id is rewritten.
type Message map[string]json.RawMessage

// Client is where the router sends a message. The router compares clients by identity.
type Client interface {
	Send(Message)
}

type call struct {
	client Client
	theirs json.RawMessage
	method string
}

// Delivery is one message for one client.
type Delivery struct {
	Client  Client
	Message Message
}

// Router knows who asked what and who owns which session. Every method runs under its one lock.
type Router struct {
	mu       sync.Mutex
	writeApp func(Message)
	nextID   int64
	calls    map[int64]call
	sessions map[string]Client
	clients  map[Client]bool
}

// NewRouter makes a router that writes calls to the app with writeApp. writeApp runs under the
// router's lock, so calls reach the app in the order the router numbered them.
func NewRouter(writeApp func(Message)) *Router {
	return &Router{writeApp: writeApp, calls: map[int64]call{}, sessions: map[string]Client{}, clients: map[Client]bool{}}
}

func (r *Router) newID() int64 {
	r.nextID = r.nextID%(MaxID-1) + 1
	return r.nextID
}

// Join adds a client.
func (r *Router) Join(c Client) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.clients[c] = true
}

// Leave drops a client and its calls in flight, and detaches every session it owns.
func (r *Router) Leave(c Client) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.clients, c)
	for id, pending := range r.calls {
		if pending.client == c {
			delete(r.calls, id)
		}
	}
	for session, owner := range r.sessions {
		if owner != c {
			continue
		}
		delete(r.sessions, session)
		params, _ := json.Marshal(map[string]string{"sessionId": session})
		// Nobody waits for this reply: it comes back with an unknown id and is dropped.
		r.writeApp(Message{"id": rawInt(r.newID()), "method": json.RawMessage(`"Target.detachFromTarget"`), "params": params})
	}
}

// FromClient numbers a client's call with an id of the holder's own and writes it to the app.
// A message with no id is not a call and is dropped.
func (r *Router) FromClient(c Client, m Message) {
	r.mu.Lock()
	defer r.mu.Unlock()
	theirs, ok := m["id"]
	if !ok {
		return
	}
	var method string
	_ = json.Unmarshal(m["method"], &method)
	ours := r.newID()
	r.calls[ours] = call{client: c, theirs: theirs, method: method}
	out := make(Message, len(m))
	for k, v := range m {
		out[k] = v
	}
	out["id"] = rawInt(ours)
	r.writeApp(out)
}

// FromApp says which clients get a message from the app.
func (r *Router) FromApp(m Message) []Delivery {
	r.mu.Lock()
	defer r.mu.Unlock()
	if rawID, ok := m["id"]; ok {
		var id int64
		if json.Unmarshal(rawID, &id) != nil {
			return nil
		}
		pending, found := r.calls[id]
		if !found {
			return nil
		}
		delete(r.calls, id)
		if pending.method == "Target.attachToTarget" {
			if session := sessionOf(m["result"]); session != "" {
				r.sessions[session] = pending.client
			}
		}
		if !r.clients[pending.client] {
			return nil
		}
		out := make(Message, len(m))
		for k, v := range m {
			out[k] = v
		}
		out["id"] = pending.theirs
		return []Delivery{{pending.client, out}}
	}
	var session, method string
	_ = json.Unmarshal(m["sessionId"], &session)
	_ = json.Unmarshal(m["method"], &method)
	if method == "Target.detachedFromTarget" {
		if s := sessionOf(m["params"]); s != "" {
			session = s
		}
		owner, found := r.sessions[session]
		delete(r.sessions, session)
		if !found || !r.clients[owner] {
			return nil
		}
		return []Delivery{{owner, m}}
	}
	if session != "" {
		owner, found := r.sessions[session]
		if !found || !r.clients[owner] {
			return nil
		}
		return []Delivery{{owner, m}}
	}
	all := make([]Delivery, 0, len(r.clients))
	for c := range r.clients {
		all = append(all, Delivery{c, m})
	}
	return all
}

// Sessions says how many sessions the router knows an owner for.
func (r *Router) Sessions() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.sessions)
}

func sessionOf(raw json.RawMessage) string {
	var holder struct {
		SessionID string `json:"sessionId"`
	}
	_ = json.Unmarshal(raw, &holder)
	return holder.SessionID
}

func rawInt(n int64) json.RawMessage {
	b, _ := json.Marshal(n)
	return b
}
