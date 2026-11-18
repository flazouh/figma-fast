package holder

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

var fakeApp string

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "fakeapp")
	if err != nil {
		panic(err)
	}
	fakeApp = filepath.Join(dir, "fakeapp")
	build := exec.Command("go", "build", "-o", fakeApp, "./internal/fakeapp")
	build.Stderr = os.Stderr
	if err := build.Run(); err != nil {
		panic(err)
	}
	code := m.Run()
	os.RemoveAll(dir)
	os.Exit(code)
}

type syncBuffer struct {
	mu sync.Mutex
	b  strings.Builder
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

func startHolder(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "holder")
	if err != nil {
		t.Fatal(err)
	}
	socket := filepath.Join(dir, "cdp.sock")
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	log := &syncBuffer{}
	go func() { done <- Run(ctx, Config{App: fakeApp, Socket: socket, Log: log}) }()
	t.Cleanup(func() {
		cancel()
		<-done
		os.RemoveAll(dir)
	})
	deadline := time.Now().Add(5 * time.Second)
	for !strings.Contains(log.String(), "listening") {
		select {
		case err := <-done:
			t.Fatalf("holder ended before it listened: %v", err)
		case <-time.After(5 * time.Millisecond):
		}
		if time.Now().After(deadline) {
			t.Fatal("holder did not listen within 5s")
		}
	}
	return socket
}

type client struct {
	t    *testing.T
	conn net.Conn
	in   chan map[string]any
}

func dial(t *testing.T, socket string) *client {
	t.Helper()
	conn, err := net.Dial("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	c := &client{t: t, conn: conn, in: make(chan map[string]any, 64)}
	go func() {
		defer close(c.in)
		reader := bufio.NewReader(conn)
		for {
			line, err := reader.ReadBytes('\n')
			if err != nil {
				return
			}
			var m map[string]any
			if json.Unmarshal(line, &m) == nil {
				c.in <- m
			}
		}
	}()
	t.Cleanup(func() { conn.Close() })
	return c
}

func (c *client) send(text string) {
	c.t.Helper()
	if _, err := io.WriteString(c.conn, text+"\n"); err != nil {
		c.t.Fatal(err)
	}
}

func (c *client) next() map[string]any {
	c.t.Helper()
	select {
	case m, ok := <-c.in:
		if !ok {
			c.t.Fatal("connection closed")
		}
		return m
	case <-time.After(5 * time.Second):
		c.t.Fatal("no message within 5s")
	}
	return nil
}

func (c *client) quiet(d time.Duration) {
	c.t.Helper()
	select {
	case m := <-c.in:
		c.t.Fatalf("unexpected message %v", m)
	case <-time.After(d):
	}
}

func TestHolderRoutesRepliesAndSessionEvents(t *testing.T) {
	socket := startHolder(t)
	a, b := dial(t, socket), dial(t, socket)

	a.send(`{"id":7,"method":"A.one","params":{}}`)
	b.send(`{"id":7,"method":"B.one","params":{}}`)
	ra, rb := a.next(), b.next()
	if ra["id"] != 7.0 || ra["result"].(map[string]any)["echo"] != "A.one" {
		t.Fatalf("a got %v", ra)
	}
	if rb["id"] != 7.0 || rb["result"].(map[string]any)["echo"] != "B.one" {
		t.Fatalf("b got %v", rb)
	}

	a.send(`{"id":8,"method":"Target.attachToTarget","params":{"targetId":"T1","flatten":true}}`)
	attached := a.next()
	session := attached["result"].(map[string]any)["sessionId"]
	if event := a.next(); event["sessionId"] != session || event["method"] != "Page.loadEventFired" {
		t.Fatalf("a got %v", event)
	}

	b.send(`{"id":9,"method":"Browser.ping","params":{}}`)
	if pong := b.next(); pong["id"] != 9.0 {
		t.Fatalf("b got %v", pong)
	}
	if ev := b.next(); ev["method"] != "Target.targetCreated" {
		t.Fatalf("b got %v", ev)
	}
	if ev := a.next(); ev["method"] != "Target.targetCreated" {
		t.Fatalf("a got %v", ev)
	}
	b.quiet(100 * time.Millisecond)
}

func TestNewClientDoesNotTakeOver(t *testing.T) {
	socket := startHolder(t)
	a := dial(t, socket)
	dial(t, socket)
	a.send(`{"id":1,"method":"Browser.getVersion","params":{}}`)
	if reply := a.next(); reply["id"] != 1.0 {
		t.Fatalf("a got %v", reply)
	}
}

func TestLeavingClientsSessionsAreDetached(t *testing.T) {
	socket := startHolder(t)
	a, b := dial(t, socket), dial(t, socket)
	a.send(`{"id":1,"method":"Target.attachToTarget","params":{"targetId":"T1","flatten":true}}`)
	session := a.next()["result"].(map[string]any)["sessionId"]
	a.next()
	a.conn.Close()
	ev := b.next()
	if ev["method"] != "Fake.detached" || ev["params"].(map[string]any)["sessionId"] != session {
		t.Fatalf("b got %v, want the app to see %v detached", ev, session)
	}
}

func TestManyClientsAtOnceEachGetTheirOwnReplies(t *testing.T) {
	socket := startHolder(t)
	var wg sync.WaitGroup
	errs := make(chan error, 16)
	for i := range 16 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			conn, err := net.Dial("unix", socket)
			if err != nil {
				errs <- err
				return
			}
			defer conn.Close()
			reader := bufio.NewReader(conn)
			for n := 1; n <= 50; n++ {
				method := fmt.Sprintf("C%d.call%d", i, n)
				fmt.Fprintf(conn, `{"id":%d,"method":%q}`+"\n", n, method)
				line, err := reader.ReadBytes('\n')
				if err != nil {
					errs <- err
					return
				}
				var m struct {
					ID     int `json:"id"`
					Result struct {
						Echo string `json:"echo"`
					} `json:"result"`
				}
				if err := json.Unmarshal(line, &m); err != nil {
					errs <- err
					return
				}
				if m.ID != n || m.Result.Echo != method {
					errs <- fmt.Errorf("client %d call %d got %s", i, n, line)
					return
				}
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Error(err)
	}
}

func TestRunEndsWhenTheAppClosesItsPipe(t *testing.T) {
	dir := t.TempDir()
	app := filepath.Join(dir, "app")
	if err := os.WriteFile(app, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- Run(context.Background(), Config{App: app, Socket: filepath.Join(dir, "s.sock")}) }()
	select {
	case err := <-done:
		if !errors.Is(err, ErrPipeClosed) {
			t.Fatalf("Run ended with %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not end when the app exited")
	}
}

func TestLaunchGivesTheAppOnlyKeptEnvironment(t *testing.T) {
	dir := t.TempDir()
	out := filepath.Join(dir, "env")
	app := filepath.Join(dir, "app")
	script := "#!/bin/sh\nenv > " + out + "\n"
	if err := os.WriteFile(app, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FIGMA_SECRET_TEST", "leak")
	cmd, toApp, fromApp, err := Launch(app)
	if err != nil {
		t.Fatal(err)
	}
	defer toApp.Close()
	defer fromApp.Close()
	if err := cmd.Wait(); err != nil {
		t.Fatal(err)
	}
	env, _ := os.ReadFile(out)
	if strings.Contains(string(env), "FIGMA_SECRET_TEST") {
		t.Fatalf("the app saw a variable outside the kept list:\n%s", env)
	}
	if !strings.Contains(string(env), "HOME=") {
		t.Fatalf("the app did not get HOME:\n%s", env)
	}
}
