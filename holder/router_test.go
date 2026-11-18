package holder

import (
	"encoding/json"
	"testing"
)

type sink struct{ name string }

func (*sink) Send(Message) {}

type appLog struct{ calls []Message }

func (a *appLog) write(m Message) { a.calls = append(a.calls, m) }

func msg(t *testing.T, text string) Message {
	t.Helper()
	var m Message
	if err := json.Unmarshal([]byte(text), &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func idOf(t *testing.T, m Message) int64 {
	t.Helper()
	var id int64
	if err := json.Unmarshal(m["id"], &id); err != nil {
		t.Fatalf("id %s: %v", m["id"], err)
	}
	return id
}

func reply(id int64, result string) Message {
	return Message{"id": rawInt(id), "result": json.RawMessage(result)}
}

func TestSameClientIDsGetDistinctHolderIDsAndComeBack(t *testing.T) {
	app := &appLog{}
	r := NewRouter(app.write)
	a, b := &sink{"a"}, &sink{"b"}
	r.Join(a)
	r.Join(b)
	r.FromClient(a, msg(t, `{"id":7,"method":"A.one","params":{"x":1}}`))
	r.FromClient(b, msg(t, `{"id":7,"method":"B.one"}`))
	if len(app.calls) != 2 {
		t.Fatalf("app got %d calls", len(app.calls))
	}
	ida, idb := idOf(t, app.calls[0]), idOf(t, app.calls[1])
	if ida == idb {
		t.Fatalf("both calls went out as id %d", ida)
	}
	if string(app.calls[0]["params"]) != `{"x":1}` {
		t.Fatalf("params changed: %s", app.calls[0]["params"])
	}
	got := r.FromApp(reply(idb, `{}`))
	if len(got) != 1 || got[0].Client != b || string(got[0].Message["id"]) != "7" {
		t.Fatalf("b's reply went to %+v", got)
	}
	got = r.FromApp(reply(ida, `{}`))
	if len(got) != 1 || got[0].Client != a || string(got[0].Message["id"]) != "7" {
		t.Fatalf("a's reply went to %+v", got)
	}
	if again := r.FromApp(reply(ida, `{}`)); len(again) != 0 {
		t.Fatalf("a reply was delivered twice: %+v", again)
	}
}

func TestClientIDIsGivenBackAsSent(t *testing.T) {
	app := &appLog{}
	r := NewRouter(app.write)
	a := &sink{"a"}
	r.Join(a)
	r.FromClient(a, msg(t, `{"id":"call-1","method":"X"}`))
	got := r.FromApp(reply(idOf(t, app.calls[0]), `{}`))
	if len(got) != 1 || string(got[0].Message["id"]) != `"call-1"` {
		t.Fatalf("got %+v", got)
	}
}

func TestMessageWithoutIDIsDropped(t *testing.T) {
	app := &appLog{}
	r := NewRouter(app.write)
	a := &sink{"a"}
	r.Join(a)
	r.FromClient(a, msg(t, `{"method":"X"}`))
	if len(app.calls) != 0 {
		t.Fatalf("app got %v", app.calls)
	}
}

func TestSessionEventsGoToTheSessionOwnerOnly(t *testing.T) {
	app := &appLog{}
	r := NewRouter(app.write)
	a, b := &sink{"a"}, &sink{"b"}
	r.Join(a)
	r.Join(b)
	r.FromClient(a, msg(t, `{"id":1,"method":"Target.attachToTarget","params":{"targetId":"T"}}`))
	r.FromApp(reply(idOf(t, app.calls[0]), `{"sessionId":"S1"}`))
	got := r.FromApp(msg(t, `{"method":"Page.loadEventFired","sessionId":"S1","params":{}}`))
	if len(got) != 1 || got[0].Client != a {
		t.Fatalf("session event went to %+v", got)
	}
	if got := r.FromApp(msg(t, `{"method":"Page.x","sessionId":"unknown","params":{}}`)); len(got) != 0 {
		t.Fatalf("unknown session event went to %+v", got)
	}
}

func TestSessionlessEventsGoToEveryClient(t *testing.T) {
	r := NewRouter(func(Message) {})
	a, b := &sink{"a"}, &sink{"b"}
	r.Join(a)
	r.Join(b)
	got := r.FromApp(msg(t, `{"method":"Target.targetCreated","params":{}}`))
	if len(got) != 2 {
		t.Fatalf("event went to %d clients", len(got))
	}
}

func TestDetachedFromTargetGoesToTheOwnerAndEndsTheSession(t *testing.T) {
	app := &appLog{}
	r := NewRouter(app.write)
	a, b := &sink{"a"}, &sink{"b"}
	r.Join(a)
	r.Join(b)
	r.FromClient(a, msg(t, `{"id":1,"method":"Target.attachToTarget","params":{"targetId":"T"}}`))
	r.FromApp(reply(idOf(t, app.calls[0]), `{"sessionId":"S1"}`))
	got := r.FromApp(msg(t, `{"method":"Target.detachedFromTarget","params":{"sessionId":"S1"}}`))
	if len(got) != 1 || got[0].Client != a {
		t.Fatalf("detached went to %+v", got)
	}
	if r.Sessions() != 0 {
		t.Fatalf("session S1 is still owned")
	}
}

func TestLeavingClientHasItsSessionsDetachedAndRepliesDropped(t *testing.T) {
	app := &appLog{}
	r := NewRouter(app.write)
	a, b := &sink{"a"}, &sink{"b"}
	r.Join(a)
	r.Join(b)
	r.FromClient(a, msg(t, `{"id":1,"method":"Target.attachToTarget","params":{"targetId":"T"}}`))
	r.FromApp(reply(idOf(t, app.calls[0]), `{"sessionId":"S1"}`))
	r.FromClient(a, msg(t, `{"id":2,"method":"Runtime.evaluate","sessionId":"S1"}`))
	pending := idOf(t, app.calls[1])
	r.Leave(a)
	if len(app.calls) != 3 {
		t.Fatalf("app got %d calls, want a detach", len(app.calls))
	}
	detach := app.calls[2]
	if string(detach["method"]) != `"Target.detachFromTarget"` || string(detach["params"]) != `{"sessionId":"S1"}` {
		t.Fatalf("leave sent %v", detach)
	}
	if got := r.FromApp(reply(pending, `{}`)); len(got) != 0 {
		t.Fatalf("a reply for a client that left went to %+v", got)
	}
	if got := r.FromApp(msg(t, `{"method":"Page.x","sessionId":"S1"}`)); len(got) != 0 {
		t.Fatalf("an event of a left client's session went to %+v", got)
	}
	if got := r.FromApp(msg(t, `{"method":"Target.targetCreated"}`)); len(got) != 1 || got[0].Client != b {
		t.Fatalf("a sessionless event went to %+v", got)
	}
}

func TestIDsStayBelowChromiumsLimit(t *testing.T) {
	app := &appLog{}
	r := NewRouter(app.write)
	a := &sink{"a"}
	r.Join(a)
	r.nextID = MaxID - 2
	for range 3 {
		r.FromClient(a, msg(t, `{"id":1,"method":"X"}`))
	}
	for _, call := range app.calls {
		if id := idOf(t, call); id < 1 || id >= MaxID {
			t.Fatalf("id %d is out of range", id)
		}
	}
	if idOf(t, app.calls[0]) != MaxID-1 || idOf(t, app.calls[1]) != 1 {
		t.Fatalf("ids did not wrap to 1: %v", app.calls)
	}
}
